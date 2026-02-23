/**
 * Firegraph Configuration — project-level config file support.
 *
 * Projects create a `firegraph.config.ts` (or `.js`/`.mjs`) in their root:
 *
 * @example
 * ```ts
 * import { defineConfig } from 'firegraph';
 *
 * export default defineConfig({
 *   entities: './entities',
 *   project: 'my-project',
 *   collection: 'graph',
 * });
 * ```
 */

// ---------------------------------------------------------------------------
// View Resolution Types
// ---------------------------------------------------------------------------

/** Display contexts where views can appear. */
export type ViewContext = 'listing' | 'detail' | 'inline';

/** View resolution configuration for a single entity type. */
export interface ViewResolverConfig {
  /** Default view name (e.g. 'card'). Falls back to 'json' if unset. */
  default?: string;
  /** View to use in NodeBrowser listing rows. */
  listing?: string;
  /** View to use on the NodeDetail page. */
  detail?: string;
  /** View to use for inline/embedded previews (edge rows, traversal). */
  inline?: string;
}

/** Declarative view defaults, keyed by entity type. */
export interface ViewDefaultsConfig {
  /** Node view defaults keyed by aType (e.g. 'user', 'task'). */
  nodes?: Record<string, ViewResolverConfig>;
  /** Edge view defaults keyed by abType (e.g. 'hasDeparture'). */
  edges?: Record<string, ViewResolverConfig>;
}

// ---------------------------------------------------------------------------
// Config Shape
// ---------------------------------------------------------------------------

/** Project-level firegraph configuration. */
export interface FiregraphConfig {
  /** Path to entities directory (per-entity folder convention). */
  entities?: string;
  /** GCP project ID. */
  project?: string;
  /** Firestore collection path (default: 'graph'). */
  collection?: string;
  /** Firestore emulator address (e.g. '127.0.0.1:8080'). */
  emulator?: string;

  /** Editor-specific settings. */
  editor?: {
    /** Server port (default: 3883). */
    port?: number;
    /** Force read-only mode. */
    readonly?: boolean;
  };

  /** Declarative view defaults per entity type (overrides per-entity meta.json). */
  viewDefaults?: ViewDefaultsConfig;
}

// ---------------------------------------------------------------------------
// defineConfig()
// ---------------------------------------------------------------------------

/**
 * Identity function providing type-checking and autocomplete for config files.
 *
 * @example
 * ```ts
 * import { defineConfig } from 'firegraph';
 * export default defineConfig({ entities: './entities' });
 * ```
 */
export function defineConfig(config: FiregraphConfig): FiregraphConfig {
  return config;
}

// ---------------------------------------------------------------------------
// View Resolution (pure — works client-side and server-side)
// ---------------------------------------------------------------------------

/**
 * Resolve which view to show for a given entity.
 *
 * 1. If `context` is provided and a context-specific default exists, use it.
 * 2. Falls back to `resolverConfig.default`.
 * 3. Ultimate fallback: `'json'`.
 *
 * Only returns view names that exist in `availableViewNames`.
 */
export function resolveView(
  resolverConfig: ViewResolverConfig | undefined,
  availableViewNames: string[],
  context?: ViewContext,
): string {
  if (!resolverConfig) return 'json';

  const available = new Set(availableViewNames);

  if (context) {
    const contextDefault = resolverConfig[context];
    if (contextDefault && available.has(contextDefault)) {
      return contextDefault;
    }
  }

  if (resolverConfig.default && available.has(resolverConfig.default)) {
    return resolverConfig.default;
  }

  return 'json';
}
