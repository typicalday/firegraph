import type { Firestore } from 'firebase-admin/firestore';
import { computeEdgeDocId, computeNodeDocId } from './docid.js';
import { NODE_RELATION } from './internal/constants.js';
import type {
  StoredGraphRecord,
  FindEdgesParams,
  BulkOptions,
  BulkResult,
  BulkBatchError,
  CascadeResult,
  GraphReader,
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
  const edges = await reader.findEdges(params);
  const docIds = edges.map((e) => computeEdgeDocId(e.aUid, e.axbType, e.bUid));
  return bulkDeleteDocIds(db, collectionPath, docIds, options);
}

/**
 * Deletes a node and all of its outgoing and incoming edges.
 *
 * Edges are deleted first in chunked batches, then the node document
 * is deleted in the final batch. This is NOT atomic across batches —
 * if a batch fails after retries, remaining batches still execute.
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
  const [outgoingRaw, incomingRaw] = await Promise.all([
    reader.findEdges({ aUid: uid }),
    reader.findEdges({ bUid: uid }),
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

  // Build doc IDs: edges first, then the node last.
  const edgeDocIds = allEdges.map((e) => computeEdgeDocId(e.aUid, e.axbType, e.bUid));
  const nodeDocId = computeNodeDocId(uid);
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

  return {
    ...result,
    edgesDeleted: nodeDeleted ? result.deleted - 1 : result.deleted,
    nodeDeleted,
  };
}
