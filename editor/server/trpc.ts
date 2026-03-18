import { initTRPC, TRPCError } from '@trpc/server';
import type { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import { Timestamp, FieldPath } from '@google-cloud/firestore';
import type { Firestore, DocumentData, Query, WhereFilterOp } from '@google-cloud/firestore';
import type { GraphClient, GraphRegistry } from '../../src/types.js';
import { generateId, ValidationError, RegistryViolationError, computeEdgeDocId } from '../../src/index.js';
import type { SchemaMetadata } from './schema-introspect.js';
import type { ViewRegistry, EntityViewMeta } from '../../src/views.js';
import type { ViewBundle } from './views-bundler.js';
import type { LoadedConfig } from './config-loader.js';
import type { SchemaViewWarning } from './schema-views-validator.js';
import type { DynamicTypeMetadata } from './dynamic-loader.js';
import type { ReloadResult } from './index.js';
import type { DiscoveredCollection } from './collections-loader.js';
import { z } from 'zod';

// --- Context ---

/** Static deps set once at startup. */
export interface StaticDeps {
  db: Firestore;
  collection: string;
  readonly: boolean;
  projectId: string | undefined;
  viewDefaults: LoadedConfig['viewDefaults'] | null;
  chatEnabled: boolean;
  chatModel: string;
  collectionDefs: DiscoveredCollection[];
  collectionViewRegistry: Record<string, EntityViewMeta>;
}

/** Mutable state that changes on dynamic schema reload. */
export interface MutableState {
  registry: GraphRegistry;
  schemaMetadata: SchemaMetadata;
  graphClient: GraphClient;
  viewRegistry: ViewRegistry | null;
  viewBundle: ViewBundle | null;
  schemaViewWarnings: SchemaViewWarning[];
  dynamicTypeMeta: DynamicTypeMetadata | null;
  dynamicViewsCode: string | null;
}

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
  dynamicTypeMeta: DynamicTypeMetadata | null;
  reloadFn: (() => Promise<ReloadResult>) | null;
  collectionDefs: DiscoveredCollection[];
  collectionViewRegistry: Record<string, EntityViewMeta>;
}

/**
 * Context factory — reads mutable `state` per-request so each tRPC
 * call sees the latest schema after a dynamic reload.
 */
export function createContext(
  staticDeps: StaticDeps,
  state: MutableState,
  reloadFn?: () => Promise<ReloadResult>,
) {
  return (_opts: CreateExpressContextOptions): TRPCContext => ({
    ...staticDeps,
    registry: state.registry,
    schemaMetadata: state.schemaMetadata,
    graphClient: state.graphClient,
    viewRegistry: state.viewRegistry,
    viewBundle: state.viewBundle,
    schemaViewWarnings: state.schemaViewWarnings,
    dynamicTypeMeta: state.dynamicTypeMeta,
    reloadFn: reloadFn ?? null,
  });
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

function serializeValue(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === 'object') return serializeRecord(value as DocumentData);
  return value;
}

function serializeRecord(doc: DocumentData): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    result[key] = serializeValue(value);
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

// --- Scope helpers ---

/**
 * Resolve a Firestore collection path for a given scope.
 * scope format: "parentUid/subgraphName" or "uid1/name1/uid2/name2/..."
 * Returns the root collection when scope is absent/empty.
 */
function resolveCollectionPath(rootCollection: string, scope?: string): string {
  if (!scope) return rootCollection;
  const segments = scope.split('/');
  if (segments.length % 2 !== 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Invalid scope path: "${scope}". Must be pairs of parentUid/subgraphName.`,
    });
  }
  return `${rootCollection}/${scope}`;
}

/**
 * Create a scoped GraphClient by chaining subgraph() calls.
 * Scope segments must come in pairs: parentUid/subgraphName.
 */
function getScopedClient(rootClient: GraphClient, scope?: string): GraphClient {
  if (!scope) return rootClient;
  const segments = scope.split('/');
  if (segments.length % 2 !== 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Invalid scope path: "${scope}". Must be pairs of parentUid/subgraphName.`,
    });
  }
  let client: GraphClient = rootClient;
  for (let i = 0; i < segments.length; i += 2) {
    client = client.subgraph(segments[i], segments[i + 1]);
  }
  return client;
}

const scopeSchema = z.string().optional();

// --- Plain collection helpers ---

/**
 * Substitute {paramName} tokens in a collection path template.
 * e.g. "graph/{nodeUid}/logs" + {nodeUid: "abc"} → "graph/abc/logs"
 * Exported for unit testing.
 */
export function substitutePathTemplate(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{([^}]+)\}/g, (_, key) => {
    if (!(key in params)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `Missing required path parameter: "${key}"` });
    }
    const val = params[key];
    if (!val) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `Path parameter "${key}" must not be empty` });
    }
    if (val.includes('/')) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `Path parameter "${key}" must not contain "/"` });
    }
    return val;
  });
}

function getCollectionDef(ctx: TRPCContext, name: string): DiscoveredCollection {
  const def = ctx.collectionDefs.find((c) => c.name === name);
  if (!def) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Collection "${name}" not found.` });
  }
  return def;
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
      titleField: n.titleField,
      subtitleField: n.subtitleField,
      isDynamic: n.isDynamic,
    }));
    const edgeTypes = ctx.schemaMetadata.edgeTypes.map((e) => ({
      aType: e.aType,
      axbType: e.axbType,
      bType: e.bType,
      description: e.description,
      inverseLabel: e.inverseLabel,
      titleField: e.titleField,
      subtitleField: e.subtitleField,
      isDynamic: e.isDynamic,
      targetGraph: e.targetGraph,
    }));
    return {
      nodeTypes,
      edgeTypes,
      readonly: ctx.readonly,
      nodeSchemas: ctx.schemaMetadata.nodeTypes,
      edgeSchemas: ctx.schemaMetadata.edgeTypes,
      dynamicMode: ctx.reloadFn !== null,
      collections: ctx.collectionDefs.map((c) => ({
        name: c.name,
        path: c.path,
        description: c.description,
        typeField: c.typeField,
        typeValue: c.typeValue,
        parentNodeType: c.parentNodeType,
        fields: c.fields,
        hasSchema: c.hasSchema,
        pathParams: c.pathParams,
        defaultOrderBy: c.defaultOrderBy,
      })),
    };
  }),

  // --- Views ---
  getViews: publicProcedure.query(({ ctx }) => {
    // Start from filesystem view registry (or empty)
    const nodes: Record<string, unknown> = ctx.viewRegistry?.nodes ? { ...ctx.viewRegistry.nodes } : {};
    const edges: Record<string, unknown> = ctx.viewRegistry?.edges ? { ...ctx.viewRegistry.edges } : {};
    const collections: Record<string, unknown> = { ...ctx.collectionViewRegistry };

    // Merge dynamic template views (for types that have viewTemplate)
    if (ctx.dynamicTypeMeta) {
      for (const [name, meta] of Object.entries(ctx.dynamicTypeMeta.nodes)) {
        if (!meta.viewTemplate) continue;
        const tagName = `fg-${name.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').toLowerCase()}-template`;
        const existing = nodes[name] as { views: unknown[] } | undefined;
        const templateView = { tagName, viewName: 'template', description: 'Dynamic template view' };
        if (existing) {
          existing.views = [...existing.views, templateView];
        } else {
          nodes[name] = { views: [templateView] };
        }
      }
      for (const [name, meta] of Object.entries(ctx.dynamicTypeMeta.edges)) {
        if (!meta.viewTemplate) continue;
        const tagName = `fg-edge-${name.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').toLowerCase()}-template`;
        const existing = edges[name] as { views: unknown[] } | undefined;
        const templateView = { tagName, viewName: 'template', description: 'Dynamic template view' };
        if (existing) {
          existing.views = [...existing.views, templateView];
        } else {
          edges[name] = { views: [templateView] };
        }
      }
    }

    const hasViews = Object.keys(nodes).length > 0 || Object.keys(edges).length > 0 || Object.keys(collections).length > 0;
    return { nodes, edges, collections, hasViews };
  }),

  // --- Reload Schema (dynamic registry) ---
  reloadSchema: writeProcedure.mutation(async ({ ctx }) => {
    if (!ctx.reloadFn) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Dynamic registry mode is not enabled. Add registryMode to your config or use --registry-mode=dynamic.',
      });
    }
    const result = await ctx.reloadFn();
    return result;
  }),

  // --- Warnings ---
  getWarnings: publicProcedure.query(({ ctx }) => ({
    warnings: ctx.schemaViewWarnings,
  })),

  // --- Browse Nodes ---
  getNodes: publicProcedure
    .input(z.object({
      scope: scopeSchema,
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
      const col = ctx.db.collection(resolveCollectionPath(ctx.collection, input.scope));
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
    .input(z.object({ scope: scopeSchema, uid: z.string() }))
    .query(async ({ ctx, input }) => {
      const col = ctx.db.collection(resolveCollectionPath(ctx.collection, input.scope));
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
    .input(z.object({ scope: scopeSchema, uids: z.array(z.string()).min(1).max(100) }))
    .query(async ({ ctx, input }) => {
      const col = ctx.db.collection(resolveCollectionPath(ctx.collection, input.scope));
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
      scope: scopeSchema,
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
      const col = ctx.db.collection(resolveCollectionPath(ctx.collection, input.scope));
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
      scope: scopeSchema,
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
      const col = ctx.db.collection(resolveCollectionPath(ctx.collection, input.scope));
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
                query = query.where(field, clause.op as WhereFilterOp, clause.value);
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
      scope: scopeSchema,
      q: z.string(),
      limit: z.number().min(1).max(50).default(20),
    }))
    .query(async ({ ctx, input }) => {
      const q = input.q.trim();
      if (!q) return { results: [] as Record<string, unknown>[] };

      const col = ctx.db.collection(resolveCollectionPath(ctx.collection, input.scope));
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
    .input(z.object({ scope: scopeSchema, uid: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const doc = await ctx.db.collection(resolveCollectionPath(ctx.collection, input.scope)).doc(stripTypePrefix(input.uid)).get();
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
      scope: scopeSchema,
      aUid: z.string().min(1),
      axbType: z.string().min(1),
      bUid: z.string().min(1),
    }))
    .query(async ({ ctx, input }) => {
      const docId = computeEdgeDocId(input.aUid, input.axbType, input.bUid);
      const doc = await ctx.db.collection(resolveCollectionPath(ctx.collection, input.scope)).doc(docId).get();
      return { exists: doc.exists };
    }),

  // --- Write: Create Node ---
  createNode: writeProcedure
    .input(z.object({
      scope: scopeSchema,
      aType: z.string(),
      uid: z.string().optional(),
      data: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const client = getScopedClient(ctx.graphClient, input.scope);
        const nodeUid = input.uid || generateId();
        await client.putNode(input.aType, nodeUid, input.data);
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
      scope: scopeSchema,
      uid: z.string(),
      data: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const client = getScopedClient(ctx.graphClient, input.scope);
        const existing = await client.getNode(input.uid);
        if (!existing) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Node not found' });
        }
        await client.putNode(existing.aType, input.uid, input.data);
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
    .input(z.object({ scope: scopeSchema, uid: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const client = getScopedClient(ctx.graphClient, input.scope);
      await client.removeNode(input.uid);
      return { success: true as const };
    }),

  // --- Write: Delete Node + Cascade (all edges) ---
  deleteNodeCascade: writeProcedure
    .input(z.object({ scope: scopeSchema, uid: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const client = getScopedClient(ctx.graphClient, input.scope);
      const result = await client.removeNodeCascade(input.uid);
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
      scope: scopeSchema,
      aType: z.string(),
      aUid: z.string(),
      axbType: z.string(),
      bType: z.string(),
      bUid: z.string(),
      data: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        const client = getScopedClient(ctx.graphClient, input.scope);
        await client.putEdge(
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
      scope: scopeSchema,
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
        const client = getScopedClient(ctx.graphClient, input.scope);
        const newUid = input.newNodeUid || generateId();
        const newNodeType = input.newNodeSide === 'b' ? input.bType : input.aType;
        const aUid = input.newNodeSide === 'a' ? newUid : input.existingUid;
        const bUid = input.newNodeSide === 'b' ? newUid : input.existingUid;

        // Pre-check: does the node and/or edge already exist?
        const [existingNode, existingEdge] = await Promise.all([
          client.getNode(newUid),
          client.getEdge(aUid, input.axbType, bUid),
        ]);

        if (existingNode && existingEdge) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Both node "${newUid}" and edge ${aUid} —[${input.axbType}]→ ${bUid} already exist.`,
          });
        }

        await client.runTransaction(async (tx) => {
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
      scope: scopeSchema,
      aUid: z.string(),
      axbType: z.string(),
      bUid: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const client = getScopedClient(ctx.graphClient, input.scope);
      await client.removeEdge(input.aUid, input.axbType, input.bUid);
      return { success: true as const };
    }),

  // --- Write: Bulk Delete Edges (by query) ---
  bulkDeleteEdges: writeProcedure
    .input(z.object({
      scope: scopeSchema,
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
      const client = getScopedClient(ctx.graphClient, input.scope);
      const { where: whereClauses, scope: _scope, ...params } = input;
      const findParams: Record<string, unknown> = { ...params };
      if (whereClauses && whereClauses.length > 0) {
        findParams.where = whereClauses;
      }
      const result = await client.bulkRemoveEdges(findParams as any);
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
      scope: scopeSchema,
      edges: z.array(z.object({
        aUid: z.string(),
        axbType: z.string(),
        bUid: z.string(),
      })).min(1).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      const client = getScopedClient(ctx.graphClient, input.scope);
      const batch = client.batch();
      for (const e of input.edges) {
        await batch.removeEdge(e.aUid, e.axbType, e.bUid);
      }
      await batch.commit();
      return { success: true as const, deleted: input.edges.length };
    }),
  // --- Plain Collection Procedures ---

  getCollectionDocs: publicProcedure
    .input(z.object({
      collectionName: z.string(),
      params: z.record(z.string(), z.string()).optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(50),
      where: z.array(z.object({
        field: z.string(),
        op: z.string(),
        value: z.union([z.string(), z.number(), z.boolean()]),
      })).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const def = getCollectionDef(ctx, input.collectionName);
      const colPath = substitutePathTemplate(def.path, input.params ?? {});
      const col = ctx.db.collection(colPath);

      const allowedOps = ['==', '!=', '<', '<=', '>', '>='] as const;
      type AllowedOp = (typeof allowedOps)[number];
      // If the collection has a schema, restrict filters to known field names.
      // For schemaless collections, allow any field matching the safe pattern.
      const schemaFieldNames = def.fields.length > 0 ? new Set(def.fields.map((f) => f.name)) : null;
      const safeFieldNameRe = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

      let query: Query = col;
      if (def.typeField && def.typeValue !== undefined) {
        query = query.where(def.typeField, '==', def.typeValue);
      }
      // Apply caller-supplied where clauses before orderBy.
      if (input.where?.length) {
        for (const clause of input.where) {
          if (!allowedOps.includes(clause.op as AllowedOp)) continue;
          if (schemaFieldNames ? !schemaFieldNames.has(clause.field) : !safeFieldNameRe.test(clause.field)) continue;
          query = query.where(clause.field, clause.op as AllowedOp, clause.value);
        }
      }
      // Always orderBy so startAfter has a defined sort key.
      // When no defaultOrderBy, fall back to document ID ordering.
      if (def.defaultOrderBy) {
        query = query.orderBy(def.defaultOrderBy.field, def.defaultOrderBy.direction);
      } else {
        query = query.orderBy(FieldPath.documentId());
      }
      query = query.limit(input.limit + 1);
      // cursor is always a document ID. Fetch the snapshot so startAfter works correctly
      // for any orderBy field type (including Timestamps — avoids ISO-string/Timestamp mismatch).
      if (input.cursor) {
        const cursorSnap = await col.doc(input.cursor).get();
        if (!cursorSnap.exists) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `Cursor document "${input.cursor}" no longer exists. Refresh to start from the first page.`,
          });
        }
        query = query.startAfter(cursorSnap);
      }

      const snapshot = await query.get();
      const docs = snapshot.docs.slice(0, input.limit);
      const hasMore = snapshot.docs.length > input.limit;

      const documents = docs.map((doc) => ({
        id: doc.id,
        data: serializeRecord(doc.data()),
      }));

      // Always use the document ID as the cursor so startAfter can be called with a snapshot.
      const nextCursor = hasMore && docs.length > 0 ? docs[docs.length - 1].id : null;

      return {
        documents,
        hasMore,
        nextCursor,
      };
    }),

  getCollectionDoc: publicProcedure
    .input(z.object({
      collectionName: z.string(),
      params: z.record(z.string(), z.string()).optional(),
      docId: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      const def = getCollectionDef(ctx, input.collectionName);
      const colPath = substitutePathTemplate(def.path, input.params ?? {});
      const snap = await ctx.db.collection(colPath).doc(input.docId).get();
      if (!snap.exists) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Document "${input.docId}" not found.` });
      }
      const docData = snap.data()!;
      if (def.typeField && def.typeValue !== undefined && docData[def.typeField] !== def.typeValue) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Document "${input.docId}" not found.` });
      }
      return { id: snap.id, data: serializeRecord(docData) };
    }),

  createCollectionDoc: writeProcedure
    .input(z.object({
      collectionName: z.string(),
      params: z.record(z.string(), z.string()).optional(),
      data: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ ctx, input }) => {
      const def = getCollectionDef(ctx, input.collectionName);
      const colPath = substitutePathTemplate(def.path, input.params ?? {});
      const docData: Record<string, unknown> = { ...input.data };
      if (def.typeField && def.typeValue !== undefined) {
        docData[def.typeField] = def.typeValue;
      }
      const docRef = await ctx.db.collection(colPath).add(docData);
      return { success: true as const, id: docRef.id };
    }),

  updateCollectionDoc: writeProcedure
    .input(z.object({
      collectionName: z.string(),
      params: z.record(z.string(), z.string()).optional(),
      docId: z.string(),
      data: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ ctx, input }) => {
      const def = getCollectionDef(ctx, input.collectionName);
      const colPath = substitutePathTemplate(def.path, input.params ?? {});
      // Verify document exists and belongs to this type partition
      if (def.typeField && def.typeValue !== undefined) {
        const snap = await ctx.db.collection(colPath).doc(input.docId).get();
        if (!snap.exists || snap.data()![def.typeField] !== def.typeValue) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `Document "${input.docId}" not found.` });
        }
      }
      const docData: Record<string, unknown> = { ...input.data };
      if (def.typeField && def.typeValue !== undefined) {
        docData[def.typeField] = def.typeValue;
      }
      // Use merge: true to preserve server-managed fields not present in the form payload.
      await ctx.db.collection(colPath).doc(input.docId).set(docData, { merge: true });
      return { success: true as const };
    }),

  deleteCollectionDoc: writeProcedure
    .input(z.object({
      collectionName: z.string(),
      params: z.record(z.string(), z.string()).optional(),
      docId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const def = getCollectionDef(ctx, input.collectionName);
      const colPath = substitutePathTemplate(def.path, input.params ?? {});
      if (def.typeField && def.typeValue !== undefined) {
        const snap = await ctx.db.collection(colPath).doc(input.docId).get();
        if (!snap.exists || snap.data()![def.typeField] !== def.typeValue) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `Document "${input.docId}" not found.` });
        }
      }
      await ctx.db.collection(colPath).doc(input.docId).delete();
      return { success: true as const };
    }),
});

export type AppRouter = typeof appRouter;
