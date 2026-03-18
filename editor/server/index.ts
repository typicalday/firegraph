import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Firestore } from '@google-cloud/firestore';
import { createGraphClient } from '../../src/index.js';
import type { GraphClient, GraphRegistry, DiscoveryResult, QueryMode } from '../../src/types.js';
import { createRegistry } from '../../src/registry.js';
import { introspectRegistry } from './schema-introspect.js';
import type { SchemaMetadata } from './schema-introspect.js';
import { bundleEntityViews } from './views-bundler.js';
import type { ViewRegistry, EntityViewMeta } from '../../src/views.js';
import type { ViewBundle } from './views-bundler.js';
import { loadConfig } from './config-loader.js';
import type { LoadedConfig } from './config-loader.js';
import { validateSchemaViews } from './schema-views-validator.js';
import type { SchemaViewWarning } from './schema-views-validator.js';
import { buildViewRegistryFromDiscovery, mergeViewDefaults } from './entities-loader.js';
import { discoverEntities } from '../../src/discover.js';
import { discoverCollections, buildCollectionViewRegistry } from './collections-loader.js';
import type { DiscoveredCollection } from './collections-loader.js';
import * as trpcExpress from '@trpc/server/adapters/express';
import { appRouter, createContext } from './trpc.js';
import { detectClaude, registerChatRoutes } from './chat.js';
import { loadDynamicTypes } from './dynamic-loader.js';
import type { DynamicTypeMetadata } from './dynamic-loader.js';
import { generateDynamicViewsBundle, getDynamicViewTags, validateTemplate } from './dynamic-views-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Parse CLI args (before config file — we need --config path) ---

interface CliArgs {
  configPath?: string;
  entitiesPath?: string;
  project?: string;
  collection?: string;
  port?: number;
  emulator?: string;
  queryMode?: QueryMode;
  readonly: boolean;
  registryMode?: 'dynamic';
  metaCollection?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let configPath: string | undefined;
  let entitiesPath: string | undefined;
  let project: string | undefined;
  let collection: string | undefined;
  let port: number | undefined;
  let emulator: string | undefined;
  let queryMode: QueryMode | undefined;
  let readonly = false;
  let registryMode: 'dynamic' | undefined;
  let metaCollection: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--config=')) configPath = arg.split('=')[1];
    else if (arg === '--config' && args[i + 1]) configPath = args[++i];
    else if (arg.startsWith('--entities=')) entitiesPath = arg.split('=')[1];
    else if (arg === '--entities' && args[i + 1]) entitiesPath = args[++i];
    else if (arg.startsWith('--project=')) project = arg.split('=')[1];
    else if (arg === '--project' && args[i + 1]) project = args[++i];
    else if (arg.startsWith('--collection=')) collection = arg.split('=')[1];
    else if (arg === '--collection' && args[i + 1]) collection = args[++i];
    else if (arg.startsWith('--port=')) port = parseInt(arg.split('=')[1], 10);
    else if (arg === '--port' && args[i + 1]) port = parseInt(args[++i], 10);
    else if (arg.startsWith('--emulator=')) emulator = arg.split('=')[1];
    else if (arg === '--emulator' && args[i + 1] && !args[i + 1].startsWith('--')) emulator = args[++i];
    else if (arg === '--emulator') emulator = '127.0.0.1:8080';
    else if (arg.startsWith('--query-mode=')) {
      const val = arg.split('=')[1];
      if (val === 'pipeline' || val === 'standard') queryMode = val;
    } else if (arg === '--query-mode' && args[i + 1]) {
      const val = args[++i];
      if (val === 'pipeline' || val === 'standard') queryMode = val;
    }
    else if (arg === '--readonly') readonly = true;
    else if (arg === '--registry-mode=dynamic' || arg === '--registry-mode' && args[i + 1] === 'dynamic') {
      registryMode = 'dynamic';
      if (arg === '--registry-mode') i++; // consume the 'dynamic' arg
    }
    else if (arg.startsWith('--meta-collection=')) metaCollection = arg.split('=')[1];
    else if (arg === '--meta-collection' && args[i + 1]) metaCollection = args[++i];
  }

  // Env var fallbacks (applied before config merge — CLI + env override config file)
  project = project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  emulator = emulator || process.env.FIRESTORE_EMULATOR_HOST;
  collection = collection || process.env.FIREGRAPH_COLLECTION;
  if (!port && process.env.PORT) port = parseInt(process.env.PORT, 10);

  return { configPath, entitiesPath, project, collection, port, emulator, queryMode, readonly, registryMode, metaCollection };
}

const cliArgs = parseArgs();

// --- Resolved config (populated in init) ---

let resolvedProject: string | undefined;
let resolvedCollection: string;
let resolvedEmulator: string | undefined;
let resolvedEntitiesPath: string | undefined;
let resolvedReadonly: boolean;
let resolvedPort: number;
let resolvedConfigPath: string | undefined;
let resolvedQueryMode: QueryMode | undefined;
let resolvedChatEnabled = false;
let resolvedChatModel = 'sonnet';
let resolvedChatMaxConcurrency = 2;
let viewDefaultsData: LoadedConfig['viewDefaults'] | null = null;
let resolvedCollectionDefs: DiscoveredCollection[] = [];
let collectionViewRegistry: Record<string, EntityViewMeta> = {};
let resolvedRegistryMode: { mode: 'dynamic'; collection?: string } | undefined;

// --- State (mutable — updated on reload for dynamic registry) ---

let db: Firestore;

interface EditorState {
  registry: GraphRegistry;
  schemaMetadata: SchemaMetadata;
  graphClient: GraphClient;
  viewRegistry: ViewRegistry | null;
  viewBundle: ViewBundle | null;
  schemaViewWarnings: SchemaViewWarning[];
  dynamicTypeMeta: DynamicTypeMetadata | null;
  dynamicViewsCode: string | null;
}

const state: EditorState = {
  registry: null!,
  schemaMetadata: null!,
  graphClient: null!,
  viewRegistry: null,
  viewBundle: null,
  schemaViewWarnings: [],
  dynamicTypeMeta: null,
  dynamicViewsCode: null,
};

/** Static entries from filesystem discovery (kept for hybrid merge). */
let staticEntries: ReadonlyArray<import('../../src/types.js').RegistryEntry> = [];
let staticNodeNames: Set<string> = new Set();
let staticEdgeNames: Set<string> = new Set();
/** Names of types loaded from dynamic registry. */
let dynamicNodeNames: Set<string> = new Set();
let dynamicEdgeNames: Set<string> = new Set();

async function init() {
  // 1. Load config file (if any)
  const loaded = await loadConfig(cliArgs.configPath);
  const fileConfig: LoadedConfig = loaded?.config ?? {};
  if (loaded) {
    resolvedConfigPath = loaded.configPath;
    console.log(`  Config loaded from ${path.relative(process.cwd(), loaded.configPath)}`);
  }

  // 2. Merge: config file < env vars/CLI (CLI wins)
  resolvedProject = cliArgs.project ?? fileConfig.project;
  resolvedCollection = cliArgs.collection ?? fileConfig.collection ?? 'graph';
  resolvedEmulator = cliArgs.emulator ?? fileConfig.emulator;
  resolvedEntitiesPath = cliArgs.entitiesPath ?? fileConfig.entities;
  resolvedReadonly = cliArgs.readonly || (fileConfig.editor?.readonly ?? false);
  resolvedQueryMode = cliArgs.queryMode ?? fileConfig.queryMode;

  // Registry mode: CLI flag overrides config file
  if (cliArgs.registryMode === 'dynamic') {
    resolvedRegistryMode = { mode: 'dynamic', collection: cliArgs.metaCollection };
  } else if (fileConfig.registryMode) {
    resolvedRegistryMode = fileConfig.registryMode;
  }

  // Chat config: auto-detect claude on PATH unless chat is explicitly disabled
  const chatConfig = fileConfig.chat;
  if (chatConfig === false) {
    resolvedChatEnabled = false;
  } else {
    resolvedChatEnabled = detectClaude();
    if (chatConfig && typeof chatConfig === 'object') {
      if (chatConfig.model) resolvedChatModel = chatConfig.model;
      if (chatConfig.maxConcurrency) resolvedChatMaxConcurrency = chatConfig.maxConcurrency;
    }
  }

  const isProduction = process.env.NODE_ENV === 'production';
  resolvedPort = cliArgs.port ?? fileConfig.editor?.port ?? (isProduction ? 3883 : 3884);

  // 3. Init Firestore with merged values
  if (resolvedEmulator) {
    process.env.FIRESTORE_EMULATOR_HOST = resolvedEmulator;
  }

  const firestoreOptions: ConstructorParameters<typeof Firestore>[0] = {};
  if (resolvedProject) firestoreOptions.projectId = resolvedProject;

  db = new Firestore(firestoreOptions);

  // 4. Load entities
  if (resolvedEntitiesPath) {
    await initEntitiesMode(fileConfig);
  } else {
    console.error('');
    console.error('  Error: entities directory is required.');
    console.error('');
    console.error('  Provide via firegraph.config.ts or CLI flags:');
    console.error('');
    console.error('    // firegraph.config.ts');
    console.error('    export default defineConfig({ entities: "./entities" });');
    console.error('');
    console.error('    // or CLI flag:');
    console.error('    npx firegraph editor --entities ./entities');
    console.error('');
    process.exit(1);
  }

  // 5. Create graph client
  state.graphClient = createGraphClient(db, resolvedCollection, {
    registry: state.registry,
    queryMode: resolvedQueryMode,
  });

  // 6. If dynamic registry mode, do initial load from Firestore
  if (resolvedRegistryMode) {
    console.log(`  Dynamic registry mode enabled`);
    const metaCol = resolvedRegistryMode.collection ?? resolvedCollection;
    if (resolvedRegistryMode.collection) {
      console.log(`  Meta-collection: ${metaCol}`);
    }
    await reloadDynamicSchema();
  }
}

// ---------------------------------------------------------------------------
// Dynamic schema reload
// ---------------------------------------------------------------------------

export interface ReloadResult {
  nodeTypeCount: number;
  edgeTypeCount: number;
  shadowed: string[];
}

async function reloadDynamicSchema(): Promise<ReloadResult> {
  const metaCollection = resolvedRegistryMode?.collection ?? resolvedCollection;

  // 1. Load dynamic types from Firestore
  const dynamic = await loadDynamicTypes(db, metaCollection, resolvedQueryMode);

  // 2. Filter: filesystem types take precedence on conflict
  const shadowed: string[] = [];
  const filteredEntries = dynamic.entries.filter(entry => {
    if (entry.axbType === 'is') {
      // Node type
      if (staticNodeNames.has(entry.aType)) {
        shadowed.push(`node:${entry.aType}`);
        return false;
      }
      return true;
    }
    // Edge type
    if (staticEdgeNames.has(entry.axbType)) {
      if (!shadowed.includes(`edge:${entry.axbType}`)) {
        shadowed.push(`edge:${entry.axbType}`);
      }
      return false;
    }
    return true;
  });

  // 3. Track dynamic names (after filtering)
  dynamicNodeNames = new Set(
    filteredEntries.filter(e => e.axbType === 'is').map(e => e.aType),
  );
  dynamicEdgeNames = new Set(
    filteredEntries.filter(e => e.axbType !== 'is').map(e => e.axbType),
  );

  // 4. Merge: static entries + filtered dynamic entries
  const mergedEntries = [...staticEntries, ...filteredEntries];
  state.registry = createRegistry(mergedEntries);

  // 5. Introspect with isDynamic tagging
  const allDynamicNames = new Set([...dynamicNodeNames, ...dynamicEdgeNames]);
  state.schemaMetadata = introspectRegistry(state.registry, allDynamicNames);

  // 6. Recreate graph client with merged registry
  state.graphClient = createGraphClient(db, resolvedCollection, {
    registry: state.registry,
    queryMode: resolvedQueryMode,
  });

  // 7. Store dynamic type metadata (templates, css)
  state.dynamicTypeMeta = dynamic.dynamicTypeMeta;

  // 8. Generate dynamic views bundle
  state.dynamicViewsCode = generateDynamicViewsBundle(dynamic.dynamicTypeMeta);

  // 9. Validate templates against schemas
  for (const [name, meta] of Object.entries(dynamic.dynamicTypeMeta.nodes)) {
    if (!meta.viewTemplate) continue;
    const entry = state.registry.lookup(name, 'is', name);
    const warnings = validateTemplate(meta.viewTemplate, entry?.jsonSchema);
    for (const w of warnings) {
      console.log(`    [template-warn] ${name}: ${w}`);
    }
  }
  for (const [name, meta] of Object.entries(dynamic.dynamicTypeMeta.edges)) {
    if (!meta.viewTemplate) continue;
    // Find any entry with this axbType
    const entry = state.registry.entries().find(e => e.axbType === name);
    const warnings = validateTemplate(meta.viewTemplate, entry?.jsonSchema);
    for (const w of warnings) {
      console.log(`    [template-warn] ${name}: ${w}`);
    }
  }

  if (shadowed.length > 0) {
    console.log(`  Dynamic types shadowed by filesystem: ${shadowed.join(', ')}`);
  }

  const nodeTypeCount = dynamic.dynamicNodeNames.length;
  const edgeTypeCount = dynamic.dynamicEdgeNames.length;
  console.log(`  Dynamic types loaded: ${nodeTypeCount} node types, ${edgeTypeCount} edge types`);

  return { nodeTypeCount, edgeTypeCount, shadowed };
}

async function initEntitiesMode(fileConfig: LoadedConfig) {
  console.log(`  Discovering entities from ${resolvedEntitiesPath}...`);
  const { result: discovery, warnings } = discoverEntities(resolvedEntitiesPath!);

  // Discover plain Firestore collections
  resolvedCollectionDefs = discoverCollections(resolvedEntitiesPath!);
  if (resolvedCollectionDefs.length > 0) {
    console.log(`  Collections loaded: ${resolvedCollectionDefs.length} collection(s)`);
  }

  // Build collection view registry
  collectionViewRegistry = await buildCollectionViewRegistry(resolvedCollectionDefs);

  if (warnings.length > 0) {
    for (const w of warnings) {
      console.log(`    [warn] ${w.message}`);
    }
  }

  // Build registry from discovery
  const filesystemRegistry = createRegistry(discovery);
  staticEntries = filesystemRegistry.entries();
  staticNodeNames = new Set(
    staticEntries.filter(e => e.axbType === 'is').map(e => e.aType),
  );
  staticEdgeNames = new Set(
    staticEntries.filter(e => e.axbType !== 'is').map(e => e.axbType),
  );

  state.registry = filesystemRegistry;
  state.schemaMetadata = introspectRegistry(state.registry);
  console.log(
    `  Entities loaded: ${state.schemaMetadata.nodeTypes.length} node types, ${state.schemaMetadata.edgeTypes.length} edge types`,
  );

  // Build view registry from per-entity view files
  state.viewRegistry = await buildViewRegistryFromDiscovery(discovery);
  if (state.viewRegistry) {
    const nodeViewCount = Object.values(state.viewRegistry.nodes).reduce((sum, m) => sum + m.views.length, 0);
    const edgeViewCount = Object.values(state.viewRegistry.edges).reduce((sum, m) => sum + m.views.length, 0);
    console.log(`  Views loaded: ${nodeViewCount} node views, ${edgeViewCount} edge views`);
  }

  // Bundle all views (node/edge + collection) for browser
  const colViewPaths = resolvedCollectionDefs
    .filter((c) => c.viewsPath)
    .map((c) => ({ name: c.name, absPath: path.resolve(c.viewsPath!) }));
  if (state.viewRegistry || colViewPaths.length > 0) {
    console.log(`  Bundling views for browser...`);
    state.viewBundle = await bundleEntityViews(discovery, colViewPaths);
    if (state.viewBundle) {
      console.log(`  Views bundled (${(state.viewBundle.code.length / 1024).toFixed(1)} KB)`);
    }
  }

  // Merge view defaults: entity meta.json + config overrides
  viewDefaultsData = mergeViewDefaults(discovery, fileConfig.viewDefaults);

  // Cross-validate
  crossValidate();
}

function crossValidate() {
  try {
    state.schemaViewWarnings = validateSchemaViews(
      state.schemaMetadata,
      state.viewRegistry,
      viewDefaultsData ?? null,
      state.registry,
    );
    if (state.schemaViewWarnings.length > 0) {
      console.log(`  Warnings: ${state.schemaViewWarnings.length} schema/views issue(s) detected`);
      for (const w of state.schemaViewWarnings) {
        console.log(`    [${w.severity}] ${w.message}`);
      }
    }
  } catch (err) {
    console.error('  Warning: schema/views validation failed:', err instanceof Error ? err.message : String(err));
    state.schemaViewWarnings = [];
  }
}

// --- Express app ---

const app = express();
app.use(cors());
app.use(express.json());

// --- Views bundle (non-tRPC, serves raw JS) ---

app.get('/api/views/bundle', (_req, res) => {
  if (!state.viewBundle) {
    return res.status(404).json({ error: 'No views configured' });
  }
  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'public, max-age=3600');
  res.set('ETag', state.viewBundle.hash);
  res.send(state.viewBundle.code);
});

// --- Dynamic views bundle (template-based, no esbuild) ---

app.get('/api/views/dynamic-bundle', (_req, res) => {
  if (!state.dynamicViewsCode) {
    return res.status(404).json({ error: 'No dynamic views' });
  }
  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'no-cache');
  res.send(state.dynamicViewsCode);
});

// --- Start ---

async function start() {
  await init();

  // Mount tRPC router — context factory reads from `state` per-request
  app.use(
    '/api/trpc',
    trpcExpress.createExpressMiddleware({
      router: appRouter,
      createContext: createContext(
        {
          db,
          collection: resolvedCollection,
          readonly: resolvedReadonly,
          projectId: resolvedProject,
          viewDefaults: viewDefaultsData,
          chatEnabled: resolvedChatEnabled,
          chatModel: resolvedChatModel,
          collectionDefs: resolvedCollectionDefs,
          collectionViewRegistry,
        },
        state,
        resolvedRegistryMode ? reloadDynamicSchema : undefined,
      ),
    }),
  );

  // Mount chat routes (Express SSE — not tRPC)
  if (resolvedChatEnabled) {
    registerChatRoutes(app, {
      schemaMetadata: state.schemaMetadata,
      model: resolvedChatModel,
      maxConcurrency: resolvedChatMaxConcurrency,
    });
  }

  // Serve static frontend in production
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    const clientDir = path.join(__dirname, '..', 'client');
    app.use(express.static(clientDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  }

  const server = app.listen(resolvedPort, () => {
    console.log('');
    console.log('  Firegraph Editor');
    if (resolvedConfigPath) {
      console.log(`  Config:     ${path.relative(process.cwd(), resolvedConfigPath)}`);
    }
    console.log(`  Project:    ${resolvedProject || '(auto-detected via ADC)'}`);
    console.log(`  Collection: ${resolvedCollection}`);
    if (resolvedEmulator) {
      console.log(`  Emulator:   ${resolvedEmulator}`);
    }
    if (resolvedEntitiesPath) {
      console.log(`  Entities:   ${resolvedEntitiesPath}`);
    }
    if (viewDefaultsData) {
      const nodeDefaults = Object.keys(viewDefaultsData.nodes ?? {}).length;
      const edgeDefaults = Object.keys(viewDefaultsData.edges ?? {}).length;
      if (nodeDefaults + edgeDefaults > 0) {
        console.log(`  Defaults:   ${nodeDefaults} node types, ${edgeDefaults} edge types`);
      }
    }
    const effectiveQueryMode = resolvedEmulator ? 'standard (emulator)' : (resolvedQueryMode ?? 'pipeline');
    console.log(`  Queries:    ${effectiveQueryMode}`);
    console.log(`  Chat:       ${resolvedChatEnabled ? `enabled (model: ${resolvedChatModel})` : 'disabled (claude CLI not found)'}`);
    if (resolvedRegistryMode) {
      const metaCol = resolvedRegistryMode.collection ?? resolvedCollection;
      console.log(`  Registry:   dynamic (meta: ${metaCol})`);
    }
    console.log(`  Mode:       ${resolvedReadonly ? 'Read-Only' : 'Read/Write'}`);
    console.log(`  Server:     http://localhost:${resolvedPort}`);
    if (!isProduction) {
      console.log(`  UI (dev):   http://localhost:3883`);
    }
    console.log('');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Error: Port ${resolvedPort} is already in use.`);
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
