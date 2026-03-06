import { build, type Plugin } from 'esbuild';
import path from 'path';
import crypto from 'crypto';
import type { DiscoveryResult } from '../../src/types.js';

export interface ViewBundle {
  code: string;
  hash: string;
}

/**
 * Inline browser-safe shims for `firegraph`, `firegraph/react`, and
 * `firegraph/svelte` imports.
 *
 * View files import from these paths. Rather than bundling the entire
 * firegraph package (which pulls in @google-cloud/firestore, crypto, fs, etc.),
 * we provide virtual modules containing only the browser-safe adapter
 * functions with zero Node.js dependencies.
 *
 * React and Svelte themselves are NOT shimmed — they are resolved from
 * the project's node_modules and bundled by esbuild.
 *
 * Note: firegraph now depends on @google-cloud/firestore (not firebase-admin).
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

      b.onLoad({ filter: /.*/, namespace: SHIM_NAMESPACE }, (args) => {
        let contents: string;
        if (args.path === 'firegraph/react') {
          contents = REACT_ADAPTER_SHIM;
        } else if (args.path === 'firegraph/svelte') {
          contents = SVELTE_ADAPTER_SHIM;
        } else {
          contents = DEFINE_VIEWS_SHIM;
        }
        return { contents, loader: 'js' };
      });
    },
  };
}

/**
 * Browser-safe implementation of `defineViews`.
 * Self-contained copy of the logic from `src/views.ts`.
 */
const DEFINE_VIEWS_SHIM = `
function sanitizeTagPart(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function resilientView(ViewClass, tagName) {
  const Wrapped = class extends ViewClass {
    connectedCallback() {
      try { super.connectedCallback?.(); }
      catch (err) {
        console.warn('[firegraph] <' + tagName + '> connectedCallback error:', err);
        this._showError(err);
      }
    }
    disconnectedCallback() {
      try { super.disconnectedCallback?.(); }
      catch (err) { console.warn('[firegraph] <' + tagName + '> disconnectedCallback error:', err); }
    }
    set data(v) {
      try { super.data = v; }
      catch (err) {
        console.warn('[firegraph] <' + tagName + '> data setter error:', err);
        this._showError(err);
      }
    }
    get data() {
      try { return super.data; } catch { return {}; }
    }
    _showError(err) {
      try {
        this.innerHTML = '<div style="padding:6px;color:#f87171;font-size:11px;font-family:monospace;">' +
          'View error in &lt;' + tagName + '&gt;: ' + (err instanceof Error ? err.message : String(err)) + '</div>';
      } catch {}
    }
  };
  Wrapped.viewName = ViewClass.viewName;
  Wrapped.description = ViewClass.description;
  return Wrapped;
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
      if (registry && !registry.get(tagName)) registry.define(tagName, resilientView(ViewClass, tagName));
    }
    nodes[entityType] = { views: viewMetas, sampleData: config.sampleData };
  }

  for (const [axbType, config] of Object.entries(input.edges ?? {})) {
    const viewMetas = [];
    for (const ViewClass of config.views) {
      const tagName = 'fg-edge-' + sanitizeTagPart(axbType) + '-' + sanitizeTagPart(ViewClass.viewName);
      viewMetas.push({ tagName, viewName: ViewClass.viewName, description: ViewClass.description });
      if (registry && !registry.get(tagName)) registry.define(tagName, resilientView(ViewClass, tagName));
    }
    edges[axbType] = { views: viewMetas, sampleData: config.sampleData };
  }

  return { nodes, edges };
}
`;

/**
 * Browser-safe implementation of `wrapReact` from `firegraph/react`.
 * Lazily imports react and react-dom/client at render time.
 */
const REACT_ADAPTER_SHIM = `
export function wrapReact(Component, meta) {
  let React = null;
  let ReactDOM = null;
  let loaded = false;

  async function ensureReact() {
    if (loaded) return;
    [React, ReactDOM] = await Promise.all([
      import('react'),
      import('react-dom/client'),
    ]);
    loaded = true;
  }

  const Cls = class extends HTMLElement {
    _data = {};
    _root = null;
    _mounted = false;

    set data(v) { this._data = v; this._render(); }
    get data() { return this._data; }

    connectedCallback() { this._mounted = true; this._render(); }
    disconnectedCallback() {
      this._mounted = false;
      if (this._root) { this._root.unmount(); this._root = null; }
    }

    async _render() {
      if (!this._mounted) return;
      await ensureReact();
      if (!this._mounted) return;
      if (!this._root) this._root = ReactDOM.createRoot(this);
      this._root.render(React.createElement(Component, { data: this._data }));
    }
  };
  Cls.viewName = meta.viewName;
  Cls.description = meta.description;
  return Cls;
}
`;

/**
 * Browser-safe implementation of `wrapSvelte` from `firegraph/svelte`.
 * Lazily imports svelte at mount time. Uses Svelte 5 mount/unmount API.
 */
const SVELTE_ADAPTER_SHIM = `
export function wrapSvelte(Component, meta) {
  const Cls = class extends HTMLElement {
    _data = {};
    _instance = null;
    _props = null;
    _mounted = false;

    set data(v) {
      this._data = v;
      if (this._props) { this._props.data = v; }
      else if (this._mounted) { this._mount(); }
    }
    get data() { return this._data; }

    connectedCallback() { this._mounted = true; this._mount(); }
    disconnectedCallback() {
      this._mounted = false;
      if (this._instance) {
        import('svelte').then(({ unmount }) => {
          if (this._instance) { unmount(this._instance); this._instance = null; this._props = null; }
        });
      }
    }

    async _mount() {
      const { mount, unmount } = await import('svelte');
      if (!this._mounted) return;
      if (this._instance) unmount(this._instance);
      this._props = { data: this._data };
      this._instance = mount(Component, { target: this, props: this._props });
    }
  };
  Cls.viewName = meta.viewName;
  Cls.description = meta.description;
  return Cls;
}
`;

/**
 * Try to load the esbuild-svelte plugin for .svelte file compilation.
 * Returns null if esbuild-svelte is not installed.
 */
async function loadSveltePlugin(): Promise<Plugin | null> {
  try {
    const mod = await import('esbuild-svelte');
    const esbuildSvelte = mod.default ?? mod;
    return esbuildSvelte({ compilerOptions: { css: 'injected' } });
  } catch {
    return null;
  }
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

  // Build plugins — always include firegraph shim, optionally add Svelte
  const plugins: Plugin[] = [firegraphBrowserShim()];
  const sveltePlugin = await loadSveltePlugin();
  if (sveltePlugin) plugins.push(sveltePlugin);

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
    plugins,
  });

  const code = result.outputFiles[0].text;
  const hash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 12);

  return { code, hash };
}
