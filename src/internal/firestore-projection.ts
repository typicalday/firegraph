/**
 * Shared classic-API projection translation for both Firestore editions.
 *
 * Translates a `findEdgesProjected({ select })` call into a
 * `Query.select(...fieldPaths)` query and decodes the partial documents
 * Firestore returns. Both Standard and Enterprise editions delegate to this
 * single helper so the projection contract — bare-name normalization,
 * builtin / `data.*` resolution, dedup semantics, original-key preservation
 * — stays consistent across editions.
 *
 * Why the classic API on both editions: the Enterprise pipeline `select()`
 * stage is a future optimisation. Server-side projection's only deliverable
 * is the byte-savings on the wire, and the classic `Query.select(...)`
 * API already achieves that on both editions. When pipeline `select()`
 * lands on a future SDK release the wiring is additive — swap the
 * implementation behind this helper, callers don't change.
 *
 * Migrations are not applied to the result. The contract on
 * `StorageBackend.findEdgesProjected` documents the rationale: the caller
 * asked for a partial shape, and rehydrating it through the migration
 * pipeline would require synthesising every absent field.
 *
 * Absent fields surface as `null`, not `undefined` — this matches the
 * SQLite-shaped backends (where `json_extract` returns SQL NULL for an
 * absent JSON path) so the projected row shape is identical across
 * SQLite/DO/Firestore. See `readProjectionPath` for the normalisation.
 */

import type { Query } from '@google-cloud/firestore';

import { FiregraphError } from '../errors.js';
import type { QueryFilter, QueryOptions } from '../types.js';
import { normalizeFirestoreProjectionField, readProjectionPath } from './projection.js';

/** Resolved projection field — original (caller-supplied) + canonical Firestore path. */
interface ResolvedProjectionField {
  original: string;
  canonical: string;
}

/**
 * Run a projecting query against a base Firestore `Query`. Returns the
 * decoded rows, each keyed by the *original* field name as the caller
 * supplied it.
 *
 * `select` is rejected when empty (matches the SQLite compiler — both
 * layers fail so a misuse caught by either surfaces a clean
 * `INVALID_QUERY`). Duplicate entries are de-duped while preserving
 * first-occurrence order.
 */
export async function runFirestoreFindEdgesProjected(
  base: Query,
  select: ReadonlyArray<string>,
  filters: QueryFilter[],
  options?: QueryOptions,
): Promise<Array<Record<string, unknown>>> {
  if (select.length === 0) {
    throw new FiregraphError(
      'findEdgesProjected requires a non-empty select list — ' +
        'an empty projection has no representation distinct from `findEdges`.',
      'INVALID_QUERY',
    );
  }

  const seen = new Set<string>();
  const fields: ResolvedProjectionField[] = [];
  for (const f of select) {
    if (!seen.has(f)) {
      seen.add(f);
      fields.push({ original: f, canonical: normalizeFirestoreProjectionField(f) });
    }
  }

  let q: Query = base;
  for (const f of filters) {
    q = q.where(f.field, f.op, f.value);
  }
  if (options?.orderBy) {
    q = q.orderBy(options.orderBy.field, options.orderBy.direction ?? 'asc');
  }
  if (options?.limit !== undefined) {
    q = q.limit(options.limit);
  }
  q = q.select(...fields.map((p) => p.canonical));

  const snap = await q.get();
  return snap.docs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const { original, canonical } of fields) {
      out[original] = readProjectionPath(data, canonical);
    }
    return out;
  });
}
