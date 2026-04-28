# Migrating to firegraph 0.12

> **One-line summary:** every `put*` and `update*` call now **deep-merges** by
> default. If you were relying on `putNode`/`putEdge` to wipe-and-replace, switch
> to the new `replaceNode`/`replaceEdge`.

The 0.12 release reworks the write contract so it behaves the same on every
backend (Firestore, in-process SQLite, Cloudflare Durable Objects) and so the
silent "sibling key dropped at depth N" footgun the old API shipped with is
gone for good. This is a **breaking change** with no compatibility flag — it
flushes through cleanly with one targeted code change per write site.

## What changed

| Method                                           | Before 0.12                                                                          | After 0.12                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `putNode(t, uid, data)`                          | Full document replace. Any prior keys not in `data` were silently lost.              | **Deep merge.** Sibling keys at every nesting depth survive.                                        |
| `putEdge(...)`                                   | Same — full replace.                                                                 | **Deep merge.**                                                                                     |
| `updateNode(uid, data)`                          | One-level shallow merge: top-level keys preserved but nested objects fully replaced. | **Deep merge** all the way down.                                                                    |
| `updateEdge(...)`                                | _(did not exist as a public method)_                                                 | New: deep-merge partial update for edges.                                                           |
| `replaceNode(t, uid, data)` / `replaceEdge(...)` | _(did not exist)_                                                                    | New explicit "wipe and rewrite" methods. Use these when you actually want the old `put*` behaviour. |
| `deleteField()`                                  | _(did not exist)_                                                                    | New sentinel. Drop into any nested position to remove that field. Works on every backend.           |

Other guarantees, all backend-uniform:

- **Arrays are terminal.** Writing `{tags: ['a']}` over `{tags: ['a', 'b']}`
  yields `{tags: ['a']}`, not `{tags: ['a', 'b']}`. There is no element-wise
  merging — Firestore `arrayUnion` / `arrayRemove` give precise semantics
  when you need them.
- **`undefined` values are skipped.** They never produce a write op, so they
  don't accidentally clear a key.
- **`null` is preserved verbatim.** Use `deleteField()` when you actually
  want a field gone.

## Quick translation guide

### "I called `putNode` to overwrite the whole document"

```diff
- await g.putNode('tour', uid, { name: 'New name' });
+ await g.replaceNode('tour', uid, { name: 'New name' });
```

(If you were calling `putNode` only at insert time and never expected
overlapping keys, no change is needed — `putNode` still works for inserts.)

### "I used `updateNode` for shallow patches and didn't think about depth"

If your update payload is one level deep and you were relying on nested
objects being replaced wholesale, switch to `replaceNode` for the affected
field — or keep `updateNode` if a deep merge is actually what you want now.

```diff
// Before: updateNode replaced `meta` wholesale
- await g.updateNode(uid, { meta: { region: 'EU' } });

// After: pick the semantics you actually want
+ await g.updateNode(uid, { meta: { region: 'EU' } });    // deep merge
+ await g.replaceNode('tour', uid, { meta: { region: 'EU' } }); // wipe everything else
```

### "I used `FieldValue.delete()` (Firestore) to drop a field"

`FieldValue.delete()` still works on Firestore-backed clients, but for
backend-portable code use the new sentinel:

```diff
- import { FieldValue } from '@google-cloud/firestore';
- await g.updateNode(uid, { meta: { drop: FieldValue.delete() } });
+ import { deleteField } from 'firegraph';
+ await g.updateNode(uid, { meta: { drop: deleteField() } });
```

## Cross-backend caveats — values that don't round-trip identically

The 0.12 contract is "observable behaviour matches across Firestore, SQLite,
and Cloudflare DO" for **plain JSON-shaped data**. A few value categories are
deliberately out of scope and produce divergent (but loud) errors:

- **Firestore special types** (`Timestamp`, `GeoPoint`, `VectorValue`,
  `DocumentReference`, `FieldValue`) are accepted on Firestore and rejected
  with `INVALID_ARGUMENT` on SQLite / DO. Convert to a primitive
  (`ts.toMillis()`, `{lat,lng}`, etc.) before writing on SQLite-style
  backends.
- **Class instances** other than `Date` are rejected on SQLite / DO. Firestore
  may JSON-serialize them on a best-effort basis. Use plain objects when you
  need cross-backend portability.
- **`deleteField()` sentinel** is only valid inside `updateNode` /
  `updateEdge` payloads. It is rejected at the public API for `putNode` /
  `putEdge` / `replaceNode` / `replaceEdge` (Symbol values silently
  disappear from a full-document replace, so the rejection prevents the
  caller's intent from being lost).
- **Migration write-back** uses `replaceData` and inherits all of the above.
  If your migration outputs a Firestore-special type and your backend is
  SQLite or DO, the write-back will throw — project to primitives in the
  migration body.

The new `assertJsonSafePayload` helper in `src/internal/sqlite-payload-guard.ts`
enforces these rules. Errors carry `code: 'INVALID_ARGUMENT'` and a path
locating the offending value.

## Other breaking changes for backend authors

If you implement your own `StorageBackend`, the contract changed in two ways:

1. `setDoc(docId, record, mode)` gained a third argument: `'merge' | 'replace'`.
2. `updateDoc(docId, update)` now receives an `UpdatePayload` shape:
   - `{ dataOps: DataPathOp[] }` — list of terminal write ops produced by
     `flattenPatch()`. Each op is `{ path: string[]; value: unknown; delete: boolean }`.
   - `{ replaceData: Record<string, unknown>; v?: number }` — used by the
     migration write-back path to replace the whole `data` blob in one go.

The full surface is exported from `firegraph/backend`, including
`flattenPatch` and `DELETE_FIELD` for backend authors who want to participate
in the contract.

## Testing

Both backends (Firestore, SQLite) ship a parameterized contract test —
`tests/integration/write-semantics.test.ts` — that exercises every assertion
in this guide. Run it against your custom backend by wiring it into
`createTestGraphClient()` and re-running with `BACKEND=<your-backend>`.

## I just need it to compile

If your codebase has a lot of `putNode`/`putEdge` call sites you can't audit
right now, the safest mechanical migration is:

```ts
// Codemod: every existing put*/putEdge call becomes a replace*.
g.putNode(...)  →  g.replaceNode(...)
g.putEdge(...)  →  g.replaceEdge(...)
```

That preserves the **old** semantics exactly. Then audit at leisure and
roll back to `put*` (deep merge) where the old wipe behaviour was a footgun
rather than the intent.
