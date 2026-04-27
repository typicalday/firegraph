# 0.12.0 — Write-semantics audit

This document tracks the rationale, scope, and verification for the 0.12
breaking change that fixed silent overwrites in `putNode` / `putEdge` /
`updateNode` and unified write semantics across all backends.

## Why

Two long-standing bugs lived in the write path:

1. **`putNode` / `putEdge` did a full document replace.** Any caller that
   read a record, mutated one field in their head, and called `putNode`
   with that field would silently lose every other field. The API name
   ("put") suggested upsert; the behaviour was overwrite. This was the
   single biggest source of "where did my data go" reports.

2. **`updateNode` was a one-level shallow merge.** Top-level keys were
   preserved, but nested objects were replaced wholesale — the same
   silent-loss bug, one frame down. Worse, the depth at which sibling
   keys started disappearing was undocumented and inconsistent across
   backends (Firestore preserves nested keys with `set(merge: true)`;
   SQLite's old codepath ran `json_set('$.foo', ?)` which clobbered
   the whole subtree).

3. **`FieldValue.delete()` only worked on Firestore.** The other two
   backends (in-process SQLite, Cloudflare Durable Objects) had no
   portable way to remove a field at depth.

The 0.12 contract fixes all three at once and aligns every backend on
identical observable behaviour.

## What changed (public surface)

### `GraphWriter`

```diff
 interface GraphWriter {
   putNode(aType, uid, data): Promise<void>;
   putEdge(aType, aUid, axbType, bType, bUid, data): Promise<void>;
+  replaceNode(aType, uid, data): Promise<void>;
+  replaceEdge(aType, aUid, axbType, bType, bUid, data): Promise<void>;
   updateNode(uid, data): Promise<void>;
+  updateEdge(aUid, axbType, bUid, data): Promise<void>;
   removeNode(uid): Promise<void>;
   removeEdge(aUid, axbType, bUid): Promise<void>;
 }
```

`put*` and `update*` now deep-merge by default. `replace*` are the new
explicit "wipe and rewrite" methods. `updateEdge` is new (parity with
`updateNode`, which was the only update method exposed before).

### `firegraph` root

Adds `deleteField()` (and the underlying `DELETE_FIELD` sentinel) — a
backend-portable equivalent of `FieldValue.delete()`. Place it anywhere
in an `update*` payload to remove the field at any depth.

### `firegraph/backend`

Adds the primitives backend authors need to participate in the new
contract:

- `WriteMode = 'merge' | 'replace'` — third arg to `setDoc`.
- `UpdatePayload = { dataOps: DataPathOp[] } | { replaceData; v? }` —
  the wire format for `updateDoc`.
- `DataPathOp = { path: string[]; value; delete }` — terminal write op.
- `flattenPatch(data) → DataPathOp[]` — canonical helper that walks a
  partial-update payload and emits one op per terminal value.
- `DELETE_FIELD`, `deleteField()`, `isDeleteSentinel()` — sentinel +
  helpers.

## Backend-side audit

The contract is enforced at three places:

| Backend       | `setDoc` (merge mode)                                                                             | `updateDoc` (deep ops)                                              | Test                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Firestore     | `.set(record, { merge: true })` — Firestore's native deep-merge keeps siblings                    | `.update({ 'data.a.b.c': value, 'data.x.y': FieldValue.delete() })` | `tests/integration/write-semantics.test.ts` (BACKEND=firestore)                       |
| Shared SQLite | `INSERT … ON CONFLICT(doc_id) DO UPDATE SET data = json_set(json_remove(data, …deletes), …pairs)` | Chained `json_set(json_remove(data, …), $.path, json(?))`           | `tests/integration/write-semantics.test.ts` (BACKEND=sqlite)                          |
| Cloudflare DO | Same SQLite expression generator, run inside the DO's `state.storage.sql.exec`                    | Same                                                                | `tests/unit/cloudflare-{do,sql}.test.ts` + `tests/integration/cloudflare-rpc.test.ts` |

The shared `flattenPatch()` helper is the single source of truth for
"which ops does this payload produce." All three backends consume the
exact same op list, so divergence is structurally hard to introduce.

## Verification

| Check                                                                                 | Status |
| ------------------------------------------------------------------------------------- | :----: |
| `pnpm typecheck`                                                                      |   ✅   |
| `pnpm test:unit` (927 tests)                                                          |   ✅   |
| `pnpm test:emulator:integration` (225 tests, includes Cloudflare RPC)                 |   ✅   |
| `BACKEND=sqlite pnpm vitest run tests/integration/write-semantics.test.ts` (22 tests) |   ✅   |
| Cross-backend contract suite (`write-semantics.test.ts`)                              |   ✅   |
| Bundle pollution test (no Firestore in `firegraph/cloudflare`)                        |   ✅   |
| Backend-surface compile-time shape lock                                               |   ✅   |

## Notable refactors

- **`src/internal/write-plan.ts`** is the new single source of truth for
  patch flattening. Every backend (and every test that needs to assert
  on op shape) goes through it.
- **`src/internal/serialization-tag.ts`** holds `SERIALIZATION_TAG` and
  `isTaggedValue` in a tiny module with no `@google-cloud/firestore`
  import, so `firegraph/cloudflare` can keep recognising tagged values
  without dragging the Node-only Firestore SDK into the Workers bundle.
- **`replaceData` retained on `UpdatePayload`** specifically for the
  migration write-back path, where the migrated record is rewritten
  whole (the migration ran on the full data blob, not on an op list).
  Caller code never constructs `replaceData` directly.

## Things explicitly NOT shipped

- **No backwards-compat flag.** Adding `{ replace: true }` as a hidden
  third arg to `putNode` was considered and rejected — keeping the old
  silent-overwrite behaviour reachable defeats the point. `replaceNode`
  is the explicit, named way to ask for replacement.
- **No element-wise array merging.** Writing an array overwrites the
  array. `arrayUnion` / `arrayRemove` (Firestore) are the only places
  in firegraph where partial array semantics are well-defined.
- **No in-memory backend.** The contract test runs against the two real
  backends already on the path (Firestore emulator, in-process SQLite).
  Adding a third "for testing" backend would just be a fourth place the
  contract could quietly drift.
