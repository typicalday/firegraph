/**
 * Shared `UpdatePayload` → Firestore `update()` argument builder used by both
 * Firestore editions (`firestore-standard` and `firestore-enterprise`).
 *
 * Firestore's `DocumentReference.update` has two overloads:
 *   - `update(data: UpdateData)` — an object whose *string* keys are parsed
 *     as dotted field paths (`'a.b'` → nested `a → b`).
 *   - `update(field: string | FieldPath, value, …moreFieldsAndValues)` — a
 *     variadic field/value list where a `FieldPath` addresses literal
 *     segments with no dotted reparse.
 *
 * We build the **variadic** form and key every deep-merge op with
 * `new FieldPath('data', …op.path)`. Literal segments mean an object key can
 * be anything non-empty — digit-leading (`'4f9Kq_2bN'`), hyphenated,
 * containing dots/brackets/whitespace — and still address that exact key
 * rather than being split on `.` by Firestore's dotted-path parser. This is
 * the Firestore-side counterpart to the SQLite backend's quoted JSON-path
 * labels (`src/internal/sqlite-data-ops.ts`): both backends escape keys at
 * path-construction time instead of rejecting them.
 *
 * `replaceData` keeps the plain string `'data'` key — it overwrites the
 * whole map, so there is no nested path to escape; tagged Firestore types
 * from the migration sandbox are reconstructed here via
 * `deserializeFirestoreTypes`. `updatedAt` is always stamped; `v` is stamped
 * as a top-level field when provided.
 */

import type { Firestore } from '@google-cloud/firestore';
import { FieldPath, FieldValue } from '@google-cloud/firestore';

import { deserializeFirestoreTypes } from '../serialization.js';
import type { UpdatePayload } from './backend.js';
import { assertSafePath, assertUpdatePayloadExclusive } from './write-plan.js';

/**
 * Variadic argument tuple for `DocumentReference.update(field, value, …)`.
 * Always at least one field/value pair (`updatedAt` is unconditionally
 * stamped), so the tuple is non-empty and matches the variadic overload
 * rather than the single-object overload.
 */
export type FirestoreUpdateArgs = [string | FieldPath, unknown, ...unknown[]];

export function buildFirestoreUpdateArgs(
  update: UpdatePayload,
  db: Firestore,
): FirestoreUpdateArgs {
  assertUpdatePayloadExclusive(update);
  const args: unknown[] = [];

  if (update.replaceData) {
    args.push('data', deserializeFirestoreTypes(update.replaceData, db));
  } else if (update.dataOps) {
    for (const op of update.dataOps) {
      assertSafePath(op.path);
      args.push(new FieldPath('data', ...op.path), op.delete ? FieldValue.delete() : op.value);
    }
  }

  args.push('updatedAt', FieldValue.serverTimestamp());
  if (update.v !== undefined) {
    args.push('v', update.v);
  }

  return args as FirestoreUpdateArgs;
}
