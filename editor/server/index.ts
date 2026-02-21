import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import type { Firestore, DocumentData, Query } from 'firebase-admin/firestore';
import { createGraphClient, generateId, ValidationError, RegistryViolationError } from '../../src/index.js';
import type { GraphClient, GraphRegistry } from '../../src/types.js';
import { loadRegistry } from './registry-loader.js';
import { introspectRegistry } from './schema-introspect.js';
import type { SchemaMetadata } from './schema-introspect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config from CLI args & env ---

interface EditorConfig {
  project?: string;
  collection: string;
  port?: number;
  emulator?: string;
  registryPath?: string;
  readonly: boolean;
}

function parseArgs(): EditorConfig {
  const args = process.argv.slice(2);
  let project: string | undefined;
  let collection: string | undefined;
  let port: number | undefined;
  let emulator: string | undefined;
  let registryPath: string | undefined;
  let readonly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--project=')) project = arg.split('=')[1];
    else if (arg === '--project' && args[i + 1]) project = args[++i];
    else if (arg.startsWith('--collection=')) collection = arg.split('=')[1];
    else if (arg === '--collection' && args[i + 1]) collection = args[++i];
    else if (arg.startsWith('--port=')) port = parseInt(arg.split('=')[1], 10);
    else if (arg === '--port' && args[i + 1]) port = parseInt(args[++i], 10);
    else if (arg.startsWith('--emulator=')) emulator = arg.split('=')[1];
    else if (arg === '--emulator' && args[i + 1] && !args[i + 1].startsWith('--')) emulator = args[++i];
    else if (arg === '--emulator') emulator = '127.0.0.1:8080';
    else if (arg.startsWith('--registry=')) registryPath = arg.split('=')[1];
    else if (arg === '--registry' && args[i + 1]) registryPath = args[++i];
    else if (arg === '--readonly') readonly = true;
  }

  project = project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  collection = collection || process.env.FIREGRAPH_COLLECTION || 'graph';
  emulator = emulator || process.env.FIRESTORE_EMULATOR_HOST;
  if (!port && process.env.PORT) port = parseInt(process.env.PORT, 10);

  return { project, collection, port, emulator, registryPath, readonly };
}

const config = parseArgs();

// --- Firebase init ---

if (config.emulator) {
  process.env.FIRESTORE_EMULATOR_HOST = config.emulator;
}

const appOptions: Record<string, unknown> = {};
if (config.project) appOptions.projectId = config.project;

try {
  if (config.emulator) {
    initializeApp(appOptions);
  } else {
    initializeApp({
      ...appOptions,
      credential: applicationDefault(),
    });
  }
} catch {
  // App may already be initialized
}

const db: Firestore = getFirestore();
const collectionPath = config.collection;

// --- Load registry ---

let registry: GraphRegistry;
let schemaMetadata: SchemaMetadata;
let graphClient: GraphClient;

async function init() {
  if (!config.registryPath) {
    console.error('');
    console.error('  Error: --registry <path> is required.');
    console.error('');
    console.error('  The editor requires a registry file to operate. Discovery mode has been removed.');
    console.error('  Provide a path to a TypeScript file that exports a GraphRegistry:');
    console.error('');
    console.error('    npx firegraph editor --registry ./src/registry.ts --collection graph');
    console.error('');
    process.exit(1);
  }

  console.log(`  Loading registry from ${config.registryPath}...`);
  registry = await loadRegistry(config.registryPath);
  schemaMetadata = introspectRegistry(registry);
  console.log(
    `  Registry loaded: ${schemaMetadata.nodeTypes.length} node types, ${schemaMetadata.edgeTypes.length} edge types`,
  );

  graphClient = createGraphClient(db, collectionPath, { registry });
}

// --- Helpers ---

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

const NODE_RELATION = 'is';
const isWriteEnabled = !config.readonly;

// --- Express app ---

const app = express();
app.use(cors());
app.use(express.json());

// --- API: Config ---

app.get('/api/config', (_req, res) => {
  res.json({
    projectId: config.project || '(auto-detected)',
    collection: collectionPath,
    readonly: !isWriteEnabled,
  });
});

// --- API: Schema ---

app.get('/api/schema', (_req, res) => {
  try {
    const nodeTypes = schemaMetadata.nodeTypes.map((n) => ({
      type: n.aType,
      description: n.description,
    }));

    const edgeTypes = schemaMetadata.edgeTypes.map((e) => ({
      aType: e.aType,
      abType: e.abType,
      bType: e.bType,
      description: e.description,
    }));

    res.json({
      nodeTypes,
      edgeTypes,
      readonly: !isWriteEnabled,
      nodeSchemas: schemaMetadata.nodeTypes,
      edgeSchemas: schemaMetadata.edgeTypes,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- API: Browse Nodes ---

app.get('/api/nodes', async (req, res) => {
  try {
    const col = db.collection(collectionPath);
    const type = req.query.type as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 200);
    const startAfter = req.query.startAfter as string | undefined;
    const sortBy = (req.query.sortBy as string) || 'aUid';
    const sortDir = (req.query.sortDir as string) === 'desc' ? 'desc' : 'asc';
    const filterField = req.query.filterField as string | undefined;
    const filterOp = req.query.filterOp as string | undefined;
    const filterValue = req.query.filterValue as string | undefined;

    const allowedSortFields = ['aUid', 'createdAt', 'updatedAt'];
    const effectiveSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'aUid';

    let query: Query = col.where('abType', '==', NODE_RELATION);

    if (type) {
      query = query.where('aType', '==', type);
    }

    // Apply optional data subfield filter
    if (filterField && filterOp && filterValue !== undefined) {
      const allowedOps = ['==', '!=', '<', '<=', '>', '>='] as const;
      type AllowedOp = (typeof allowedOps)[number];
      if (allowedOps.includes(filterOp as AllowedOp)) {
        const field = filterField.startsWith('data.') ? filterField : `data.${filterField}`;
        // Attempt numeric coercion for comparison ops
        let coercedValue: string | number = filterValue;
        if (['<', '<=', '>', '>='].includes(filterOp)) {
          const num = Number(filterValue);
          if (!isNaN(num)) coercedValue = num;
        }
        query = query.where(field, filterOp as AllowedOp, coercedValue);
      }
    }

    query = query.orderBy(effectiveSortBy, sortDir as 'asc' | 'desc').limit(limit + 1);

    if (startAfter) {
      query = query.startAfter(startAfter);
    }

    const snapshot = await query.get();
    const docs = snapshot.docs.slice(0, limit);
    const hasMore = snapshot.docs.length > limit;

    const nodes = docs.map((doc) => serializeRecord(doc.data()));

    // Build cursor from the sort field of the last doc
    let nextCursor: string | null = null;
    if (hasMore && docs.length > 0) {
      const lastDoc = docs[docs.length - 1].data();
      const cursorValue = lastDoc[effectiveSortBy];
      nextCursor = cursorValue instanceof Timestamp ? cursorValue.toDate().toISOString() : String(cursorValue);
    }

    res.json({ nodes, hasMore, nextCursor });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- API: Get Single Node ---

app.get('/api/node/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const col = db.collection(collectionPath);
    const edgeLimit = Math.min(parseInt(req.query.edgeLimit as string) || 50, 200);

    const nodeDoc = await col.doc(uid).get();
    const node = nodeDoc.exists ? serializeRecord(nodeDoc.data()!) : null;

    // Get outgoing edges
    const outSnapshot = await col.where('aUid', '==', uid).limit(edgeLimit + 1).get();
    const outEdges = outSnapshot.docs
      .map((doc) => serializeRecord(doc.data()))
      .filter((e) => e.abType !== NODE_RELATION);

    // Get incoming edges
    const inSnapshot = await col.where('bUid', '==', uid).limit(edgeLimit + 1).get();
    const inEdges = inSnapshot.docs
      .map((doc) => serializeRecord(doc.data()))
      .filter((e) => e.abType !== NODE_RELATION);

    res.json({ node, outEdges, inEdges });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- API: Batch Get Nodes ---

app.post('/api/nodes/batch', async (req, res) => {
  try {
    const { uids } = req.body as { uids: string[] };
    if (!Array.isArray(uids) || uids.length === 0) {
      return res.status(400).json({ error: 'uids must be a non-empty array' });
    }
    const cappedUids = uids.slice(0, 100);
    const col = db.collection(collectionPath);
    const refs = cappedUids.map((uid) => col.doc(uid));
    const snapshots = await db.getAll(...refs);

    const nodes: Record<string, Record<string, unknown> | null> = {};
    for (const snap of snapshots) {
      if (snap.exists) {
        nodes[snap.id] = serializeRecord(snap.data()!);
      } else {
        nodes[snap.id] = null;
      }
    }

    res.json({ nodes });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- API: Query Edges ---

app.get('/api/edges', async (req, res) => {
  try {
    const col = db.collection(collectionPath);
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 200);
    const startAfter = req.query.startAfter as string | undefined;
    const { aType, aUid, abType, bType, bUid } = req.query as Record<string, string | undefined>;

    let query: Query = col;

    if (aType) query = query.where('aType', '==', aType);
    if (aUid) query = query.where('aUid', '==', aUid);
    if (abType) query = query.where('abType', '==', abType);
    if (bType) query = query.where('bType', '==', bType);
    if (bUid) query = query.where('bUid', '==', bUid);

    // Exclude node-self edges unless filtering by specific abType
    if (!abType) {
      query = query.where('abType', '!=', NODE_RELATION);
    }

    query = query.orderBy('abType').limit(limit + 1);

    if (startAfter) {
      query = query.startAfter(startAfter);
    }

    const snapshot = await query.get();
    const docs = snapshot.docs.slice(0, limit);
    const hasMore = snapshot.docs.length > limit;

    const edges = docs.map((doc) => serializeRecord(doc.data()));

    let nextCursor: string | null = null;
    if (hasMore && docs.length > 0) {
      nextCursor = String(docs[docs.length - 1].data().abType);
    }

    res.json({ edges, hasMore, nextCursor });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- API: Traversal ---

interface HopDef {
  abType: string;
  direction?: 'forward' | 'reverse';
  limit?: number;
  aType?: string;
  bType?: string;
}

interface HopResultData {
  abType: string;
  direction: string;
  depth: number;
  edges: Record<string, unknown>[];
  sourceCount: number;
  truncated: boolean;
}

app.post('/api/traverse', async (req, res) => {
  try {
    const { startUid, hops, maxReads = 100 } = req.body as {
      startUid: string;
      hops: HopDef[];
      maxReads?: number;
    };

    if (!startUid || !hops || hops.length === 0) {
      return res.status(400).json({ error: 'startUid and at least one hop required' });
    }

    const col = db.collection(collectionPath);
    let totalReads = 0;
    let truncated = false;
    let sourceUids = [startUid];
    const hopResults: HopResultData[] = [];

    for (let depth = 0; depth < hops.length; depth++) {
      const hop = hops[depth];
      const direction = hop.direction ?? 'forward';
      const hopLimit = hop.limit ?? 10;

      if (sourceUids.length === 0 || truncated) {
        hopResults.push({
          abType: hop.abType,
          direction,
          depth,
          edges: [],
          sourceCount: 0,
          truncated,
        });
        continue;
      }

      const hopEdges: Record<string, unknown>[] = [];
      const sourceCount = sourceUids.length;
      let hopTruncated = false;

      const batchSize = 5;
      for (let i = 0; i < sourceUids.length; i += batchSize) {
        if (totalReads >= maxReads) {
          hopTruncated = true;
          break;
        }

        const batch = sourceUids.slice(i, i + batchSize);
        const promises = batch.map(async (uid) => {
          if (totalReads >= maxReads) return [];
          totalReads++;

          let query: Query = col.where('abType', '==', hop.abType);

          if (direction === 'forward') {
            query = query.where('aUid', '==', uid);
            if (hop.bType) query = query.where('bType', '==', hop.bType);
          } else {
            query = query.where('bUid', '==', uid);
            if (hop.aType) query = query.where('aType', '==', hop.aType);
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
        abType: hop.abType,
        direction,
        depth,
        edges: hopEdges,
        sourceCount,
        truncated: hopTruncated,
      });

      if (hopTruncated) truncated = true;

      const nextUids = new Set<string>();
      for (const edge of hopEdges) {
        nextUids.add((direction === 'forward' ? edge.bUid : edge.aUid) as string);
      }
      sourceUids = [...nextUids];
    }

    const lastHop = hopResults[hopResults.length - 1];

    res.json({
      nodes: lastHop?.edges ?? [],
      hops: hopResults,
      totalReads,
      truncated,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- API: Search ---

app.get('/api/search', async (req, res) => {
  try {
    const q = ((req.query.q as string) || '').trim();
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

    if (!q) {
      return res.json({ results: [] });
    }

    const col = db.collection(collectionPath);

    const nodeDoc = await col.doc(q).get();
    const results: Record<string, unknown>[] = [];

    if (nodeDoc.exists) {
      results.push({ ...serializeRecord(nodeDoc.data()!), _matchType: 'exact' });
    }

    const aUidSnapshot = await col.where('aUid', '==', q).limit(limit).get();
    for (const doc of aUidSnapshot.docs) {
      const record = serializeRecord(doc.data());
      if (!results.some((r) => r.aUid === record.aUid && r.abType === record.abType && r.bUid === record.bUid)) {
        results.push({ ...record, _matchType: 'aUid' });
      }
    }

    const bUidSnapshot = await col.where('bUid', '==', q).limit(limit).get();
    for (const doc of bUidSnapshot.docs) {
      const record = serializeRecord(doc.data());
      if (!results.some((r) => r.aUid === record.aUid && r.abType === record.abType && r.bUid === record.bUid)) {
        results.push({ ...record, _matchType: 'bUid' });
      }
    }

    res.json({ results: results.slice(0, limit) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- API: Write Operations (registry required) ---

app.post('/api/node', async (req, res) => {
  if (!isWriteEnabled) {
    return res.status(403).json({ error: 'Write operations require a registry. Use --registry flag.' });
  }
  try {
    const { aType, uid, data } = req.body as { aType: string; uid?: string; data: Record<string, unknown> };
    const nodeUid = uid || generateId();
    await graphClient.putNode(aType, nodeUid, data);
    res.json({ success: true, uid: nodeUid });
  } catch (err) {
    if (err instanceof ValidationError || err instanceof RegistryViolationError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: String(err) });
  }
});

app.put('/api/node/:uid', async (req, res) => {
  if (!isWriteEnabled) {
    return res.status(403).json({ error: 'Write operations require a registry. Use --registry flag.' });
  }
  try {
    const { uid } = req.params;
    const { data } = req.body as { data: Record<string, unknown> };

    const existing = await graphClient.getNode(uid);
    if (!existing) {
      return res.status(404).json({ error: 'Node not found' });
    }

    // putNode validates full data through registry
    await graphClient.putNode(existing.aType, uid, data);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof ValidationError || err instanceof RegistryViolationError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: String(err) });
  }
});

app.delete('/api/node/:uid', async (req, res) => {
  if (!isWriteEnabled) {
    return res.status(403).json({ error: 'Write operations require a registry. Use --registry flag.' });
  }
  try {
    await graphClient.removeNode(req.params.uid);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/edge', async (req, res) => {
  if (!isWriteEnabled) {
    return res.status(403).json({ error: 'Write operations require a registry. Use --registry flag.' });
  }
  try {
    const { aType, aUid, abType, bType, bUid, data } = req.body as {
      aType: string;
      aUid: string;
      abType: string;
      bType: string;
      bUid: string;
      data: Record<string, unknown>;
    };
    await graphClient.putEdge(aType, aUid, abType, bType, bUid, data || {});
    res.json({ success: true });
  } catch (err) {
    if (err instanceof ValidationError || err instanceof RegistryViolationError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: String(err) });
  }
});

app.delete('/api/edge', async (req, res) => {
  if (!isWriteEnabled) {
    return res.status(403).json({ error: 'Write operations require a registry. Use --registry flag.' });
  }
  try {
    const { aUid, abType, bUid } = req.body as { aUid: string; abType: string; bUid: string };
    await graphClient.removeEdge(aUid, abType, bUid);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Serve static frontend in production ---

const isProduction = process.env.NODE_ENV === 'production';
const port = config.port ?? (isProduction ? 3883 : 3884);

if (isProduction) {
  const clientDir = path.join(__dirname, '..', 'client');
  app.use(express.static(clientDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

// --- Start ---

async function start() {
  await init();

  const server = app.listen(port, () => {
    console.log('');
    console.log('  Firegraph Editor');
    console.log(`  Project:    ${config.project || '(auto-detected via ADC)'}`);
    console.log(`  Collection: ${collectionPath}`);
    if (config.emulator) {
      console.log(`  Emulator:   ${config.emulator}`);
    }
    console.log(`  Registry:   ${config.registryPath}`);
    console.log(`  Mode:       ${isWriteEnabled ? 'Read/Write' : 'Read-Only'}`);
    console.log(`  Server:     http://localhost:${port}`);
    if (!isProduction) {
      console.log(`  UI (dev):   http://localhost:3883`);
    }
    console.log('');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Error: Port ${port} is already in use.`);
      console.error(`  Kill the existing process or use --port=<number> to pick a different port.\n`);
      process.exit(1);
    }
    throw err;
  });
}

start().catch((err) => {
  console.error('Failed to start Firegraph Editor:', err);
  process.exit(1);
});
