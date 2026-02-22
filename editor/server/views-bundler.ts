import { build, type Plugin } from 'esbuild';
import path from 'path';
import crypto from 'crypto';

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
