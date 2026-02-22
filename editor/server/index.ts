import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { createGraphClient } from '../../src/index.js';
import type { GraphClient, GraphRegistry } from '../../src/types.js';
import { loadRegistry } from './registry-loader.js';
import { introspectRegistry } from './schema-introspect.js';
import type { SchemaMetadata } from './schema-introspect.js';
import { loadViews } from './views-loader.js';
import { bundleViews } from './views-bundler.js';
import type { ViewRegistry } from '../../src/views.js';
import type { ViewBundle } from './views-bundler.js';
import { loadConfig } from './config-loader.js';
import type { LoadedConfig } from './config-loader.js';
import * as trpcExpress from '@trpc/server/adapters/express';
import { appRouter, createContext } from './trpc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Parse CLI args (before config file — we need --config path) ---

interface CliArgs {
  configPath?: string;
  project?: string;
  collection?: string;
  port?: number;
  emulator?: string;
  registryPath?: string;
  viewsPath?: string;
  readonly: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let configPath: string | undefined;
  let project: string | undefined;
  let collection: string | undefined;
  let port: number | undefined;
  let emulator: string | undefined;
  let registryPath: string | undefined;
  let viewsPath: string | undefined;
  let readonly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--config=')) configPath = arg.split('=')[1];
    else if (arg === '--config' && args[i + 1]) configPath = args[++i];
    else if (arg.startsWith('--project=')) project = arg.split('=')[1];
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
    else if (arg.startsWith('--views=')) viewsPath = arg.split('=')[1];
    else if (arg === '--views' && args[i + 1]) viewsPath = args[++i];
    else if (arg === '--readonly') readonly = true;
  }

  // Env var fallbacks (applied before config merge — CLI + env override config file)
  project = project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  emulator = emulator || process.env.FIRESTORE_EMULATOR_HOST;
  collection = collection || process.env.FIREGRAPH_COLLECTION;
  if (!port && process.env.PORT) port = parseInt(process.env.PORT, 10);

  return { configPath, project, collection, port, emulator, registryPath, viewsPath, readonly };
}

const cliArgs = parseArgs();

// --- Resolved config (populated in init) ---

let resolvedProject: string | undefined;
let resolvedCollection: string;
let resolvedEmulator: string | undefined;
let resolvedRegistryPath: string | undefined;
let resolvedViewsPath: string | undefined;
let resolvedReadonly: boolean;
let resolvedPort: number;
let resolvedConfigPath: string | undefined;
let viewDefaultsData: LoadedConfig['viewDefaults'] | null = null;

// --- State ---

let db: Firestore;
let registry: GraphRegistry;
let schemaMetadata: SchemaMetadata;
let graphClient: GraphClient;
let viewRegistry: ViewRegistry | null = null;
let viewBundle: ViewBundle | null = null;

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
  resolvedRegistryPath = cliArgs.registryPath ?? fileConfig.registry;
  resolvedViewsPath = cliArgs.viewsPath ?? fileConfig.views;
  resolvedReadonly = cliArgs.readonly || (fileConfig.editor?.readonly ?? false);

  const isProduction = process.env.NODE_ENV === 'production';
  resolvedPort = cliArgs.port ?? fileConfig.editor?.port ?? (isProduction ? 3883 : 3884);

  viewDefaultsData = fileConfig.viewDefaults ?? null;

  // 3. Init Firebase with merged values
  if (resolvedEmulator) {
    process.env.FIRESTORE_EMULATOR_HOST = resolvedEmulator;
  }

  const appOptions: Record<string, unknown> = {};
  if (resolvedProject) appOptions.projectId = resolvedProject;

  try {
    if (resolvedEmulator) {
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

  db = getFirestore();

  // 4. Validate required fields
  if (!resolvedRegistryPath) {
    console.error('');
    console.error('  Error: registry path is required.');
    console.error('');
    console.error('  Provide it via firegraph.config.ts or the --registry flag:');
    console.error('');
    console.error('    // firegraph.config.ts');
    console.error('    export default defineConfig({ registry: "./src/registry.ts" });');
    console.error('');
    console.error('    // or CLI:');
    console.error('    npx firegraph editor --registry ./src/registry.ts');
    console.error('');
    process.exit(1);
  }

  // 5. Load registry
  console.log(`  Loading registry from ${resolvedRegistryPath}...`);
  registry = await loadRegistry(resolvedRegistryPath);
  schemaMetadata = introspectRegistry(registry);
  console.log(
    `  Registry loaded: ${schemaMetadata.nodeTypes.length} node types, ${schemaMetadata.edgeTypes.length} edge types`,
  );

  // 6. Load views if provided
  if (resolvedViewsPath) {
    console.log(`  Loading views from ${resolvedViewsPath}...`);
    viewRegistry = await loadViews(resolvedViewsPath);
    const nodeViewCount = Object.values(viewRegistry.nodes).reduce((sum, m) => sum + m.views.length, 0);
    const edgeViewCount = Object.values(viewRegistry.edges).reduce((sum, m) => sum + m.views.length, 0);
    console.log(`  Views loaded: ${nodeViewCount} node views, ${edgeViewCount} edge views`);

    console.log(`  Bundling views for browser...`);
    viewBundle = await bundleViews(resolvedViewsPath);
    console.log(`  Views bundled (${(viewBundle.code.length / 1024).toFixed(1)} KB)`);
  }

  // 7. Create graph client
  graphClient = createGraphClient(db, resolvedCollection, { registry });
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
      }),
    }),
  );

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
    console.log(`  Registry:   ${resolvedRegistryPath}`);
    if (resolvedViewsPath) {
      console.log(`  Views:      ${resolvedViewsPath}`);
    }
    if (viewDefaultsData) {
      const nodeDefaults = Object.keys(viewDefaultsData.nodes ?? {}).length;
      const edgeDefaults = Object.keys(viewDefaultsData.edges ?? {}).length;
      if (nodeDefaults + edgeDefaults > 0) {
        console.log(`  Defaults:   ${nodeDefaults} node types, ${edgeDefaults} edge types`);
      }
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
