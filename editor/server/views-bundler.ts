import { build, type Plugin } from 'esbuild';
import path from 'path';
import crypto from 'crypto';
import type { DiscoveryResult } from '../../src/types.js';

export interface ViewBundle {
  code: string;
  hash: string;
}

/**
 * Inline browser-safe shim for the `firegraph` import.
 *
 * View files only use `defineViews` from firegraph. Rather than bundling
 * the entire firegraph package (which pulls in firebase-admin, crypto, fs,
 * etc.), we provide a virtual module containing just `defineViews` — a pure
 * browser function with zero Node.js dependencies.
 */
function firegraphBrowserShim(): Plugin {
  const SHIM_NAMESPACE = 'firegraph-browser-shim';

  return {
    name: 'firegraph-browser-shim',
    setup(b) {
      // Intercept bare 'firegraph' and 'firegraph/*' imports
      b.onResolve({ filter: /^firegraph(\/.*)?$/ }, (args) => ({
        path: args.path,
        namespace: SHIM_NAMESPACE,
      }));

      b.onLoad({ filter: /.*/, namespace: SHIM_NAMESPACE }, () => ({
        contents: DEFINE_VIEWS_SHIM,
        loader: 'js',
      }));
    },
  };
}

/**
 * Browser-safe implementation of `defineViews`.
 * This is a self-contained copy of the logic from `src/views.ts` that
 * runs purely in the browser (no Node.js builtins).
 */
const DEFINE_VIEWS_SHIM = `
function sanitizeTagPart(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function defineViews(input) {
  const nodes = {};
  const edges = {};
  const registry = (typeof customElements !== 'undefined' && typeof customElements.define === 'function')
    ? customElements : null;

  for (const [entityType, config] of Object.entries(input.nodes ?? {})) {
    const viewMetas = [];
    for (const ViewClass of config.views) {
      const tagName = 'fg-' + sanitizeTagPart(entityType) + '-' + sanitizeTagPart(ViewClass.viewName);
      viewMetas.push({ tagName, viewName: ViewClass.viewName, description: ViewClass.description });
      if (registry && !registry.get(tagName)) registry.define(tagName, ViewClass);
    }
    nodes[entityType] = { views: viewMetas, sampleData: config.sampleData };
  }

  for (const [abType, config] of Object.entries(input.edges ?? {})) {
    const viewMetas = [];
    for (const ViewClass of config.views) {
      const tagName = 'fg-edge-' + sanitizeTagPart(abType) + '-' + sanitizeTagPart(ViewClass.viewName);
      viewMetas.push({ tagName, viewName: ViewClass.viewName, description: ViewClass.description });
      if (registry && !registry.get(tagName)) registry.define(tagName, ViewClass);
    }
    edges[abType] = { views: viewMetas, sampleData: config.sampleData };
  }

  return { nodes, edges };
}
`;

/**
 * Bundle the user's views file into a browser-compatible ES module.
 * The resulting code registers custom elements when loaded via `<script type="module">`.
 */
export async function bundleViews(viewsPath: string): Promise<ViewBundle> {
  const absolutePath = path.resolve(process.cwd(), viewsPath);

  const result = await build({
    entryPoints: [absolutePath],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    minify: true,
    sourcemap: false,
    plugins: [firegraphBrowserShim()],
  });

  const code = result.outputFiles[0].text;
  const hash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 12);

  return { code, hash };
}

/**
 * Bundle multiple per-entity view files into a single browser-compatible ES module.
 * Creates a synthetic entry point that imports all view files and calls defineViews().
 */
export async function bundleEntityViews(discovery: DiscoveryResult): Promise<ViewBundle | null> {
  // Collect all view file paths with their entity info
  const nodeViews: Array<{ name: string; absPath: string }> = [];
  const edgeViews: Array<{ name: string; absPath: string }> = [];

  for (const [name, entity] of discovery.nodes) {
    if (entity.viewsPath) {
      nodeViews.push({ name, absPath: path.resolve(entity.viewsPath) });
    }
  }
  for (const [name, entity] of discovery.edges) {
    if (entity.viewsPath) {
      edgeViews.push({ name, absPath: path.resolve(entity.viewsPath) });
    }
  }

  if (nodeViews.length === 0 && edgeViews.length === 0) return null;

  // Generate synthetic entry that imports all views and calls defineViews()
  const imports: string[] = [];
  const nodeEntries: string[] = [];
  const edgeEntries: string[] = [];

  nodeViews.forEach(({ name, absPath }, i) => {
    const varName = `nodeViews_${i}`;
    imports.push(`import ${varName} from '${absPath.replace(/\\/g, '/')}';`);
    nodeEntries.push(`    '${name}': { views: Array.isArray(${varName}) ? ${varName} : ${varName}.default || [] }`);
  });

  edgeViews.forEach(({ name, absPath }, i) => {
    const varName = `edgeViews_${i}`;
    imports.push(`import ${varName} from '${absPath.replace(/\\/g, '/')}';`);
    edgeEntries.push(`    '${name}': { views: Array.isArray(${varName}) ? ${varName} : ${varName}.default || [] }`);
  });

  const syntheticEntry = `
${imports.join('\n')}
import { defineViews } from 'firegraph';

defineViews({
  nodes: {
${nodeEntries.join(',\n')}
  },
  edges: {
${edgeEntries.join(',\n')}
  }
});
`;

  const result = await build({
    stdin: {
      contents: syntheticEntry,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    minify: true,
    sourcemap: false,
    plugins: [firegraphBrowserShim()],
  });

  const code = result.outputFiles[0].text;
  const hash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 12);

  return { code, hash };
}
