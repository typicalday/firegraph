/**
 * End-to-end RPC integration test for `FiregraphDO`.
 *
 * This test exists to guard the fix in commit `ad50298` ("make FiregraphDO
 * extend DurableObject for RPC compatibility"). All other DO tests in this
 * suite use the `cloudflare:workers` shim (`tests/__shims__/`), which means
 * they verify the source compiles and runs in Node — but they never actually
 * exercise workerd's RPC dispatcher. The dispatcher is precisely the surface
 * that broke before `ad50298`: a plain class DO loads fine, serves `fetch()`
 * fine, and even passes every shim-based test, but its stub throws as soon
 * as a method is called via the modern RPC protocol.
 *
 * To close that hole we boot a real workerd via Miniflare 4, bind two DO
 * classes (one extending `DurableObject`, one not), and assert:
 *   1. The `extends DurableObject` stub successfully dispatches an
 *      `_fgGetDoc(...)` call (returns `null`, since nothing is stored).
 *   2. The plain-class stub throws the canonical "does not support RPC"
 *      error — proving (1) isn't an accident of leniency.
 *
 * If a future refactor accidentally drops `extends DurableObject`, (1) will
 * start throwing "does not support RPC" and this test will fail loudly,
 * before the regression ships.
 *
 * The test bundles a fixture worker module (`tests/fixtures/cloudflare-rpc/
 * worker.ts`) at runtime via esbuild. `cloudflare:workers` is marked
 * external because workerd resolves it natively; node builtins are external
 * because the Worker runs with `nodejs_compat`. We bundle from `src/`
 * (not `dist/`) — see comment in the fixture for why.
 */

import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { computeNodeDocId } from '../../src/docid.js';
import { NODE_RELATION } from '../../src/internal/constants.js';
import { deleteField, flattenPatch } from '../../src/internal/write-plan.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/cloudflare-rpc/worker.ts', import.meta.url),
);

let mf: Miniflare;

beforeAll(async () => {
  // Bundle the fixture worker into a single ESM string. `cloudflare:workers`
  // stays external — workerd resolves it natively at load time. We don't
  // need a sourcemap; assertions key off behavior, not stack frames.
  const result = await build({
    entryPoints: [FIXTURE_PATH],
    bundle: true,
    format: 'esm',
    // `browser` so esbuild doesn't try to inline node builtins, but we
    // still want it to follow `node:`-prefixed imports as externals (the
    // Worker resolves them via `nodejs_compat`).
    platform: 'browser',
    target: 'es2022',
    write: false,
    external: [
      // workerd resolves `cloudflare:workers` natively at load time.
      'cloudflare:workers',
      // firegraph's own code uses `node:crypto` (in `src/docid.ts`); `node:*`
      // covers that path. Bare-name builtins (`crypto`, `path`, …) are also
      // externalized via `node:module#builtinModules` so any transitive dep
      // that hasn't migrated to `node:` prefixes still resolves under
      // `nodejs_compat`. Using the runtime list keeps this honest as Node's
      // builtin set grows — no hand-maintained string array to drift.
      'node:*',
      ...builtinModules,
    ],
    conditions: ['worker', 'browser', 'import'],
  });
  const script = result.outputFiles[0].text;

  mf = new Miniflare({
    modules: true,
    script,
    // Give the script a `.mjs` extension so workerd treats it as ESM.
    scriptPath: 'fixture.mjs',
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: {
      // The class that extends DurableObject — the path under test.
      // `useSQLite: true` matches the production wrangler config we
      // recommend in `do.ts`'s docstring.
      GRAPH: { className: 'FiregraphDO', useSQLite: true },
      // The control: a plain class with the same constructor shape.
      // `useSQLite: false` so the only variable vs GRAPH is `extends DO` —
      // a future Miniflare change that ever rejected SQLite-flagged plain
      // classes during binding setup wouldn't false-positive this test.
      PLAIN: { className: 'PlainDO', useSQLite: false },
    },
  });
  // Force the runtime to spin up so the first per-test call doesn't pay the
  // cold-start cost (and so any boot error fails the suite, not a single test).
  await mf.ready;
}, 30_000);

afterAll(async () => {
  await mf?.dispose();
});

describe('FiregraphDO RPC dispatch (real workerd)', () => {
  it('dispatches _fgGetDoc on a stub backed by `extends DurableObject`', async () => {
    const ns = await mf.getDurableObjectNamespace('GRAPH');
    const stub = ns.get(ns.idFromName('rpc-smoke-test'));
    // The point of the assertion: this call goes through workerd's RPC
    // dispatcher. Before `ad50298` (and before `extends DurableObject` was
    // added), this would throw `The receiving Durable Object does not
    // support RPC, because its class was not declared with `extends
    // DurableObject``. Now it should resolve to `null` because nothing has
    // been stored under that docId.
    const result = await (stub as any)._fgGetDoc('does-not-exist');
    expect(result).toBeNull();
  });

  it('rejects RPC on a plain class DO (negative control)', async () => {
    const ns = await mf.getDurableObjectNamespace('PLAIN');
    const stub = ns.get(ns.idFromName('plain-dispatch-test'));

    // Asserting the *kind* of failure matters: it must be the RPC-dispatch
    // error, not a network/timeout/anything else. The full message in
    // workerd is `The receiving Durable Object does not support RPC,
    // because its class was not declared with `extends DurableObject``;
    // matching on a substring keeps the test robust to wording tweaks but
    // still proves we hit the dispatcher's class check.
    //
    // Wrapped in a try/catch (rather than `expect(promise).rejects.toThrow`)
    // as belt-and-suspenders against future runtime quirks — observed
    // behavior is async rejection, but a try/catch around `await` covers
    // both that and any sync throw path equally well.
    let caught: unknown;
    try {
      await (stub as any)._fgGetDoc('does-not-exist');
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected the call to throw').toBeDefined();
    expect((caught as Error).message).toMatch(/does not support RPC/i);
  });
});

/**
 * Exotic-key escaping against *real workerd SQLite*.
 *
 * The 0.12 deep-merge write path turns nested object keys into quoted
 * JSON-path labels (`json_set(data, '$."holds"."4f9Kq_2bN"', …)`) via
 * `buildJsonPath` (`src/internal/sqlite-data-ops.ts`). The DO unit tests
 * (`tests/unit/cloudflare-do.test.ts`) exercise that path, but they back
 * `ctx.storage.sql` with **better-sqlite3** — they prove the escaping works
 * on better-sqlite3's SQLite build, not on the SQLite that ships inside
 * workerd / `state.storage.sql`. Those are different SQLite builds.
 *
 * This block closes that gap: it drives `_fgSetDoc` / `_fgUpdateDoc` /
 * `_fgGetDoc` through real workerd (booted by Miniflare with `useSQLite:
 * true`) so the quoted JSON-path labels are evaluated by the same SQLite
 * engine production DOs use. The canonical trigger is a `generateId()`-shaped
 * key that starts with a digit (`'4f9Kq_2bN'`) — the exact shape that the
 * old `SAFE_KEY_RE` guard rejected.
 */
describe('FiregraphDO exotic-key escaping (real workerd SQLite)', () => {
  const HOLD_ID = '4f9Kq_2bN';
  const uid = 'kX1nQ2mP9xR4wL1tY8s3a';

  async function freshStub(name: string) {
    const ns = await mf.getDurableObjectNamespace('GRAPH');
    return ns.get(ns.idFromName(name)) as unknown as {
      _fgSetDoc(docId: string, record: unknown, mode: string): Promise<void>;
      _fgUpdateDoc(docId: string, update: unknown): Promise<void>;
      _fgGetDoc(docId: string): Promise<{ data: Record<string, unknown> } | null>;
    };
  }

  function nodeRecord(data: Record<string, unknown>) {
    return {
      aType: 'tour',
      aUid: uid,
      axbType: NODE_RELATION,
      bType: 'tour',
      bUid: uid,
      data,
    };
  }

  it('round-trips a leading-digit nested map key, preserving siblings', async () => {
    const stub = await freshStub('exotic-roundtrip');
    const docId = computeNodeDocId(uid);
    await stub._fgSetDoc(docId, nodeRecord({ keep: 'me' }), 'replace');

    await stub._fgUpdateDoc(docId, {
      dataOps: flattenPatch({ holds: { [HOLD_ID]: { userId: 'u1' } } }),
    });

    const rec = await stub._fgGetDoc(docId);
    expect(rec).not.toBeNull();
    expect(rec!.data).toEqual({ keep: 'me', holds: { [HOLD_ID]: { userId: 'u1' } } });
  });

  it('updates a leaf under an exotic key without disturbing siblings', async () => {
    const stub = await freshStub('exotic-leaf');
    const docId = computeNodeDocId(uid);
    await stub._fgSetDoc(
      docId,
      nodeRecord({ holds: { [HOLD_ID]: { userId: 'u1', qty: 1 } } }),
      'replace',
    );

    await stub._fgUpdateDoc(docId, {
      dataOps: flattenPatch({ holds: { [HOLD_ID]: { qty: 2 } } }),
    });

    const rec = await stub._fgGetDoc(docId);
    expect(rec!.data).toEqual({ holds: { [HOLD_ID]: { userId: 'u1', qty: 2 } } });
  });

  it('removes an exotic-keyed entry via deleteField()', async () => {
    const stub = await freshStub('exotic-delete');
    const docId = computeNodeDocId(uid);
    await stub._fgSetDoc(
      docId,
      nodeRecord({ holds: { [HOLD_ID]: { userId: 'u1' }, other: { userId: 'u2' } } }),
      'replace',
    );

    await stub._fgUpdateDoc(docId, {
      dataOps: flattenPatch({ holds: { [HOLD_ID]: deleteField() } }),
    });

    const rec = await stub._fgGetDoc(docId);
    expect(rec!.data).toEqual({ holds: { other: { userId: 'u2' } } });
  });
});
