/**
 * Model Views — framework-agnostic view definitions for graph entities.
 *
 * Projects define Web Components that render entity data in purpose-driven
 * ways. Each view class declares a static `viewName`, and receives the
 * entity's `data` payload via a `data` property setter.
 *
 * @example
 * ```ts
 * import { defineViews } from 'firegraph';
 *
 * class UserCard extends HTMLElement {
 *   static viewName = 'card';
 *   static description = 'Compact user card';
 *   private _data: Record<string, unknown> = {};
 *   set data(v: Record<string, unknown>) { this._data = v; this.render(); }
 *   connectedCallback() { this.render(); }
 *   private render() {
 *     this.innerHTML = `<strong>${this._data.displayName ?? ''}</strong>`;
 *   }
 * }
 *
 * export default defineViews({
 *   nodes: { user: { views: [UserCard] } },
 * });
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A Web Component class used as a view. The class must have a static
 * `viewName` and must be constructable. It will be registered as a custom
 * element via `customElements.define()` in browser environments.
 *
 * Note: this interface avoids referencing `HTMLElement` directly so the
 * library can compile without DOM lib types. Consumer code (which has DOM)
 * will satisfy this constraint naturally.
 */
export interface ViewComponentClass {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (...args: any[]): { data: Record<string, unknown> };
  /** Short identifier for this view (e.g. 'card', 'profile'). */
  viewName: string;
  /** Optional human-readable description. */
  description?: string;
}

/** Configuration for all views of a single entity type. */
export interface EntityViewConfig {
  /** View component classes to register. */
  views: ViewComponentClass[];
  /**
   * Optional sample data for the Storybook gallery, keyed by viewName.
   * If a viewName is not present the gallery will use an empty object.
   */
  sampleData?: Record<string, Record<string, unknown>>;
}

/** Input shape accepted by `defineViews()`. */
export interface ViewRegistryInput {
  /** Node views keyed by aType (e.g. 'user', 'tour'). */
  nodes?: Record<string, EntityViewConfig>;
  /** Edge views keyed by abType (e.g. 'hasDeparture'). */
  edges?: Record<string, EntityViewConfig>;
}

/** Serialisable metadata for a single view. */
export interface ViewMeta {
  /** Custom element tag name (e.g. 'fg-user-card'). */
  tagName: string;
  /** Short identifier matching the component's static viewName. */
  viewName: string;
  /** Optional human-readable description. */
  description?: string;
}

/** Serialisable metadata for all views of a single entity type. */
export interface EntityViewMeta {
  views: ViewMeta[];
  sampleData?: Record<string, Record<string, unknown>>;
}

/** The resolved view registry returned by `defineViews()`. */
export interface ViewRegistry {
  nodes: Record<string, EntityViewMeta>;
  edges: Record<string, EntityViewMeta>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitise a string for use as part of a custom element tag name. */
function sanitizeTagPart(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Minimal interface for CustomElementRegistry (avoids depending on DOM lib). */
interface CustomElementRegistryLike {
  get(name: string): unknown;
  define(name: string, constructor: unknown): void;
}

/**
 * Try to access the browser's `customElements` registry.
 * Returns `null` in Node.js or environments without Web Components support.
 */
function getCustomElements(): CustomElementRegistryLike | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.customElements && typeof g.customElements.define === 'function') {
    return g.customElements as CustomElementRegistryLike;
  }
  return null;
}

// ---------------------------------------------------------------------------
// defineViews()
// ---------------------------------------------------------------------------

/**
 * Build a `ViewRegistry` from component classes.
 *
 * In the browser the components are registered as custom elements with
 * deterministic tag names (`fg-{entityType}-{viewName}`). On the server
 * (Node.js) only metadata is returned — no custom element registration.
 */
export function defineViews(input: ViewRegistryInput): ViewRegistry {
  const nodes: Record<string, EntityViewMeta> = {};
  const edges: Record<string, EntityViewMeta> = {};
  const registry = getCustomElements();

  // --- nodes ---
  for (const [entityType, config] of Object.entries(input.nodes ?? {})) {
    const viewMetas: ViewMeta[] = [];
    for (const ViewClass of config.views) {
      const tagName = `fg-${sanitizeTagPart(entityType)}-${sanitizeTagPart(ViewClass.viewName)}`;
      viewMetas.push({
        tagName,
        viewName: ViewClass.viewName,
        description: ViewClass.description,
      });
      if (registry && !registry.get(tagName)) {
        registry.define(tagName, ViewClass);
      }
    }
    nodes[entityType] = {
      views: viewMetas,
      sampleData: config.sampleData,
    };
  }

  // --- edges ---
  for (const [abType, config] of Object.entries(input.edges ?? {})) {
    const viewMetas: ViewMeta[] = [];
    for (const ViewClass of config.views) {
      const tagName = `fg-edge-${sanitizeTagPart(abType)}-${sanitizeTagPart(ViewClass.viewName)}`;
      viewMetas.push({
        tagName,
        viewName: ViewClass.viewName,
        description: ViewClass.description,
      });
      if (registry && !registry.get(tagName)) {
        registry.define(tagName, ViewClass);
      }
    }
    edges[abType] = {
      views: viewMetas,
      sampleData: config.sampleData,
    };
  }

  return { nodes, edges };
}
