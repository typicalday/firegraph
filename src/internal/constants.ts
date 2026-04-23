export const NODE_RELATION = 'is';

/**
 * Default result limit applied to findEdges/findNodes queries
 * when no explicit limit is provided. Prevents unbounded result sets
 * that could be expensive on Enterprise Firestore.
 */
export const DEFAULT_QUERY_LIMIT = 500;

/**
 * Fields that are part of the firegraph record structure (not user data).
 * Used by the query planner and safety analysis to distinguish builtin
 * fields from data.* fields.
 */
export const BUILTIN_FIELDS = new Set([
  'aType',
  'aUid',
  'axbType',
  'bType',
  'bUid',
  'createdAt',
  'updatedAt',
]);

export const SHARD_ALGORITHM = 'sha256';
export const SHARD_SEPARATOR = ':';
export const SHARD_BUCKETS = 16;
