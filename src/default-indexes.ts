/**
 * Default core index preset.
 *
 * This set covers the query patterns firegraph's query planner emits for
 * built-in operations — `findNodes`, `findEdges`, cascade delete, traversal,
 * and the DO/SQLite path compilers. Apps that need additional indexes
 * (descending timestamps, `data.*` filters, composite fields unique to
 * their query shapes) declare them on `RegistryEntry.indexes` or override
 * this preset wholesale via the backend-specific `coreIndexes` option —
 * `FiregraphDOOptions.coreIndexes` for the DO backend,
 * `BuildSchemaOptions.coreIndexes` for the legacy SQLite backend, and
 * `GenerateIndexOptions.coreIndexes` for the Firestore CLI generator.
 *
 * ## Ownership model
 *
 * This list is firegraph's *recommendation* — not non-negotiable policy.
 * Consumers can:
 *
 *   1. Accept the preset as-is (default).
 *   2. Extend it: `coreIndexes: [...DEFAULT_CORE_INDEXES, ...more]`.
 *   3. Replace it entirely with a tailored set.
 *   4. Disable it (`coreIndexes: []`) and take full responsibility for
 *      index coverage — only do this if you're provisioning a complete
 *      custom set.
 *
 * ## Per-backend emission
 *
 * The Firestore generator skips single-field entries (Firestore implicitly
 * indexes every field) and emits one composite index per multi-field spec.
 * The SQLite-flavored generators (DO, legacy) emit every spec as-is.
 *
 * ## Why these specific indexes
 *
 * - `aUid` / `bUid` — required for `_fgRemoveNodeCascade`, which scans by
 *   each UID side independently. A composite `(aUid, axbType)` also
 *   satisfies `aUid`-alone via leading-column prefix, but the single-field
 *   form is cheaper for the common case.
 * - `aType` / `bType` — `findNodes({ aType })` and cross-type enumeration.
 * - `(aUid, axbType)` — forward edge lookup (`findEdges({ aUid, axbType })`)
 *   and the `get` strategy fallback when only two of three triple fields
 *   are present.
 * - `(axbType, bUid)` — reverse edge traversal.
 * - `(aType, axbType)` — type-scoped edge scans (e.g., `findEdges({ aType, axbType })`).
 * - `(axbType, bType)` — scope edges of one relation to a target type.
 */

import type { IndexSpec } from './types.js';

export const DEFAULT_CORE_INDEXES: ReadonlyArray<IndexSpec> = Object.freeze([
  { fields: ['aUid'] },
  { fields: ['bUid'] },
  { fields: ['aType'] },
  { fields: ['bType'] },
  { fields: ['aUid', 'axbType'] },
  { fields: ['axbType', 'bUid'] },
  { fields: ['aType', 'axbType'] },
  { fields: ['axbType', 'bType'] },
]);
