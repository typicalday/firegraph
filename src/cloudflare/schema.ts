/**
 * Schema surface for the Cloudflare DO backend.
 *
 * The DO table shape is identical to the shared SQLite edition's — one
 * scope-free triple table per graph — so the actual DDL builder, column
 * map, and identifier quoting live in `src/internal/sqlite-schema.ts`.
 * This module re-exports them under their historical `DO`-prefixed names
 * so `firegraph/cloudflare` consumers and the DO class keep a stable
 * import surface.
 */

export type {
  BuildSchemaOptions as BuildDOSchemaOptions,
  SqliteColumn as DOColumn,
} from '../internal/sqlite-schema.js';
export {
  buildSchemaStatements as buildDOSchemaStatements,
  SQLITE_COLUMNS as DO_COLUMNS,
  FIELD_TO_COLUMN as DO_FIELD_TO_COLUMN,
  quoteColumnAlias as quoteDOColumnAlias,
  quoteIdent as quoteDOIdent,
  validateTableName as validateDOTableName,
} from '../internal/sqlite-schema.js';
