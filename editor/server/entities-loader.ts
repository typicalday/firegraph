/**
 * Entity discovery + view loading for the editor server.
 *
 * Wraps the core `discoverEntities()` with editor-specific concerns:
 * - Loads view classes from per-entity `views.ts` files via jiti
 * - Assembles a `ViewRegistry` from individual entities
 * - Merges entity-level view defaults with config-level overrides
 */

import Module from 'node:module';

import { createJiti } from 'jiti';

import type { ViewDefaultsConfig } from '../../src/config.js';
import type { DiscoveryResult } from '../../src/types.js';
import type {
  EntityViewMeta,
  ViewComponentClass,
  ViewMeta,
  ViewRegistry,
} from '../../src/views.js';

// Stub .svelte imports so jiti/require don't crash when a views.ts file
// imports a Svelte component. The actual Svelte compilation happens in
// the esbuild browser bundle — the server only needs the metadata
// (viewName, description) which comes from the wrapSvelte() meta arg.

const extensions = (Module as any)._extensions;
if (extensions && !extensions['.svelte']) {
  extensions['.svelte'] = (_module: any, filename: string) => {
    _module._compile('module.exports = {};', filename);
  };
}

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

// ---------------------------------------------------------------------------
// View class loading
// ---------------------------------------------------------------------------

export function sanitizeTagPart(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Load view classes from a per-entity `views.ts` file.
 * Accepts default export (array) or named `views` export.
 */
export async function loadViewClasses(viewsPath: string): Promise<ViewComponentClass[]> {
  // Shim HTMLElement for Node.js (views extend it)
  const hadHtmlElement = 'HTMLElement' in globalThis;
  if (!hadHtmlElement) {
    (globalThis as Record<string, unknown>).HTMLElement = class {};
  }

  try {
    const mod = await jiti.import(viewsPath);
    const exported = mod as Record<string, unknown>;

    // Default export (array of classes)
    if (Array.isArray(exported.default)) return exported.default as ViewComponentClass[];
    if (Array.isArray(exported.views)) return exported.views as ViewComponentClass[];

    // Single default export that is an array
    if (Array.isArray(exported)) return exported as ViewComponentClass[];

    return [];
  } finally {
    if (!hadHtmlElement) {
      delete (globalThis as Record<string, unknown>).HTMLElement;
    }
  }
}

// ---------------------------------------------------------------------------
// Build ViewRegistry from discovery
// ---------------------------------------------------------------------------

export async function buildViewRegistryFromDiscovery(
  discovery: DiscoveryResult,
): Promise<ViewRegistry | null> {
  const nodes: Record<string, EntityViewMeta> = {};
  const edges: Record<string, EntityViewMeta> = {};
  let totalViews = 0;

  for (const [name, entity] of discovery.nodes) {
    if (!entity.viewsPath) continue;
    const viewClasses = await loadViewClasses(entity.viewsPath);
    if (viewClasses.length === 0) continue;

    const viewMetas: ViewMeta[] = viewClasses.map((vc) => ({
      tagName: `fg-${sanitizeTagPart(name)}-${sanitizeTagPart(vc.viewName)}`,
      viewName: vc.viewName,
      description: vc.description,
    }));

    nodes[name] = {
      views: viewMetas,
      sampleData: entity.sampleData,
    };
    totalViews += viewMetas.length;
  }

  for (const [axbType, entity] of discovery.edges) {
    if (!entity.viewsPath) continue;
    const viewClasses = await loadViewClasses(entity.viewsPath);
    if (viewClasses.length === 0) continue;

    const viewMetas: ViewMeta[] = viewClasses.map((vc) => ({
      tagName: `fg-edge-${sanitizeTagPart(axbType)}-${sanitizeTagPart(vc.viewName)}`,
      viewName: vc.viewName,
      description: vc.description,
    }));

    edges[axbType] = {
      views: viewMetas,
      sampleData: entity.sampleData,
    };
    totalViews += viewMetas.length;
  }

  if (totalViews === 0) return null;
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Merge view defaults from entity meta.json + config overrides
// ---------------------------------------------------------------------------

export function mergeViewDefaults(
  discovery: DiscoveryResult,
  configDefaults: ViewDefaultsConfig | undefined | null,
): ViewDefaultsConfig | null {
  const nodes: Record<string, NonNullable<ViewDefaultsConfig['nodes']>[string]> = {};
  const edges: Record<string, NonNullable<ViewDefaultsConfig['edges']>[string]> = {};

  // Collect entity-level defaults from meta.json
  for (const [name, entity] of discovery.nodes) {
    if (entity.viewDefaults) nodes[name] = { ...entity.viewDefaults };
  }
  for (const [name, entity] of discovery.edges) {
    if (entity.viewDefaults) edges[name] = { ...entity.viewDefaults };
  }

  // Override with config-level defaults
  if (configDefaults?.nodes) {
    for (const [name, config] of Object.entries(configDefaults.nodes)) {
      nodes[name] = {
        ...nodes[name],
        ...config,
      };
    }
  }
  if (configDefaults?.edges) {
    for (const [name, config] of Object.entries(configDefaults.edges)) {
      edges[name] = {
        ...edges[name],
        ...config,
      };
    }
  }

  const hasDefaults = Object.keys(nodes).length > 0 || Object.keys(edges).length > 0;
  if (!hasDefaults) return null;

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Collect view file paths for bundling
// ---------------------------------------------------------------------------

export function collectViewPaths(discovery: DiscoveryResult): string[] {
  const paths: string[] = [];
  for (const entity of [...discovery.nodes.values(), ...discovery.edges.values()]) {
    if (entity.viewsPath) paths.push(entity.viewsPath);
  }
  return paths;
}

export { discoverEntities } from '../../src/discover.js';
