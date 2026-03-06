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
import type { ViewRegistry } from '../../src/views.js';
import type { ViewBundle } from './views-bundler.js';
import { loadConfig } from './config-loader.js';
import type { LoadedConfig } from './config-loader.js';
import { validateSchemaViews } from './schema-views-validator.js';
import type { SchemaViewWarning } from './schema-views-validator.js';
import { buildViewRegistryFromDiscovery, mergeViewDefaults } from './entities-loader.js';
import { discoverEntities } from '../../src/discover.js';
import * as trpcExpress from '@trpc/server/adapters/express';
import { appRouter, createContext } from './trpc.js';
import { detectClaude, registerChatRoutes } from './chat.js';

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
  }

  // Env var fallbacks (applied before config merge — CLI + env override config file)
  project = project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  emulator = emulator || process.env.FIRESTORE_EMULATOR_HOST;
  collection = collection || process.env.FIREGRAPH_COLLECTION;
  if (!port && process.env.PORT) port = parseInt(process.env.PORT, 10);

  return { configPath, entitiesPath, project, collection, port, emulator, queryMode, readonly };
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

// --- State ---

let db: Firestore;
let registry: GraphRegistry;
let schemaMetadata: SchemaMetadata;
let graphClient: GraphClient;
let viewRegistry: ViewRegistry | null = null;
let viewBundle: ViewBundle | null = null;
let schemaViewWarnings: SchemaViewWarning[] = [];

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
  graphClient = createGraphClient(db, resolvedCollection, {
    registry,
    queryMode: resolvedQueryMode,
  });
}

async function initEntitiesMode(fileConfig: LoadedConfig) {
  console.log(`  Discovering entities from ${resolvedEntitiesPath}...`);
  const { result: discovery, warnings } = discoverEntities(resolvedEntitiesPath!);

  if (warnings.length > 0) {
    for (const w of warnings) {
      console.log(`    [warn] ${w.message}`);
    }
  }

  // Build registry from discovery
  registry = createRegistry(discovery);
  schemaMetadata = introspectRegistry(registry);
  console.log(
    `  Entities loaded: ${schemaMetadata.nodeTypes.length} node types, ${schemaMetadata.edgeTypes.length} edge types`,
  );

  // Build view registry from per-entity view files
  viewRegistry = await buildViewRegistryFromDiscovery(discovery);
  if (viewRegistry) {
    const nodeViewCount = Object.values(viewRegistry.nodes).reduce((sum, m) => sum + m.views.length, 0);
    const edgeViewCount = Object.values(viewRegistry.edges).reduce((sum, m) => sum + m.views.length, 0);
    console.log(`  Views loaded: ${nodeViewCount} node views, ${edgeViewCount} edge views`);

    // Bundle views for browser
    console.log(`  Bundling views for browser...`);
    viewBundle = await bundleEntityViews(discovery);
    if (viewBundle) {
      console.log(`  Views bundled (${(viewBundle.code.length / 1024).toFixed(1)} KB)`);
    }
  }

  // Merge view defaults: entity meta.json + config overrides
  viewDefaultsData = mergeViewDefaults(discovery, fileConfig.viewDefaults);

  // Cross-validate
  crossValidate();
}

function crossValidate() {
  try {
    schemaViewWarnings = validateSchemaViews(
      schemaMetadata,
      viewRegistry,
      viewDefaultsData ?? null,
      registry,
    );
    if (schemaViewWarnings.length > 0) {
      console.log(`  Warnings: ${schemaViewWarnings.length} schema/views issue(s) detected`);
      for (const w of schemaViewWarnings) {
        console.log(`    [${w.severity}] ${w.message}`);
      }
    }
  } catch (err) {
    console.error('  Warning: schema/views validation failed:', err instanceof Error ? err.message : String(err));
    schemaViewWarnings = [];
  }
}

// --- Express app ---

const app = express();
app.use(cors());
app.use(express.json());

// --- Views bundle (non-tRPC, serves raw JS) ---

app.get('/api/views/bundle', (_req, res) => {
  if (!viewBundle) {
    return res.status(404).json({ error: 'No views configured' });
  }
  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'public, max-age=3600');
  res.set('ETag', viewBundle.hash);
  res.send(viewBundle.code);
});

// --- Start ---

async function start() {
  await init();

  // Mount tRPC router
  app.use(
    '/api/trpc',
    trpcExpress.createExpressMiddleware({
      router: appRouter,
      createContext: createContext({
        db,
        collection: resolvedCollection,
        registry,
        schemaMetadata,
        graphClient,
        viewRegistry,
        viewBundle,
        readonly: resolvedReadonly,
        projectId: resolvedProject,
        viewDefaults: viewDefaultsData,
        schemaViewWarnings,
        chatEnabled: resolvedChatEnabled,
        chatModel: resolvedChatModel,
      }),
    }),
  );

  // Mount chat routes (Express SSE — not tRPC)
  if (resolvedChatEnabled) {
    registerChatRoutes(app, {
      schemaMetadata,
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
