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
 *   registry: './src/registry.ts',
 *   views: './src/views.ts',
 *   collection: 'graph',
 *   viewDefaults: {
 *     nodes: {
 *       task: {
 *         default: 'card',
 *         rules: [
 *           { when: { status: 'completed' }, view: 'summary' },
 *         ],
 *       },
 *     },
 *   },
 * });
 * ```
 */

// ---------------------------------------------------------------------------
// View Resolution Types
// ---------------------------------------------------------------------------

/** A single conditional view rule. First match wins. */
export interface ViewRule {
  /** Field-value conditions that must ALL match the entity's data. */
  when: Record<string, unknown>;
  /** View name to show when conditions match. */
  view: string;
}

/** View resolution configuration for a single entity type. */
export interface ViewResolverConfig {
  /** Default view name (e.g. 'card'). Falls back to 'json' if unset. */
  default?: string;
  /** Ordered rules — first match wins. */
  rules?: ViewRule[];
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
  /** Path to TypeScript file exporting a GraphRegistry. */
  registry?: string;
  /** Path to TypeScript file exporting views via defineViews(). */
  views?: string;
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

  /** Declarative view resolution rules. */
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
 * export default defineConfig({ registry: './src/registry.ts' });
 * ```
 */
export function defineConfig(config: FiregraphConfig): FiregraphConfig {
  return config;
}

// ---------------------------------------------------------------------------
// View Resolution (pure — works client-side and server-side)
// ---------------------------------------------------------------------------

/**
 * Resolve which view to show for a given entity's data.
 *
 * 1. Evaluates rules in order — first rule where ALL `when` pairs match wins.
 * 2. Falls back to `resolverConfig.default` if no rule matched.
 * 3. Ultimate fallback: `'json'`.
 *
 * Only returns view names that exist in `availableViewNames`.
 */
export function resolveView(
  data: Record<string, unknown>,
  resolverConfig: ViewResolverConfig | undefined,
  availableViewNames: string[],
): string {
  if (!resolverConfig) return 'json';

  const available = new Set(availableViewNames);

  if (resolverConfig.rules) {
    for (const rule of resolverConfig.rules) {
      if (matchesConditions(data, rule.when) && available.has(rule.view)) {
        return rule.view;
      }
    }
  }

  if (resolverConfig.default && available.has(resolverConfig.default)) {
    return resolverConfig.default;
  }

  return 'json';
}

function matchesConditions(
  data: Record<string, unknown>,
  when: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(when)) {
    if (data[key] !== expected) return false;
  }
  return true;
}
