import type { Firestore } from '@google-cloud/firestore';

import { computeEdgeDocId, computeNodeDocId } from './docid.js';
import { NODE_RELATION } from './internal/constants.js';
import type {
  BulkBatchError,
  BulkOptions,
  BulkResult,
  CascadeResult,
  FindEdgesParams,
  GraphReader,
  StoredGraphRecord,
} from './types.js';

const MAX_BATCH_SIZE = 500;
const DEFAULT_MAX_RETRIES = 3;
const BASE_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Splits an array into chunks of at most `size` elements.
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Deletes a list of document IDs in chunked Firestore batches with retries.
 */
export async function bulkDeleteDocIds(
  db: Firestore,
  collectionPath: string,
  docIds: string[],
  options?: BulkOptions,
): Promise<BulkResult> {
  if (docIds.length === 0) {
    return { deleted: 0, batches: 0, errors: [] };
  }

  const batchSize = Math.min(options?.batchSize ?? MAX_BATCH_SIZE, MAX_BATCH_SIZE);
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const onProgress = options?.onProgress;

  const chunks = chunk(docIds, batchSize);
  const errors: BulkBatchError[] = [];
  let deleted = 0;
  let completedBatches = 0;

  for (let i = 0; i < chunks.length; i++) {
    const ids = chunks[i];
    let committed = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const batch = db.batch();
        const collectionRef = db.collection(collectionPath);
        for (const id of ids) {
          batch.delete(collectionRef.doc(id));
        }
        await batch.commit();
        committed = true;
        deleted += ids.length;
        break;
      } catch (err) {
        if (attempt < maxRetries) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          await sleep(delay);
        } else {
          errors.push({
            batchIndex: i,
            error: err instanceof Error ? err : new Error(String(err)),
            operationCount: ids.length,
          });
        }
      }
    }

    if (committed) {
      completedBatches++;
    }

    if (onProgress) {
      onProgress({
        completedBatches,
        totalBatches: chunks.length,
        deletedSoFar: deleted,
      });
    }
  }

  return { deleted, batches: completedBatches, errors };
}

/**
 * Finds all edges matching `params`, then deletes them in chunked batches.
 */
export async function bulkRemoveEdges(
  db: Firestore,
  collectionPath: string,
  reader: GraphReader,
  params: FindEdgesParams,
  options?: BulkOptions,
): Promise<BulkResult> {
  // Override default query limit for bulk deletion — we need all matching edges.
  // limit: 0 bypasses DEFAULT_QUERY_LIMIT; an explicit user limit is preserved.
  // allowCollectionScan: true — bulk deletion inherently implies scanning.
  const effectiveParams =
    params.limit !== undefined
      ? { ...params, allowCollectionScan: params.allowCollectionScan ?? true }
      : { ...params, limit: 0, allowCollectionScan: params.allowCollectionScan ?? true };
  const edges = await reader.findEdges(effectiveParams);
  const docIds = edges.map((e) => computeEdgeDocId(e.aUid, e.axbType, e.bUid));
  return bulkDeleteDocIds(db, collectionPath, docIds, options);
}

/** Result from recursive subcollection deletion. */
interface SubcollectionDeleteResult {
  deleted: number;
  errors: BulkBatchError[];
}

/**
 * Recursively delete all documents in all subcollections under a given document.
 * Uses `listCollections()` (Admin SDK) to discover subcollections, then for each
 * subcollection: recurse into each document's subcollections first (depth-first),
 * then bulk delete all documents in the subcollection.
 *
 * The `onProgress` callback is intentionally NOT forwarded to subcollection
 * deletes to avoid confusing callers with interleaved progress from different
 * collection depths.
 */
async function deleteSubcollectionsRecursive(
  db: Firestore,
  collectionPath: string,
  docId: string,
  options?: BulkOptions,
): Promise<SubcollectionDeleteResult> {
  const docRef = db.collection(collectionPath).doc(docId);
  const subcollections = await docRef.listCollections();

  if (subcollections.length === 0) return { deleted: 0, errors: [] };

  let totalDeleted = 0;
  const allErrors: BulkBatchError[] = [];

  // Strip onProgress for subcollection deletes — callers should only see
  // top-level progress, not interleaved reports from nested depths.
  const subOptions: BulkOptions | undefined = options
    ? { batchSize: options.batchSize, maxRetries: options.maxRetries }
    : undefined;

  for (const subCollRef of subcollections) {
    const subCollPath = subCollRef.path;
    // List all documents in this subcollection
    const snapshot = await subCollRef.select().get();
    const subDocIds = snapshot.docs.map((d) => d.id);

    // Depth-first: recurse into each document's subcollections
    for (const subDocId of subDocIds) {
      const subResult = await deleteSubcollectionsRecursive(db, subCollPath, subDocId, subOptions);
      totalDeleted += subResult.deleted;
      allErrors.push(...subResult.errors);
    }

    // Now delete all documents in this subcollection
    if (subDocIds.length > 0) {
      const result = await bulkDeleteDocIds(db, subCollPath, subDocIds, subOptions);
      totalDeleted += result.deleted;
      allErrors.push(...result.errors);
    }
  }

  return { deleted: totalDeleted, errors: allErrors };
}

/**
 * Deletes a node and all of its outgoing and incoming edges.
 *
 * Edges are deleted first in chunked batches, then the node document
 * is deleted in the final batch. This is NOT atomic across batches —
 * if a batch fails after retries, remaining batches still execute.
 *
 * By default, subcollections (subgraphs) under the node's document are
 * recursively deleted. Set `options.deleteSubcollections` to `false` to skip.
 */
export async function removeNodeCascade(
  db: Firestore,
  collectionPath: string,
  reader: GraphReader,
  uid: string,
  options?: BulkOptions,
): Promise<CascadeResult> {
  // Find all edges touching this node (outgoing + incoming).
  // Filter out the node's own self-loop record (axbType === 'is').
  // These queries intentionally scan broadly — allowCollectionScan bypasses safety checks.
  // limit: 0 bypasses the DEFAULT_QUERY_LIMIT to ensure we find all edges.
  const [outgoingRaw, incomingRaw] = await Promise.all([
    reader.findEdges({ aUid: uid, allowCollectionScan: true, limit: 0 }),
    reader.findEdges({ bUid: uid, allowCollectionScan: true, limit: 0 }),
  ]);
  const outgoing = outgoingRaw.filter((e) => e.axbType !== NODE_RELATION);
  const incoming = incomingRaw.filter((e) => e.axbType !== NODE_RELATION);

  // Deduplicate: a self-referencing edge could appear in both lists.
  const edgeDocIdSet = new Set<string>();
  const allEdges: StoredGraphRecord[] = [];
  for (const edge of [...outgoing, ...incoming]) {
    const docId = computeEdgeDocId(edge.aUid, edge.axbType, edge.bUid);
    if (!edgeDocIdSet.has(docId)) {
      edgeDocIdSet.add(docId);
      allEdges.push(edge);
    }
  }

  // Delete subcollections (subgraphs) under this node's document (depth-first).
  const shouldDeleteSubcollections = options?.deleteSubcollections !== false;
  const nodeDocId = computeNodeDocId(uid);
  let subcollectionResult: SubcollectionDeleteResult = { deleted: 0, errors: [] };

  if (shouldDeleteSubcollections) {
    subcollectionResult = await deleteSubcollectionsRecursive(
      db,
      collectionPath,
      nodeDocId,
      options,
    );
  }

  // Build doc IDs: edges first, then the node last.
  const edgeDocIds = allEdges.map((e) => computeEdgeDocId(e.aUid, e.axbType, e.bUid));
  const allDocIds = [...edgeDocIds, nodeDocId];

  // Wrap the progress callback to track overall progress.
  const batchSize = Math.min(options?.batchSize ?? MAX_BATCH_SIZE, MAX_BATCH_SIZE);
  const result = await bulkDeleteDocIds(db, collectionPath, allDocIds, {
    ...options,
    batchSize,
  });

  // Determine if the node doc was in a failed batch.
  // The node is always in the last doc ID. If the last batch errored, node wasn't deleted.
  const totalChunks = Math.ceil(allDocIds.length / batchSize);
  const nodeChunkIndex = totalChunks - 1;
  const nodeDeleted = !result.errors.some((e) => e.batchIndex === nodeChunkIndex);

  // edgesDeleted counts only top-level edges (not subcollection docs).
  // deleted includes everything: top-level edges + node + subcollection docs.
  const topLevelEdgesDeleted = nodeDeleted ? result.deleted - 1 : result.deleted;

  return {
    deleted: result.deleted + subcollectionResult.deleted,
    batches: result.batches,
    errors: [...result.errors, ...subcollectionResult.errors],
    edgesDeleted: topLevelEdgesDeleted,
    nodeDeleted,
  };
}
