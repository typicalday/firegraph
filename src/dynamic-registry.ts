import { createHash } from 'node:crypto';

import { NODE_RELATION } from './internal/constants.js';
import { createRegistry } from './registry.js';
import { compileMigrations, precompileSource } from './sandbox.js';
import type {
  EdgeTypeData,
  GraphReader,
  GraphRegistry,
  MigrationExecutor,
  NodeTypeData,
  RegistryEntry,
} from './types.js';

// ---------------------------------------------------------------------------
// Meta-type constants
// ---------------------------------------------------------------------------

/** The aType used for node type definition meta-nodes. */
export const META_NODE_TYPE = 'nodeType';

/** The aType used for edge type definition meta-nodes. */
export const META_EDGE_TYPE = 'edgeType';

// ---------------------------------------------------------------------------
// JSON Schemas for meta-type data payloads
// ---------------------------------------------------------------------------

/** JSON Schema for a single stored migration step. */
const STORED_MIGRATION_STEP_SCHEMA = {
  type: 'object',
  required: ['fromVersion', 'toVersion', 'up'],
  properties: {
    fromVersion: { type: 'integer', minimum: 0 },
    toVersion: { type: 'integer', minimum: 1 },
    up: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};

/** JSON Schema for the `data` payload of a `nodeType` meta-node. */
export const NODE_TYPE_SCHEMA: object = {
  type: 'object',
  required: ['name', 'jsonSchema'],
  properties: {
    name: { type: 'string', minLength: 1 },
    jsonSchema: { type: 'object' },
    description: { type: 'string' },
    titleField: { type: 'string' },
    subtitleField: { type: 'string' },
    viewTemplate: { type: 'string' },
    viewCss: { type: 'string' },
    allowedIn: { type: 'array', items: { type: 'string', minLength: 1 } },
    schemaVersion: { type: 'integer', minimum: 0 },
    migrations: { type: 'array', items: STORED_MIGRATION_STEP_SCHEMA },
    migrationWriteBack: { type: 'string', enum: ['off', 'eager', 'background'] },
  },
  additionalProperties: false,
};

/** JSON Schema for the `data` payload of an `edgeType` meta-node. */
export const EDGE_TYPE_SCHEMA: object = {
  type: 'object',
  required: ['name', 'from', 'to'],
  properties: {
    name: { type: 'string', minLength: 1 },
    from: {
      oneOf: [
        { type: 'string', minLength: 1 },
        { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
      ],
    },
    to: {
      oneOf: [
        { type: 'string', minLength: 1 },
        { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
      ],
    },
    jsonSchema: { type: 'object' },
    inverseLabel: { type: 'string' },
    description: { type: 'string' },
    titleField: { type: 'string' },
    subtitleField: { type: 'string' },
    viewTemplate: { type: 'string' },
    viewCss: { type: 'string' },
    allowedIn: { type: 'array', items: { type: 'string', minLength: 1 } },
    targetGraph: { type: 'string', minLength: 1, pattern: '^[^/]+$' },
    schemaVersion: { type: 'integer', minimum: 0 },
    migrations: { type: 'array', items: STORED_MIGRATION_STEP_SCHEMA },
    migrationWriteBack: { type: 'string', enum: ['off', 'eager', 'background'] },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Bootstrap registry
// ---------------------------------------------------------------------------

/** Registry entries for the two meta-types (always present). */
export const BOOTSTRAP_ENTRIES: readonly RegistryEntry[] = [
  {
    aType: META_NODE_TYPE,
    axbType: NODE_RELATION,
    bType: META_NODE_TYPE,
    jsonSchema: NODE_TYPE_SCHEMA,
    description: 'Meta-type: defines a node type',
  },
  {
    aType: META_EDGE_TYPE,
    axbType: NODE_RELATION,
    bType: META_EDGE_TYPE,
    jsonSchema: EDGE_TYPE_SCHEMA,
    description: 'Meta-type: defines an edge type',
  },
];

/**
 * Build the bootstrap registry that validates meta-type writes.
 * This is always available, even before any dynamic types are loaded.
 *
 * Memoized at module scope: `BOOTSTRAP_ENTRIES` is a `readonly` array
 * of module-level constants and `createRegistry` is pure over them, so
 * the resulting registry — including its compiled cfworker
 * `Validator`s — can be reused across every `GraphClientImpl`
 * constructor. This matters on Cloudflare Workers, where the dynamic
 * client constructor runs on every request that touches the
 * meta-registry path; without memoization we'd re-walk +
 * re-dereference these schemas per request.
 */
let _bootstrapRegistry: GraphRegistry | null = null;
export function createBootstrapRegistry(): GraphRegistry {
  if (_bootstrapRegistry) return _bootstrapRegistry;
  _bootstrapRegistry = createRegistry([...BOOTSTRAP_ENTRIES]);
  return _bootstrapRegistry;
}

// ---------------------------------------------------------------------------
// Deterministic UID generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic UID for a meta-type definition.
 * This ensures that defining the same type name always targets the same
 * Firestore document, enabling upsert semantics.
 *
 * Format: 21-char base64url substring of SHA-256(`metaType:name`).
 */
export function generateDeterministicUid(metaType: string, name: string): string {
  const hash = createHash('sha256').update(`${metaType}:${name}`).digest('base64url');
  return hash.slice(0, 21);
}

// ---------------------------------------------------------------------------
// createRegistryFromGraph
// ---------------------------------------------------------------------------

/**
 * Read meta-type nodes from the graph and compile them into a GraphRegistry.
 *
 * The returned registry includes both the dynamic entries AND the bootstrap
 * meta-type entries, so meta-type writes remain validateable after a reload.
 *
 * @param reader - A GraphReader pointed at the collection containing meta-nodes.
 * @param executor - Optional custom executor for compiling stored migration source strings.
 */
export async function createRegistryFromGraph(
  reader: GraphReader,
  executor?: MigrationExecutor,
): Promise<GraphRegistry> {
  const [nodeTypes, edgeTypes] = await Promise.all([
    reader.findNodes({ aType: META_NODE_TYPE }),
    reader.findNodes({ aType: META_EDGE_TYPE }),
  ]);

  const entries: RegistryEntry[] = [...BOOTSTRAP_ENTRIES];

  // Eagerly pre-validate all migration sources in the sandbox before building
  // the registry. This ensures reloadRegistry() fails fast on invalid sources.
  const prevalidations: Promise<void>[] = [];
  for (const record of nodeTypes) {
    const data = record.data as unknown as NodeTypeData;
    if (data.migrations) {
      for (const m of data.migrations) {
        prevalidations.push(precompileSource(m.up, executor));
      }
    }
  }
  for (const record of edgeTypes) {
    const data = record.data as unknown as EdgeTypeData;
    if (data.migrations) {
      for (const m of data.migrations) {
        prevalidations.push(precompileSource(m.up, executor));
      }
    }
  }
  await Promise.all(prevalidations);

  // Convert nodeType records → self-loop RegistryEntries
  for (const record of nodeTypes) {
    const data = record.data as unknown as NodeTypeData;
    entries.push({
      aType: data.name,
      axbType: NODE_RELATION,
      bType: data.name,
      jsonSchema: data.jsonSchema,
      description: data.description,
      titleField: data.titleField,
      subtitleField: data.subtitleField,
      allowedIn: data.allowedIn,
      migrations: data.migrations ? compileMigrations(data.migrations, executor) : undefined,
      migrationWriteBack: data.migrationWriteBack,
    });
  }

  // Convert edgeType records → RegistryEntries (expand from/to arrays)
  for (const record of edgeTypes) {
    const data = record.data as unknown as EdgeTypeData;
    const fromTypes = Array.isArray(data.from) ? data.from : [data.from];
    const toTypes = Array.isArray(data.to) ? data.to : [data.to];

    const compiledMigrations = data.migrations
      ? compileMigrations(data.migrations, executor)
      : undefined;

    for (const aType of fromTypes) {
      for (const bType of toTypes) {
        entries.push({
          aType,
          axbType: data.name,
          bType,
          jsonSchema: data.jsonSchema,
          description: data.description,
          inverseLabel: data.inverseLabel,
          titleField: data.titleField,
          subtitleField: data.subtitleField,
          allowedIn: data.allowedIn,
          targetGraph: data.targetGraph,
          migrations: compiledMigrations,
          migrationWriteBack: data.migrationWriteBack,
        });
      }
    }
  }

  return createRegistry(entries);
}
