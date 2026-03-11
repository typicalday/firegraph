/**
 * Entity Discovery — convention-based auto-discovery of entities from
 * a per-entity folder structure.
 *
 * Scans `entitiesDir/nodes/` and `entitiesDir/edges/` subdirectories.
 * Each subfolder is treated as an entity type.
 *
 * Schema files can be either `schema.json` (plain JSON Schema) or
 * `schema.ts` / `schema.js` (a module whose default export is a JSON Schema
 * object). When both exist, the TS/JS file takes precedence so that authors
 * can compose schemas programmatically while keeping a JSON fallback.
 *
 * @example
 * ```
 * entities/
 *   nodes/
 *     task/
 *       schema.json | schema.ts   (required — one or both)
 *       views.ts                  (optional)
 *       sample.json               (optional)
 *       meta.json                 (optional)
 *   edges/
 *     hasStep/
 *       schema.json | schema.ts   (required — one or both)
 *       edge.json                 (required — topology)
 *       views.ts                  (optional)
 *       sample.json               (optional)
 *       meta.json                 (optional)
 * ```
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { DiscoveredEntity, DiscoveryResult, EdgeTopology } from './types.js';
import type { ViewResolverConfig } from './config.js';
import { FiregraphError } from './errors.js';

export class DiscoveryError extends FiregraphError {
  constructor(message: string) {
    super(message, 'DISCOVERY_ERROR');
    this.name = 'DiscoveryError';
  }
}

// ---------------------------------------------------------------------------
// JSON parsing helpers
// ---------------------------------------------------------------------------

function readJson(filePath: string): unknown {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof SyntaxError
      ? `Invalid JSON in ${filePath}: ${err.message}`
      : `Cannot read ${filePath}: ${(err as Error).message}`;
    throw new DiscoveryError(msg);
  }
}

function readJsonIfExists(filePath: string): unknown | undefined {
  if (!existsSync(filePath)) return undefined;
  return readJson(filePath);
}

// ---------------------------------------------------------------------------
// Schema file loading (JSON or TS/JS via jiti)
// ---------------------------------------------------------------------------

const SCHEMA_SCRIPT_EXTENSIONS = ['.ts', '.js', '.mts', '.mjs'];

/**
 * Attempt to load a schema from a TS/JS module (default export) or fall back
 * to schema.json. Returns the parsed schema object or throws.
 */
function loadSchema(dir: string, entityLabel: string): object {
  // Prefer TS/JS schema — allows programmatic composition & shared definitions
  for (const ext of SCHEMA_SCRIPT_EXTENSIONS) {
    const candidate = join(dir, `schema${ext}`);
    if (existsSync(candidate)) {
      return loadSchemaModule(candidate, entityLabel);
    }
  }

  // Fall back to schema.json
  const jsonPath = join(dir, 'schema.json');
  if (existsSync(jsonPath)) {
    return readJson(jsonPath) as object;
  }

  throw new DiscoveryError(
    `Missing schema for ${entityLabel} in ${dir}. ` +
      'Provide a schema.ts (or .js/.mts/.mjs) or schema.json file.',
  );
}

let _jiti: ((id: string) => unknown) | undefined;

function getJiti(): (id: string) => unknown {
  if (!_jiti) {
    const base = typeof __filename !== 'undefined' ? __filename : import.meta.url;
    const esmRequire = createRequire(base);
    const { createJiti } = esmRequire('jiti') as typeof import('jiti');
    _jiti = createJiti(base, { interopDefault: true });
  }
  return _jiti;
}

function loadSchemaModule(filePath: string, entityLabel: string): object {
  try {
    const jiti = getJiti();
    const mod = jiti(filePath) as { default?: unknown } | unknown;
    const schema = (mod && typeof mod === 'object' && 'default' in mod)
      ? (mod as { default: unknown }).default
      : mod;

    if (!schema || typeof schema !== 'object') {
      throw new DiscoveryError(
        `Schema file ${filePath} for ${entityLabel} must default-export a JSON Schema object.`,
      );
    }
    return schema as object;
  } catch (err: unknown) {
    if (err instanceof DiscoveryError) throw err;
    throw new DiscoveryError(
      `Failed to load schema module ${filePath} for ${entityLabel}: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// View file detection
// ---------------------------------------------------------------------------

const VIEW_EXTENSIONS = ['.ts', '.js', '.mts', '.mjs'];

function findViewsFile(dir: string): string | undefined {
  for (const ext of VIEW_EXTENSIONS) {
    const candidate = join(dir, `views${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entity loaders
// ---------------------------------------------------------------------------

function loadNodeEntity(dir: string, name: string): DiscoveredEntity {
  const schema = loadSchema(dir, `node type "${name}"`);
  const meta = readJsonIfExists(join(dir, 'meta.json')) as
    | { description?: string; titleField?: string; subtitleField?: string; viewDefaults?: ViewResolverConfig }
    | undefined;
  const sampleData = readJsonIfExists(join(dir, 'sample.json')) as
    | Record<string, unknown>
    | undefined;
  const viewsPath = findViewsFile(dir);

  return {
    kind: 'node',
    name,
    schema,
    description: meta?.description,
    titleField: meta?.titleField,
    subtitleField: meta?.subtitleField,
    viewDefaults: meta?.viewDefaults,
    viewsPath,
    sampleData,
  };
}

function loadEdgeEntity(dir: string, name: string): DiscoveredEntity {
  const schema = loadSchema(dir, `edge type "${name}"`);

  const edgePath = join(dir, 'edge.json');
  if (!existsSync(edgePath)) {
    throw new DiscoveryError(
      `Missing edge.json for edge type "${name}" in ${dir}. ` +
        'Edge entities must declare topology (from/to node types).',
    );
  }
  const topology = readJson(edgePath) as EdgeTopology;

  // Validate topology shape
  if (!topology.from) {
    throw new DiscoveryError(
      `edge.json for "${name}" is missing required "from" field`,
    );
  }
  if (!topology.to) {
    throw new DiscoveryError(
      `edge.json for "${name}" is missing required "to" field`,
    );
  }

  const meta = readJsonIfExists(join(dir, 'meta.json')) as
    | { description?: string; titleField?: string; subtitleField?: string; viewDefaults?: ViewResolverConfig }
    | undefined;
  const sampleData = readJsonIfExists(join(dir, 'sample.json')) as
    | Record<string, unknown>
    | undefined;
  const viewsPath = findViewsFile(dir);

  return {
    kind: 'edge',
    name,
    schema,
    topology,
    description: meta?.description,
    titleField: meta?.titleField,
    subtitleField: meta?.subtitleField,
    viewDefaults: meta?.viewDefaults,
    viewsPath,
    sampleData,
  };
}

// ---------------------------------------------------------------------------
// Directory scanner
// ---------------------------------------------------------------------------

function getSubdirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DiscoveryWarning {
  code: 'DANGLING_TOPOLOGY_REF';
  message: string;
}

export interface DiscoverResult {
  result: DiscoveryResult;
  warnings: DiscoveryWarning[];
}

/**
 * Scan an entities directory and return all discovered nodes and edges.
 *
 * @param entitiesDir - Path to the entities directory (absolute or relative to cwd)
 * @returns Discovery result with nodes and edges maps, plus any warnings
 */
export function discoverEntities(entitiesDir: string): DiscoverResult {
  const absDir = resolve(entitiesDir);

  if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
    throw new DiscoveryError(`Entities directory not found: ${entitiesDir}`);
  }

  const nodes = new Map<string, DiscoveredEntity>();
  const edges = new Map<string, DiscoveredEntity>();
  const warnings: DiscoveryWarning[] = [];

  // Discover nodes
  const nodesDir = join(absDir, 'nodes');
  for (const name of getSubdirectories(nodesDir)) {
    nodes.set(name, loadNodeEntity(join(nodesDir, name), name));
  }

  // Discover edges
  const edgesDir = join(absDir, 'edges');
  for (const name of getSubdirectories(edgesDir)) {
    edges.set(name, loadEdgeEntity(join(edgesDir, name), name));
  }

  // Validate topology references
  const nodeNames = new Set(nodes.keys());
  for (const [axbType, entity] of edges) {
    const topology = entity.topology!;
    const fromTypes = Array.isArray(topology.from) ? topology.from : [topology.from];
    const toTypes = Array.isArray(topology.to) ? topology.to : [topology.to];

    for (const ref of [...fromTypes, ...toTypes]) {
      if (!nodeNames.has(ref)) {
        warnings.push({
          code: 'DANGLING_TOPOLOGY_REF',
          message: `Edge "${axbType}" references node type "${ref}" which was not found in the nodes directory`,
        });
      }
    }
  }

  return {
    result: { nodes, edges },
    warnings,
  };
}
