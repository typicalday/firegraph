import type { DiscoveryResult } from './types.js';

export interface FirestoreIndexField {
  fieldPath: string;
  order: 'ASCENDING' | 'DESCENDING';
}

export interface FirestoreIndex {
  collectionGroup: string;
  queryScope: 'COLLECTION';
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
 * Generates a Firestore index configuration for a firegraph collection.
 *
 * Always includes the 4 base composite indexes. If an entity discovery result
 * is provided, generates additional data-field indexes for common query
 * patterns on node data fields:
 *   (aType, axbType, data.{field})
 *
 * @param collection - Firestore collection name (e.g. 'graph')
 * @param entities - Optional discovery result for per-entity data field indexes
 */
export function generateIndexConfig(
  collection: string,
  entities?: DiscoveryResult,
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

  return { indexes, fieldOverrides: [] };
}
