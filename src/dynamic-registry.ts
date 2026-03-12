import { createHash } from 'node:crypto';
import { createRegistry } from './registry.js';
import { NODE_RELATION } from './internal/constants.js';
import type {
  GraphReader,
  GraphRegistry,
  RegistryEntry,
  NodeTypeData,
  EdgeTypeData,
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
 */
export function createBootstrapRegistry(): GraphRegistry {
  return createRegistry([...BOOTSTRAP_ENTRIES]);
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
  const hash = createHash('sha256')
    .update(`${metaType}:${name}`)
    .digest('base64url');
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
 */
export async function createRegistryFromGraph(
  reader: GraphReader,
): Promise<GraphRegistry> {
  const [nodeTypes, edgeTypes] = await Promise.all([
    reader.findNodes({ aType: META_NODE_TYPE }),
    reader.findNodes({ aType: META_EDGE_TYPE }),
  ]);

  const entries: RegistryEntry[] = [...BOOTSTRAP_ENTRIES];

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
    });
  }

  // Convert edgeType records → RegistryEntries (expand from/to arrays)
  for (const record of edgeTypes) {
    const data = record.data as unknown as EdgeTypeData;
    const fromTypes = Array.isArray(data.from) ? data.from : [data.from];
    const toTypes = Array.isArray(data.to) ? data.to : [data.to];

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
        });
      }
    }
  }

  return createRegistry(entries);
}
