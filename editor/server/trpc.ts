import { initTRPC, TRPCError } from '@trpc/server';
import type { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import type { Firestore, DocumentData, Query } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import type { GraphClient, GraphRegistry } from '../../src/types.js';
import { generateId, ValidationError, RegistryViolationError, computeEdgeDocId } from '../../src/index.js';
import type { SchemaMetadata } from './schema-introspect.js';
import type { ViewRegistry } from '../../src/views.js';
import type { ViewBundle } from './views-bundler.js';
import type { LoadedConfig } from './config-loader.js';
import type { SchemaViewWarning } from './schema-views-validator.js';
import { z } from 'zod';

// --- Context ---

export interface TRPCContext {
  db: Firestore;
  collection: string;
  registry: GraphRegistry;
  schemaMetadata: SchemaMetadata;
  graphClient: GraphClient;
  viewRegistry: ViewRegistry | null;
  viewBundle: ViewBundle | null;
  readonly: boolean;
  projectId: string | undefined;
  viewDefaults: LoadedConfig['viewDefaults'] | null;
  schemaViewWarnings: SchemaViewWarning[];
  chatEnabled: boolean;
  chatModel: string;
}

export function createContext(deps: TRPCContext) {
  return (_opts: CreateExpressContextOptions) => deps;
}

// --- tRPC init ---

const t = initTRPC.context<TRPCContext>().create();

const publicProcedure = t.procedure;

const writeProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (ctx.readonly) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Editor is in read-only mode.',
    });
  }
  return next();
});

// --- Helpers ---

const NODE_RELATION = 'is';

function serializeRecord(doc: DocumentData): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (value instanceof Timestamp) {
      result[key] = value.toDate().toISOString();
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = serializeRecord(value as DocumentData);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// --- UID helpers ---

/**
 * Strip an optional "type:" prefix from a UID.
 * Traverse results and summarizeEdge format endpoints as "type:uid"
 * (e.g. "job:abc123"), but Firestore document IDs for nodes are just
 * the raw UID.  This lets callers pass either form.
 *
 * Heuristic: only strip when the part before the first colon looks
 * like a short alphabetic type name (letters only, ≤30 chars).
 * This avoids mangling UIDs that legitimately contain colons.
 */
function stripTypePrefix(raw: string): string {
  const idx = raw.indexOf(':');
  if (idx < 1) return raw;
  const prefix = raw.slice(0, idx);
  if (prefix.length <= 30 && /^[a-zA-Z]+$/.test(prefix)) {
    return raw.slice(idx + 1);
  }
  return raw;
}

// --- Router ---

export const appRouter = t.router({
  // --- Config ---
  getConfig: publicProcedure.query(({ ctx }) => ({
    projectId: ctx.projectId || '(auto-detected)',
    collection: ctx.collection,
    readonly: ctx.readonly,
    viewDefaults: ctx.viewDefaults ?? null,
    chatEnabled: ctx.chatEnabled,
    chatModel: ctx.chatModel,
  })),

  // --- Schema ---
  getSchema: publicProcedure.query(({ ctx }) => {
    const nodeTypes = ctx.schemaMetadata.nodeTypes.map((n) => ({
      type: n.aType,
      description: n.description,
    }));
    const edgeTypes = ctx.schemaMetadata.edgeTypes.map((e) => ({
      aType: e.aType,
      axbType: e.axbType,
      bType: e.bType,
      description: e.description,
      inverseLabel: e.inverseLabel,
    }));
    return {
      nodeTypes,
      edgeTypes,
      readonly: ctx.readonly,
      nodeSchemas: ctx.schemaMetadata.nodeTypes,
      edgeSchemas: ctx.schemaMetadata.edgeTypes,
    };
  }),

  // --- Views ---
  getViews: publicProcedure.query(({ ctx }) => {
    if (!ctx.viewRegistry) {
      return { nodes: {} as Record<string, unknown>, edges: {} as Record<string, unknown>, hasViews: false as const };
    }
    return { ...ctx.viewRegistry, hasViews: true as const };
  }),

  // --- Warnings ---
  getWarnings: publicProcedure.query(({ ctx }) => ({
    warnings: ctx.schemaViewWarnings,
  })),

  // --- Browse Nodes ---
  getNodes: publicProcedure
    .input(z.object({
      type: z.string().optional(),
      limit: z.number().min(1).max(200).default(25),
      startAfter: z.string().optional(),
      sortBy: z.string().default('aUid'),
      sortDir: z.enum(['asc', 'desc']).default('asc'),
      // Legacy single filter (kept for backwards compat)
      filterField: z.string().optional(),
      filterOp: z.string().optional(),
      filterValue: z.string().optional(),
      // Multi-filter support
      where: z.array(z.object({
        field: z.string(),
        op: z.string(),
        value: z.union([z.string(), z.number(), z.boolean()]),
      })).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const col = ctx.db.collection(ctx.collection);
      const builtinSortFields = ['aUid', 'createdAt', 'updatedAt'];

      // Allow sorting by data fields (prefix with data. if needed)
      let effectiveSortBy: string;
      if (builtinSortFields.includes(input.sortBy)) {
        effectiveSortBy = input.sortBy;
      } else {
        effectiveSortBy = input.sortBy.startsWith('data.') ? input.sortBy : `data.${input.sortBy}`;
      }

      let query: Query = col.where('axbType', '==', NODE_RELATION);

      if (input.type) {
        query = query.where('aType', '==', input.type);
      }

      const allowedOps = ['==', '!=', '<', '<=', '>', '>='] as const;
      type AllowedOp = (typeof allowedOps)[number];

      // Apply multi-filter where clauses
      if (input.where && input.where.length > 0) {
        for (const clause of input.where) {
          if (!allowedOps.includes(clause.op as AllowedOp)) continue;
          const field = clause.field.startsWith('data.') ? clause.field : `data.${clause.field}`;
          query = query.where(field, clause.op as AllowedOp, clause.value);
        }
      }

      // Legacy single filter fallback
      if (!input.where?.length && input.filterField && input.filterOp && input.filterValue !== undefined) {
        if (allowedOps.includes(input.filterOp as AllowedOp)) {
          const field = input.filterField.startsWith('data.') ? input.filterField : `data.${input.filterField}`;
          let coercedValue: string | number = input.filterValue;
          if (['<', '<=', '>', '>='].includes(input.filterOp)) {
            const num = Number(input.filterValue);
            if (!isNaN(num)) coercedValue = num;
          }
          query = query.where(field, input.filterOp as AllowedOp, coercedValue);
        }
      }

      query = query.orderBy(effectiveSortBy, input.sortDir).limit(input.limit + 1);

      if (input.startAfter) {
        query = query.startAfter(input.startAfter);
      }

      const snapshot = await query.get();
      const docs = snapshot.docs.slice(0, input.limit);
      const hasMore = snapshot.docs.length > input.limit;

      const nodes = docs.map((doc) => serializeRecord(doc.data()));

      let nextCursor: string | null = null;
      if (hasMore && docs.length > 0) {
        const lastDoc = docs[docs.length - 1].data();
        const cursorValue = lastDoc[effectiveSortBy];
        nextCursor = cursorValue instanceof Timestamp ? cursorValue.toDate().toISOString() : String(cursorValue);
      }

      return { nodes, hasMore, nextCursor };
    }),

  // --- Get Single Node ---
  getNodeDetail: publicProcedure
    .input(z.object({ uid: z.string() }))
    .query(async ({ ctx, input }) => {
      const col = ctx.db.collection(ctx.collection);
      const edgeLimit = 50;

      // Strip optional "type:" prefix (e.g. "job:abc123" → "abc123").
      // Traverse results format endpoints as "type:uid", so callers
      // may pass the qualified form directly.
      const uid = stripTypePrefix(input.uid);

      const nodeDoc = await col.doc(uid).get();
      const node = nodeDoc.exists ? serializeRecord(nodeDoc.data()!) : null;

      const outSnapshot = await col.where('aUid', '==', uid).limit(edgeLimit + 1).get();
      const outEdges = outSnapshot.docs
        .map((doc) => serializeRecord(doc.data()))
        .filter((e) => e.axbType !== NODE_RELATION);

      const inSnapshot = await col.where('bUid', '==', uid).limit(edgeLimit + 1).get();
      const inEdges = inSnapshot.docs
        .map((doc) => serializeRecord(doc.data()))
        .filter((e) => e.axbType !== NODE_RELATION);

      return { node, outEdges, inEdges };
    }),

  // --- Batch Get Nodes ---
  getNodesBatch: publicProcedure
    .input(z.object({ uids: z.array(z.string()).min(1).max(100) }))
    .query(async ({ ctx, input }) => {
      const col = ctx.db.collection(ctx.collection);
      const cleanUids = input.uids.map(stripTypePrefix);
      const refs = cleanUids.map((uid) => col.doc(uid));
      const snapshots = await ctx.db.getAll(...refs);

      const nodes: Record<string, Record<string, unknown> | null> = {};
      for (const snap of snapshots) {
        nodes[snap.id] = snap.exists ? serializeRecord(snap.data()!) : null;
      }

      return { nodes };
    }),

  // --- Query Edges ---
  getEdges: publicProcedure
    .input(z.object({
      aType: z.string().optional(),
      aUid: z.string().optional(),
      axbType: z.string().optional(),
      bType: z.string().optional(),
      bUid: z.string().optional(),
      limit: z.number().min(1).max(200).default(25),
      startAfter: z.string().optional(),
      sortBy: z.string().optional(),
      sortDir: z.enum(['asc', 'desc']).default('asc'),
      where: z.array(z.object({
        field: z.string(),
        op: z.string(),
        value: z.union([z.string(), z.number(), z.boolean()]),
      })).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const col = ctx.db.collection(ctx.collection);
      let query: Query = col;

      if (input.aType) query = query.where('aType', '==', input.aType);
      if (input.aUid) query = query.where('aUid', '==', input.aUid);
      if (input.axbType) query = query.where('axbType', '==', input.axbType);
      if (input.bType) query = query.where('bType', '==', input.bType);
      if (input.bUid) query = query.where('bUid', '==', input.bUid);

      if (!input.axbType) {
        query = query.where('axbType', '!=', NODE_RELATION);
      }

      const allowedOps = ['==', '!=', '<', '<=', '>', '>='] as const;
      type AllowedOp = (typeof allowedOps)[number];
      const builtinFields = ['aUid', 'bUid', 'aType', 'bType', 'axbType', 'createdAt', 'updatedAt'];

      if (input.where && input.where.length > 0) {
        for (const clause of input.where) {
          if (!allowedOps.includes(clause.op as AllowedOp)) continue;
          const field = builtinFields.includes(clause.field) ? clause.field
            : clause.field.startsWith('data.') ? clause.field : `data.${clause.field}`;
          query = query.where(field, clause.op as AllowedOp, clause.value);
        }
      }

      const builtinSortFields = builtinFields;
      let effectiveSortBy: string;
      if (!input.sortBy) {
        effectiveSortBy = 'axbType';
      } else if (builtinSortFields.includes(input.sortBy)) {
        effectiveSortBy = input.sortBy;
      } else {
        effectiveSortBy = input.sortBy.startsWith('data.') ? input.sortBy : `data.${input.sortBy}`;
      }

      query = query.orderBy(effectiveSortBy, input.sortDir).limit(input.limit + 1);

      if (input.startAfter) {
        query = query.startAfter(input.startAfter);
      }

      const snapshot = await query.get();
      const docs = snapshot.docs.slice(0, input.limit);
      const hasMore = snapshot.docs.length > input.limit;

      const edges = docs.map((doc) => serializeRecord(doc.data()));

      let nextCursor: string | null = null;
      if (hasMore && docs.length > 0) {
        const lastDoc = docs[docs.length - 1].data();
        const cursorValue = effectiveSortBy.startsWith('data.')
          ? effectiveSortBy.split('.').reduce<unknown>((obj, key) => (obj as Record<string, unknown>)?.[key], lastDoc)
          : lastDoc[effectiveSortBy];
        nextCursor = cursorValue instanceof Timestamp ? cursorValue.toDate().toISOString() : String(cursorValue);
      }

      return { edges, hasMore, nextCursor };
    }),

  // --- Traversal ---
  traverse: publicProcedure
    .input(z.object({
      startUid: z.string().min(1),
      hops: z.array(z.object({
        axbType: z.string(),
        direction: z.enum(['forward', 'reverse']).default('forward'),
        limit: z.number().default(10),
        aType: z.string().optional(),
        bType: z.string().optional(),
        orderBy: z.object({
          field: z.string(),
          direction: z.enum(['asc', 'desc']).default('asc'),
        }).optional(),
        where: z.array(z.object({
          field: z.string(),
          op: z.string(),
          value: z.union([z.string(), z.number(), z.boolean()]),
        })).optional(),
      })).min(1),
      maxReads: z.number().default(100),
      concurrency: z.number().default(5),
    }))
    .mutation(async ({ ctx, input }) => {
      const col = ctx.db.collection(ctx.collection);
      let totalReads = 0;
      let truncated = false;
      let sourceUids = [input.startUid];

      interface HopResultData {
        axbType: string;
        direction: string;
        depth: number;
        edges: Record<string, unknown>[];
        sourceCount: number;
        truncated: boolean;
      }

      const hopResults: HopResultData[] = [];

      for (let depth = 0; depth < input.hops.length; depth++) {
        const hop = input.hops[depth];
        const direction = hop.direction;
        const hopLimit = hop.limit;

        if (sourceUids.length === 0 || truncated) {
          hopResults.push({
            axbType: hop.axbType, direction, depth,
            edges: [], sourceCount: 0, truncated,
          });
          continue;
        }

        const hopEdges: Record<string, unknown>[] = [];
        const sourceCount = sourceUids.length;
        let hopTruncated = false;

        const batchSize = Math.max(1, Math.min(20, input.concurrency));
        for (let i = 0; i < sourceUids.length; i += batchSize) {
          if (totalReads >= input.maxReads) {
            hopTruncated = true;
            break;
          }

          const batch = sourceUids.slice(i, i + batchSize);
          const promises = batch.map(async (uid) => {
            if (totalReads >= input.maxReads) return [];
            totalReads++;

            let query: Query = col.where('axbType', '==', hop.axbType);

            if (direction === 'forward') {
              query = query.where('aUid', '==', uid);
              if (hop.bType) query = query.where('bType', '==', hop.bType);
            } else {
              query = query.where('bUid', '==', uid);
              if (hop.aType) query = query.where('aType', '==', hop.aType);
            }

            const allowedOps = ['==', '!=', '<', '<=', '>', '>='];
            if (hop.where && hop.where.length > 0) {
              for (const clause of hop.where) {
                if (!allowedOps.includes(clause.op)) continue;
                const field = clause.field.startsWith('data.') ? clause.field : `data.${clause.field}`;
                query = query.where(field, clause.op as FirebaseFirestore.WhereFilterOp, clause.value);
              }
            }

            if (hop.orderBy) {
              const orderField = hop.orderBy.field.startsWith('data.')
                ? hop.orderBy.field
                : `data.${hop.orderBy.field}`;
              query = query.orderBy(orderField, hop.orderBy.direction);
            }

            query = query.limit(hopLimit);
            const snapshot = await query.get();
            return snapshot.docs.map((doc) => serializeRecord(doc.data()));
          });

          const results = await Promise.all(promises);
          for (const edges of results) {
            hopEdges.push(...edges);
          }
        }

        hopResults.push({
          axbType: hop.axbType, direction, depth,
          edges: hopEdges, sourceCount, truncated: hopTruncated,
        });

        if (hopTruncated) truncated = true;

        const nextUids = new Set<string>();
        for (const edge of hopEdges) {
          nextUids.add((direction === 'forward' ? edge.bUid : edge.aUid) as string);
        }
        sourceUids = [...nextUids];
      }

      const lastHop = hopResults[hopResults.length - 1];
      return {
        nodes: lastHop?.edges ?? [],
        hops: hopResults,
        totalReads,
        truncated,
      };
    }),

  // --- Search ---
  search: publicProcedure
    .input(z.object({
      q: z.string(),
      limit: z.number().min(1).max(50).default(20),
    }))
    .query(async ({ ctx, input }) => {
      const q = input.q.trim();
      if (!q) return { results: [] as Record<string, unknown>[] };

      const col = ctx.db.collection(ctx.collection);
      const strippedQ = stripTypePrefix(q);
      const nodeDoc = await col.doc(strippedQ).get();
      const results: Record<string, unknown>[] = [];

      if (nodeDoc.exists) {
        results.push({ ...serializeRecord(nodeDoc.data()!), _matchType: 'exact' });
      }

      const aUidSnapshot = await col.where('aUid', '==', strippedQ).limit(input.limit).get();
      for (const doc of aUidSnapshot.docs) {
        const record = serializeRecord(doc.data());
        if (!results.some((r) => r.aUid === record.aUid && r.axbType === record.axbType && r.bUid === record.bUid)) {
          results.push({ ...record, _matchType: 'aUid' });
        }
      }

      const bUidSnapshot = await col.where('bUid', '==', strippedQ).limit(input.limit).get();
      for (const doc of bUidSnapshot.docs) {
        const record = serializeRecord(doc.data());
        if (!results.some((r) => r.aUid === record.aUid && r.axbType === record.axbType && r.bUid === record.bUid)) {
          results.push({ ...record, _matchType: 'bUid' });
        }
      }

      return { results: results.slice(0, input.limit) };
    }),

  // --- Check Node Exists ---
  checkNode: publicProcedure
    .input(z.object({ uid: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const doc = await ctx.db.collection(ctx.collection).doc(stripTypePrefix(input.uid)).get();
      if (!doc.exists) return { exists: false as const, node: null };
      const data = serializeRecord(doc.data()!);
      return {
        exists: true as const,
        node: { aType: data.aType as string, aUid: data.aUid as string },
      };
    }),

  // --- Check Edge Exists ---
  checkEdge: publicProcedure
    .input(z.object({
      aUid: z.string().min(1),
      axbType: z.string().min(1),
      bUid: z.string().min(1),
    }))
    .query(async ({ ctx, input }) => {
      const docId = computeEdgeDocId(input.aUid, input.axbType, input.bUid);
      const doc = await ctx.db.collection(ctx.collection).doc(docId).get();
      return { exists: doc.exists };
    }),

  // --- Write: Create Node ---
  createNode: writeProcedure
    .input(z.object({
      aType: z.string(),
      uid: z.string().optional(),
      data: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const nodeUid = input.uid || generateId();
        await ctx.graphClient.putNode(input.aType, nodeUid, input.data);
        return { success: true as const, uid: nodeUid };
      } catch (err) {
        if (err instanceof ValidationError || err instanceof RegistryViolationError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
        }
        throw err;
      }
    }),

  // --- Write: Update Node ---
  updateNode: writeProcedure
    .input(z.object({
      uid: z.string(),
      data: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const existing = await ctx.graphClient.getNode(input.uid);
        if (!existing) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Node not found' });
        }
        await ctx.graphClient.putNode(existing.aType, input.uid, input.data);
        return { success: true as const };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        if (err instanceof ValidationError || err instanceof RegistryViolationError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
        }
        throw err;
      }
    }),

  // --- Write: Delete Node ---
  deleteNode: writeProcedure
    .input(z.object({ uid: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.graphClient.removeNode(input.uid);
      return { success: true as const };
    }),

  // --- Write: Delete Node + Cascade (all edges) ---
  deleteNodeCascade: writeProcedure
    .input(z.object({ uid: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.graphClient.removeNodeCascade(input.uid);
      return {
        success: result.nodeDeleted,
        edgesDeleted: result.edgesDeleted,
        batches: result.batches,
        errors: result.errors.map((e) => ({
          batchIndex: e.batchIndex,
          message: e.error.message,
          operationCount: e.operationCount,
        })),
      };
    }),

  // --- Write: Create Edge ---
  createEdge: writeProcedure
    .input(z.object({
      aType: z.string(),
      aUid: z.string(),
      axbType: z.string(),
      bType: z.string(),
      bUid: z.string(),
      data: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        await ctx.graphClient.putEdge(
          input.aType, input.aUid, input.axbType,
          input.bType, input.bUid, input.data || {},
        );
        return { success: true as const };
      } catch (err) {
        if (err instanceof ValidationError || err instanceof RegistryViolationError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
        }
        throw err;
      }
    }),

  // --- Write: Create Edge + Target Node atomically ---
  createEdgeWithNode: writeProcedure
    .input(z.object({
      aType: z.string(),
      axbType: z.string(),
      bType: z.string(),
      /** Which side is the new node: 'b' (outgoing) or 'a' (incoming) */
      newNodeSide: z.enum(['a', 'b']).default('b'),
      /** The UID of the existing node (the "fixed" side) */
      existingUid: z.string(),
      /** Optional UID for the new node (auto-generated if omitted) */
      newNodeUid: z.string().optional(),
      edgeData: z.record(z.string(), z.unknown()),
      nodeData: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const newUid = input.newNodeUid || generateId();
        const newNodeType = input.newNodeSide === 'b' ? input.bType : input.aType;
        const aUid = input.newNodeSide === 'a' ? newUid : input.existingUid;
        const bUid = input.newNodeSide === 'b' ? newUid : input.existingUid;

        // Pre-check: does the node and/or edge already exist?
        const [existingNode, existingEdge] = await Promise.all([
          ctx.graphClient.getNode(newUid),
          ctx.graphClient.getEdge(aUid, input.axbType, bUid),
        ]);

        if (existingNode && existingEdge) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Both node "${newUid}" and edge ${aUid} —[${input.axbType}]→ ${bUid} already exist.`,
          });
        }

        await ctx.graphClient.runTransaction(async (tx) => {
          if (!existingNode) {
            await tx.putNode(newNodeType, newUid, input.nodeData);
          }
          // putEdge is an upsert — if edge exists, it updates updatedAt + data
          await tx.putEdge(
            input.aType, aUid, input.axbType,
            input.bType, bUid, input.edgeData,
          );
        });
        return { success: true as const, uid: newUid, edgeUpdated: !!existingEdge };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        if (err instanceof ValidationError || err instanceof RegistryViolationError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
        }
        throw err;
      }
    }),

  // --- Write: Delete Edge ---
  deleteEdge: writeProcedure
    .input(z.object({
      aUid: z.string(),
      axbType: z.string(),
      bUid: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      await ctx.graphClient.removeEdge(input.aUid, input.axbType, input.bUid);
      return { success: true as const };
    }),

  // --- Write: Bulk Delete Edges (by query) ---
  bulkDeleteEdges: writeProcedure
    .input(z.object({
      aUid: z.string().optional(),
      axbType: z.string().optional(),
      bUid: z.string().optional(),
      aType: z.string().optional(),
      bType: z.string().optional(),
      where: z.array(z.object({
        field: z.string(),
        op: z.string(),
        value: z.union([z.string(), z.number(), z.boolean()]),
      })).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { where: whereClauses, ...params } = input;
      const findParams: Record<string, unknown> = { ...params };
      if (whereClauses && whereClauses.length > 0) {
        findParams.where = whereClauses;
      }
      const result = await ctx.graphClient.bulkRemoveEdges(findParams as any);
      return {
        success: true as const,
        deleted: result.deleted,
        batches: result.batches,
        errors: result.errors.map((e) => ({
          batchIndex: e.batchIndex,
          message: e.error.message,
          operationCount: e.operationCount,
        })),
      };
    }),

  // --- Write: Delete specific edges by ID ---
  deleteEdgesBatch: writeProcedure
    .input(z.object({
      edges: z.array(z.object({
        aUid: z.string(),
        axbType: z.string(),
        bUid: z.string(),
      })).min(1).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      const batch = ctx.graphClient.batch();
      for (const e of input.edges) {
        await batch.removeEdge(e.aUid, e.axbType, e.bUid);
      }
      await batch.commit();
      return { success: true as const, deleted: input.edges.length };
    }),
});

export type AppRouter = typeof appRouter;
