import type { DiscoveryResult, RegistryEntry } from './types.js';

export interface FirestoreIndexField {
  fieldPath: string;
  order: 'ASCENDING' | 'DESCENDING';
}

export interface FirestoreIndex {
  collectionGroup: string;
  queryScope: 'COLLECTION' | 'COLLECTION_GROUP';
  fields: FirestoreIndexField[];
}

export interface FirestoreIndexConfig {
  indexes: FirestoreIndex[];
  fieldOverrides: unknown[];
}

/**
 * Base composite indexes required for all firegraph collections.
 * These cover the standard query patterns:
 *   - Forward edge lookup:   (aUid, axbType)
 *   - Reverse edge lookup:   (axbType, bUid)
 *   - Type-scoped queries:   (aType, axbType)  — also covers findNodes
 *   - Edge type + target:    (axbType, bType)
 */
function baseIndexes(collection: string): FirestoreIndex[] {
  return [
    {
      collectionGroup: collection,
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'aUid', order: 'ASCENDING' },
        { fieldPath: 'axbType', order: 'ASCENDING' },
      ],
    },
    {
      collectionGroup: collection,
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'axbType', order: 'ASCENDING' },
        { fieldPath: 'bUid', order: 'ASCENDING' },
      ],
    },
    {
      collectionGroup: collection,
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'aType', order: 'ASCENDING' },
        { fieldPath: 'axbType', order: 'ASCENDING' },
      ],
    },
    {
      collectionGroup: collection,
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'axbType', order: 'ASCENDING' },
        { fieldPath: 'bType', order: 'ASCENDING' },
      ],
    },
  ];
}

/**
 * Extracts top-level field names from a JSON Schema object.
 * Only returns fields from schemas with type: "object" and properties.
 */
function extractSchemaFields(schema: object): string[] {
  const s = schema as Record<string, unknown>;
  if (s.type !== 'object' || !s.properties) return [];
  return Object.keys(s.properties as Record<string, unknown>);
}

/**
 * Collection group indexes for `findEdgesGlobal()` queries.
 *
 * These mirror the base collection indexes but with `COLLECTION_GROUP` scope,
 * which allows querying across all subcollections with the given name.
 * Only generated when the registry has edge types with `targetGraph` set,
 * indicating cross-graph edges exist and global queries are likely.
 */
function collectionGroupIndexes(collectionName: string): FirestoreIndex[] {
  return [
    {
      collectionGroup: collectionName,
      queryScope: 'COLLECTION_GROUP',
      fields: [
        { fieldPath: 'aUid', order: 'ASCENDING' },
        { fieldPath: 'axbType', order: 'ASCENDING' },
      ],
    },
    {
      collectionGroup: collectionName,
      queryScope: 'COLLECTION_GROUP',
      fields: [
        { fieldPath: 'axbType', order: 'ASCENDING' },
        { fieldPath: 'bUid', order: 'ASCENDING' },
      ],
    },
    {
      collectionGroup: collectionName,
      queryScope: 'COLLECTION_GROUP',
      fields: [
        { fieldPath: 'aType', order: 'ASCENDING' },
        { fieldPath: 'axbType', order: 'ASCENDING' },
      ],
    },
    {
      collectionGroup: collectionName,
      queryScope: 'COLLECTION_GROUP',
      fields: [
        { fieldPath: 'axbType', order: 'ASCENDING' },
        { fieldPath: 'bType', order: 'ASCENDING' },
      ],
    },
  ];
}

/**
 * Generates a Firestore index configuration for a firegraph collection.
 *
 * Always includes the 4 base composite indexes. If an entity discovery result
 * is provided, generates additional data-field indexes for common query
 * patterns on node data fields:
 *   (aType, axbType, data.{field})
 *
 * When registry entries with `targetGraph` are provided, also generates
 * collection group indexes for `findEdgesGlobal()` queries. The collection
 * group name defaults to `'graph'` (the standard subgraph name) but can be
 * overridden per `targetGraph` value.
 *
 * @param collection - Firestore collection name (e.g. 'graph')
 * @param entities - Optional discovery result for per-entity data field indexes
 * @param registryEntries - Optional registry entries; when any have `targetGraph`,
 *   collection group indexes are generated for the distinct subgraph names
 */
export function generateIndexConfig(
  collection: string,
  entities?: DiscoveryResult,
  registryEntries?: ReadonlyArray<RegistryEntry>,
): FirestoreIndexConfig {
  const indexes = baseIndexes(collection);

  if (entities) {
    // Generate data-field indexes for node types.
    // Pattern: (aType, axbType, data.{field}) — covers findNodes with where clauses
    // and findEdges scoped by aType + axbType + data filter.
    for (const [, entity] of entities.nodes) {
      const fields = extractSchemaFields(entity.schema);
      for (const field of fields) {
        indexes.push({
          collectionGroup: collection,
          queryScope: 'COLLECTION',
          fields: [
            { fieldPath: 'aType', order: 'ASCENDING' },
            { fieldPath: 'axbType', order: 'ASCENDING' },
            { fieldPath: `data.${field}`, order: 'ASCENDING' },
          ],
        });
      }
    }

    // Generate data-field indexes for edge types.
    // Pattern: (aUid, axbType, data.{field}) — covers forward edge lookups with data filters.
    for (const [, entity] of entities.edges) {
      const fields = extractSchemaFields(entity.schema);
      for (const field of fields) {
        indexes.push({
          collectionGroup: collection,
          queryScope: 'COLLECTION',
          fields: [
            { fieldPath: 'aUid', order: 'ASCENDING' },
            { fieldPath: 'axbType', order: 'ASCENDING' },
            { fieldPath: `data.${field}`, order: 'ASCENDING' },
          ],
        });
      }
    }
  }

  // Generate collection group indexes when cross-graph edges exist.
  // Each distinct targetGraph value gets its own set of collection group indexes.
  if (registryEntries) {
    const targetGraphNames = new Set<string>();
    for (const entry of registryEntries) {
      if (entry.targetGraph) {
        targetGraphNames.add(entry.targetGraph);
      }
    }
    for (const name of targetGraphNames) {
      indexes.push(...collectionGroupIndexes(name));
    }
  }

  return { indexes, fieldOverrides: [] };
}
