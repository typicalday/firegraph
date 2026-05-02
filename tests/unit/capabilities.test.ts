/**
 * Capability descriptor tests.
 *
 * Locks in the runtime contract for `BackendCapabilities`, the
 * `createCapabilities` / `intersectCapabilities` helpers, and the
 * per-backend cap declarations every in-tree `StorageBackend` exposes.
 *
 * The cap declarations themselves are how the public capability matrix
 * (`.claude/backend-capabilities.md`) is enforced at runtime — if a
 * backend silently grows or loses a capability the test will flag it.
 */

import type { Firestore } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';

import { createCapabilities, intersectCapabilities } from '../../src/backend.js';
import { createRoutingBackend } from '../../src/backend.js';
import type { FiregraphNamespace, FiregraphStub } from '../../src/cloudflare/backend.js';
import { DORPCBackend } from '../../src/cloudflare/backend.js';
import { createFirestoreEnterpriseBackend } from '../../src/firestore-enterprise/backend.js';
import { createFirestoreStandardBackend } from '../../src/firestore-standard/backend.js';
import type {
  StorageBackend,
  TransactionBackend,
  UpdatePayload,
  WritableRecord,
  WriteMode,
} from '../../src/internal/backend.js';
import type { SqliteExecutor } from '../../src/internal/sqlite-executor.js';
import { createSqliteBackend } from '../../src/sqlite/backend.js';
import type {
  BulkOptions,
  BulkResult,
  Capability,
  CascadeResult,
  FindEdgesParams,
  GraphReader,
  QueryFilter,
  QueryOptions,
  StoredGraphRecord,
} from '../../src/types.js';

describe('createCapabilities', () => {
  it('reports declared caps via has() and values()', () => {
    const caps = createCapabilities(new Set<Capability>(['core.read', 'core.write']));
    expect(caps.has('core.read')).toBe(true);
    expect(caps.has('core.write')).toBe(true);
    expect(caps.has('core.transactions')).toBe(false);
    expect(Array.from(caps.values()).sort()).toEqual(['core.read', 'core.write']);
  });

  it('produces an empty-but-callable descriptor for an empty set', () => {
    const caps = createCapabilities(new Set<Capability>());
    expect(caps.has('core.read')).toBe(false);
    expect(Array.from(caps.values())).toEqual([]);
  });
});

describe('intersectCapabilities', () => {
  it('returns the intersection of multiple capability sets', () => {
    const a = createCapabilities(new Set<Capability>(['core.read', 'core.write', 'raw.firestore']));
    const b = createCapabilities(new Set<Capability>(['core.read', 'core.write', 'raw.sql']));
    const c = createCapabilities(new Set<Capability>(['core.read', 'core.write']));
    const merged = intersectCapabilities([a, b, c]);
    expect(Array.from(merged.values()).sort()).toEqual(['core.read', 'core.write']);
  });

  it('returns an empty set when given no parts', () => {
    const merged = intersectCapabilities([]);
    expect(merged.has('core.read')).toBe(false);
    expect(Array.from(merged.values())).toEqual([]);
  });

  it('returns the lone set when given a single part', () => {
    const only = createCapabilities(new Set<Capability>(['core.read']));
    const merged = intersectCapabilities([only]);
    expect(Array.from(merged.values())).toEqual(['core.read']);
  });
});

// ---------------------------------------------------------------------------
// Per-backend cap declarations
// ---------------------------------------------------------------------------

function makeStubExecutor(): SqliteExecutor {
  return {
    all: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue(undefined),
    batch: vi.fn().mockResolvedValue(undefined),
  };
}

function makeStubExecutorWithTransaction(): SqliteExecutor {
  return {
    all: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue(undefined),
    batch: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(),
  };
}

describe('FirestoreBackend capabilities', () => {
  function makeStubFirestore(): Firestore {
    // The Firestore adapter only touches `db.collection(...)` on
    // construction; we stub it lazily so the cap surface assertions don't
    // require a real Firestore. If a future change makes the constructor
    // reach further into Firestore we'll learn here first.
    const collectionStub = {
      doc: () => ({}),
      where: () => collectionStub,
      orderBy: () => collectionStub,
      limit: () => collectionStub,
      get: async () => ({ docs: [] }),
    };
    return {
      collection: () => collectionStub,
      collectionGroup: () => collectionStub,
    } as unknown as Firestore;
  }

  it('Standard edition declares the full core surface plus raw.firestore', () => {
    const backend = createFirestoreStandardBackend(makeStubFirestore(), 'firegraph');
    const caps = backend.capabilities;
    expect(caps.has('core.read')).toBe(true);
    expect(caps.has('core.write')).toBe(true);
    expect(caps.has('core.transactions')).toBe(true);
    expect(caps.has('core.batch')).toBe(true);
    expect(caps.has('core.subgraph')).toBe(true);
    expect(caps.has('raw.firestore')).toBe(true);
  });

  it('Standard edition declares query.aggregate (Phase 4) — count/sum/avg only', () => {
    // Standard supports the classic Query.aggregate API (count/sum/avg). It
    // does NOT support min/max — those throw UNSUPPORTED_AGGREGATE at runtime.
    // The capability flag means "supports at least count/sum/avg", per the
    // Phase 4 contract documented in the design plan.
    const backend = createFirestoreStandardBackend(makeStubFirestore(), 'firegraph');
    const caps = backend.capabilities;
    expect(caps.has('query.aggregate')).toBe(true);
  });

  it('Standard edition declares query.select (Phase 7) — server-side projection via Query.select(...)', () => {
    // Standard exposes server-side projection via the classic
    // `Query.select(...)` API. Both Firestore editions delegate to one
    // shared helper (`runFirestoreFindEdgesProjected`) so the projection
    // contract — bare-name normalization, builtin / `data.*` resolution,
    // dedup semantics — stays consistent.
    const backend = createFirestoreStandardBackend(makeStubFirestore(), 'firegraph');
    expect(backend.capabilities.has('query.select')).toBe(true);
  });

  it('Standard edition declares search.vector (Phase 8) — nearest-neighbour via Query.findNearest(...)', () => {
    // Standard exposes vector / nearest-neighbour search via the classic
    // `Query.findNearest(...)` API. Both Firestore editions delegate to
    // one shared helper (`runFirestoreFindNearest`) so the validation
    // surface — vectorField path normalisation, envelope-field rejection,
    // queryVector coercion, limit bounds — stays consistent across
    // editions.
    const backend = createFirestoreStandardBackend(makeStubFirestore(), 'firegraph');
    expect(backend.capabilities.has('search.vector')).toBe(true);
  });

  it('Standard edition declares query.join (Phase 13a) — chunked classic-API multi-source fan-out', () => {
    // Standard wires `expand` through the chunked classic-API helper:
    // sources are split into 30-element chunks (the classic `'in'`
    // operator's documented cap) and dispatched in parallel via
    // `Promise.all`. The result is concat'd, post-sorted across chunks,
    // and capped by `sources.length * limitPerSource` if set. Same
    // observable contract as Enterprise; different round-trip profile.
    const backend = createFirestoreStandardBackend(makeStubFirestore(), 'firegraph');
    expect(backend.capabilities.has('query.join')).toBe(true);
  });

  it('Standard edition installs the expand method when query.join is declared', () => {
    // Routing invariant: declared cap ⇒ method exists. The `expand`
    // function must be present whenever the cap is declared.
    const backend = createFirestoreStandardBackend(makeStubFirestore(), 'firegraph');
    expect(typeof backend.expand).toBe('function');
  });

  it('Standard edition does not silently declare unimplemented extension capabilities', () => {
    const backend = createFirestoreStandardBackend(makeStubFirestore(), 'firegraph');
    const caps = backend.capabilities;
    expect(caps.has('raw.sql')).toBe(false);
    // query.aggregate ships in Phase 4; query.select ships in Phase 7;
    // search.vector ships in Phase 8; query.join ships in Phase 13a — see
    // the dedicated assertions above.
    expect(caps.has('query.dml')).toBe(false);
    expect(caps.has('search.fullText')).toBe(false);
    expect(caps.has('search.geo')).toBe(false);
    expect(caps.has('realtime.listen')).toBe(false);
    // traversal.serverSide is Enterprise-only — the nested-Pipeline
    // executor requires `define` / `addFields` / `toArrayExpression` /
    // `variable`, which the classic Standard SDK doesn't expose.
    expect(caps.has('traversal.serverSide')).toBe(false);
  });

  it('Enterprise edition declares the full core surface plus raw.firestore', () => {
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
    });
    const caps = backend.capabilities;
    expect(caps.has('core.read')).toBe(true);
    expect(caps.has('core.write')).toBe(true);
    expect(caps.has('core.transactions')).toBe(true);
    expect(caps.has('core.batch')).toBe(true);
    expect(caps.has('core.subgraph')).toBe(true);
    expect(caps.has('raw.firestore')).toBe(true);
  });

  it('Enterprise edition declares query.aggregate (Phase 4)', () => {
    // Enterprise routes through the same classic Query.aggregate helper as
    // Standard for now — pipeline-based min/max is a future optimization
    // (Phase 11+). Both editions reject min/max with UNSUPPORTED_AGGREGATE.
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
    });
    const caps = backend.capabilities;
    expect(caps.has('query.aggregate')).toBe(true);
  });

  it('Enterprise edition declares query.select (Phase 7) — projection via shared classic-API helper', () => {
    // Enterprise and Standard delegate to the same projection helper. The
    // pipeline `select()` stage is a future optimisation that doesn't change
    // the cap declaration — the byte-savings deliverable is achieved by
    // either path.
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
    });
    expect(backend.capabilities.has('query.select')).toBe(true);
  });

  it('Enterprise edition declares search.vector (Phase 8) — nearest-neighbour via shared classic-API helper', () => {
    // Enterprise routes through the same `runFirestoreFindNearest` helper
    // as Standard — the pipeline `findNearest` stage is a future
    // optimisation that doesn't change the cap declaration. The
    // top-K-by-similarity deliverable is satisfied by the classic API on
    // both editions, with identical index requirements.
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
    });
    expect(backend.capabilities.has('search.vector')).toBe(true);
  });

  it('Enterprise edition declares search.fullText (Phase 12) — Pipelines documentMatches via shared helper', () => {
    // Enterprise wires FTS through the typed Pipelines surface in
    // `@google-cloud/firestore@8.5.0`: `db.pipeline().collection(path).search({
    // query: documentMatches(q), sort: score().descending() }).where(...)
    // .limit(N).execute()`. Standard never declares this — FTS is an
    // Enterprise-only product feature.
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
    });
    expect(backend.capabilities.has('search.fullText')).toBe(true);
  });

  it('Enterprise edition declares search.geo (Phase 12) — Pipelines geoDistance via shared helper', () => {
    // Enterprise wires geo through the same typed Pipelines surface:
    // `search({ query: geoDistance(field, point).lessThanOrEqual(radius),
    // sort: geoDistance(...).ascending() })`. Standard never declares this —
    // geo is an Enterprise-only product feature.
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
    });
    expect(backend.capabilities.has('search.geo')).toBe(true);
  });

  it('Enterprise edition installs the FTS / geo methods when the caps are declared', () => {
    // The "declared capability ⇒ method exists" invariant: caps and
    // methods cannot drift apart. Both `fullTextSearch` and `geoSearch`
    // must be present on the backend instance whenever the matching cap
    // is declared.
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
    });
    expect(typeof backend.fullTextSearch).toBe('function');
    expect(typeof backend.geoSearch).toBe('function');
  });

  it('Enterprise edition declares query.join (Phase 13a) — Pipelines equalAny multi-source fan-out', () => {
    // Enterprise wires `expand` through the typed Pipelines surface:
    // `db.pipeline().collection(path).where(equalAny(sourceField, sources))
    // .execute()` collapses an N-source fan-out into a single round trip.
    // `equalAny` accepts an arbitrary list (no 30-element cap like the
    // classic `'in'` operator), so 1k-source fan-outs are tractable. When
    // `queryMode === 'classic'` (emulator or explicit override), the
    // backend falls back to the chunked classic helper — same contract,
    // different round-trip profile.
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
    });
    expect(backend.capabilities.has('query.join')).toBe(true);
  });

  it('Enterprise edition installs the expand method when query.join is declared', () => {
    // Routing invariant: declared cap ⇒ method exists. The `expand`
    // function must be present whenever the cap is declared, regardless
    // of `queryMode`.
    const pipelineBackend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph');
    expect(typeof pipelineBackend.expand).toBe('function');
    const classicBackend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
    });
    expect(typeof classicBackend.expand).toBe('function');
  });

  it('Enterprise edition does NOT declare query.dml without previewDml (Phase 13b is opt-in)', () => {
    // Phase 13b wires `bulkDelete` / `bulkUpdate` through Pipeline DML
    // stages, but those stages are `@beta` in
    // `@google-cloud/firestore@8.5.0`. The backend gates the cap on the
    // explicit `previewDml: true` opt-in so callers don't accidentally
    // depend on a `@beta` SDK surface. Without the flag, the cap stays
    // off — and the routing-backend wrapper / `client.ts` use that cap
    // to decide whether to surface `bulkDelete` / `bulkUpdate` on the
    // public client, falling back to the read-then-write `bulkRemoveEdges`
    // path. Method presence on the raw backend instance is an
    // implementation detail; the capability declaration is the contract.
    const defaulted = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
    });
    expect(defaulted.capabilities.has('query.dml')).toBe(false);

    const explicitOff = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
      previewDml: false,
    });
    expect(explicitOff.capabilities.has('query.dml')).toBe(false);
  });

  it('Enterprise edition declares query.dml (Phase 13b) when previewDml: true', () => {
    // Opt-in flag flips the cap on. `bulkDelete` / `bulkUpdate` get
    // installed and dispatch through the shared
    // `runFirestorePipelineDelete` / `runFirestorePipelineUpdate`
    // helpers, which compose `Pipeline.delete()` /
    // `Pipeline.update(transformedFields)` stages. A one-time
    // `console.warn` fires on first construction with the flag — the
    // warn-once gate isn't asserted here (its lifecycle leaks across
    // tests; covered in the helper test).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
        defaultQueryMode: 'classic',
        previewDml: true,
      });
      expect(backend.capabilities.has('query.dml')).toBe(true);
      expect(typeof backend.bulkDelete).toBe('function');
      expect(typeof backend.bulkUpdate).toBe('function');
    } finally {
      warn.mockRestore();
    }
  });

  it('Enterprise edition declares traversal.serverSide (Phase 13c) — nested-Pipeline multi-hop traversal', () => {
    // Enterprise wires server-side traversal through the typed Pipelines
    // surface in `@google-cloud/firestore@8.5.0`: `define()` /
    // `addFields(child.toArrayExpression().as(...))` / `variable(name)`
    // are GA-typed (no `@beta` annotation), so this cap doesn't need a
    // `previewDml`-style opt-in — unlike `query.dml`. The executor
    // collapses an N-hop traversal that would have been N round trips
    // (per-hop fan-out via `expand`) into one server-side call.
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
    });
    expect(backend.capabilities.has('traversal.serverSide')).toBe(true);
  });

  it('Enterprise edition installs runEngineTraversal when traversal.serverSide is declared', () => {
    // Routing invariant: declared cap ⇒ method exists. The
    // `runEngineTraversal` function must be present whenever the cap is
    // declared, regardless of `queryMode` — engine traversal always
    // dispatches through Pipelines because join-key binding via
    // `define`/`variable` has no classic Query API equivalent.
    const pipelineBackend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph');
    expect(typeof pipelineBackend.runEngineTraversal).toBe('function');
    const classicBackend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
    });
    expect(typeof classicBackend.runEngineTraversal).toBe('function');
  });

  it('Enterprise edition does not silently declare unimplemented extension capabilities', () => {
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
    });
    const caps = backend.capabilities;
    expect(caps.has('raw.sql')).toBe(false);
    // query.aggregate ships in Phase 4; query.select ships in Phase 7;
    // search.vector ships in Phase 8; search.fullText / search.geo ship in
    // Phase 12; query.join ships in Phase 13a; query.dml ships in Phase 13b
    // (opt-in via `previewDml: true` — see dedicated assertion above);
    // traversal.serverSide ships in Phase 13c — see dedicated assertion above.
    expect(caps.has('realtime.listen')).toBe(false);
  });
});

describe('SqliteBackendImpl capabilities', () => {
  it('omits core.transactions when executor.transaction is undefined (D1-shaped driver)', () => {
    const backend = createSqliteBackend(makeStubExecutor(), 'firegraph');
    const caps = backend.capabilities;
    expect(caps.has('core.read')).toBe(true);
    expect(caps.has('core.write')).toBe(true);
    expect(caps.has('core.batch')).toBe(true);
    expect(caps.has('core.subgraph')).toBe(true);
    expect(caps.has('raw.sql')).toBe(true);
    expect(caps.has('core.transactions')).toBe(false);
  });

  it('declares core.transactions when executor.transaction is defined', () => {
    const backend = createSqliteBackend(makeStubExecutorWithTransaction(), 'firegraph');
    expect(backend.capabilities.has('core.transactions')).toBe(true);
  });

  it('declares query.aggregate (Phase 4) — full count/sum/avg/min/max set via SQL', () => {
    // SQLite implements all five aggregate ops natively in `compileAggregate`
    // (with `CAST(... AS REAL)` to force numeric semantics on JSON-extracted
    // values). Unlike the Firestore editions, min/max work here.
    const backend = createSqliteBackend(makeStubExecutorWithTransaction(), 'firegraph');
    expect(backend.capabilities.has('query.aggregate')).toBe(true);
  });

  it('declares query.dml (Phase 5) — server-side bulkDelete/bulkUpdate via SQL', () => {
    // SQLite implements DML natively in `compileBulkDelete` / `compileBulkUpdate`.
    // The single statement uses `DELETE … RETURNING "doc_id"` (3.35+) or the
    // deep-merge `flattenPatch → compileDataOpsExpr` pipeline shared with
    // single-row writes.
    const backend = createSqliteBackend(makeStubExecutorWithTransaction(), 'firegraph');
    expect(backend.capabilities.has('query.dml')).toBe(true);
  });

  it('declares query.join (Phase 6) — server-side multi-source fan-out via SQL IN(...)', () => {
    // SQLite implements multi-source fan-out via `compileExpand`, which emits
    // `WHERE "aUid" IN (?, ?, …)` against the edges table and (when hydrating)
    // a second statement that pulls target nodes by `bUid`. The traversal layer
    // dispatches to `expand()` once per hop on backends that declare this cap.
    const backend = createSqliteBackend(makeStubExecutorWithTransaction(), 'firegraph');
    expect(backend.capabilities.has('query.join')).toBe(true);
  });

  it('declares query.select (Phase 7) — server-side projection via json_extract(...)', () => {
    // SQLite implements projection via `compileFindEdgesProjected`, which emits
    // `SELECT json_extract("data", '$.x') AS "x", json_type(...) AS "x__t" …`.
    // The paired `json_type` companion column lets the decoder recover JSON-
    // encoded objects/arrays as native JS while passing primitives through.
    const backend = createSqliteBackend(makeStubExecutorWithTransaction(), 'firegraph');
    expect(backend.capabilities.has('query.select')).toBe(true);
  });

  it('does not silently declare search.* extensions before they ship', () => {
    const backend = createSqliteBackend(makeStubExecutorWithTransaction(), 'firegraph');
    const caps = backend.capabilities;
    // query.aggregate ships in Phase 4; query.dml ships in Phase 5; query.join
    // ships in Phase 6; query.select ships in Phase 7 — see the dedicated
    // assertions above.
    expect(caps.has('search.fullText')).toBe(false);
    expect(caps.has('search.geo')).toBe(false);
    expect(caps.has('search.vector')).toBe(false);
    // traversal.serverSide is Firestore-Enterprise-only — it depends on
    // the typed Pipelines `define` / `addFields` / `toArrayExpression`
    // primitives. SQLite would need correlated subqueries with
    // json_group_array nesting, which we don't model.
    expect(caps.has('traversal.serverSide')).toBe(false);
  });
});

describe('DORPCBackend capabilities', () => {
  function makeNamespace(): FiregraphNamespace {
    const stub: FiregraphStub = {
      _fgGetDoc: vi.fn(),
      _fgQuery: vi.fn(),
      _fgAggregate: vi.fn(),
      _fgSetDoc: vi.fn(),
      _fgUpdateDoc: vi.fn(),
      _fgDeleteDoc: vi.fn(),
      _fgBatch: vi.fn(),
      _fgRemoveNodeCascade: vi.fn(),
      _fgBulkRemoveEdges: vi.fn(),
      _fgDestroy: vi.fn(),
    };
    return {
      idFromName: () => ({ toString: () => 'id' }),
      get: () => stub,
    };
  }

  it('declares core.* (sans transactions) and no SQL/raw caps', () => {
    const backend = new DORPCBackend(makeNamespace(), { storageKey: 'root' });
    const caps = backend.capabilities;
    expect(caps.has('core.read')).toBe(true);
    expect(caps.has('core.write')).toBe(true);
    expect(caps.has('core.batch')).toBe(true);
    expect(caps.has('core.subgraph')).toBe(true);
    // DO transactions throw UNSUPPORTED_OPERATION — see `transactionsUnsupported`.
    expect(caps.has('core.transactions')).toBe(false);
    // SQL surface is hidden behind RPC; not exposed.
    expect(caps.has('raw.sql')).toBe(false);
    expect(caps.has('raw.firestore')).toBe(false);
  });

  it('declares query.aggregate (Phase 4) — full count/sum/avg/min/max via DO SQLite RPC', () => {
    // The DO backend forwards aggregates through `_fgAggregate`, which runs
    // `compileDOAggregate` against the per-DO SQLite. Same surface as the
    // shared-table SQLite backend, just dispatched over RPC.
    const backend = new DORPCBackend(makeNamespace(), { storageKey: 'root' });
    expect(backend.capabilities.has('query.aggregate')).toBe(true);
  });

  it('declares query.dml (Phase 5) — server-side bulkDelete/bulkUpdate via DO RPC', () => {
    // The DO backend forwards DML through `_fgBulkDelete` / `_fgBulkUpdate`,
    // which run `compileDOBulkDelete` / `compileDOBulkUpdate` against the
    // per-DO SQLite. Per-DO physical isolation makes the unfiltered
    // "wipe everything" case bounded by construction.
    const backend = new DORPCBackend(makeNamespace(), { storageKey: 'root' });
    expect(backend.capabilities.has('query.dml')).toBe(true);
  });

  it('declares query.join (Phase 6) — server-side multi-source fan-out via DO RPC', () => {
    // The DO backend forwards `expand` through `_fgExpand`, which runs
    // `compileDOExpand` against the per-DO SQLite. Mirrors the shared-table
    // SQLite backend's surface, just dispatched over RPC. The traversal layer
    // dispatches once per hop; cross-graph hops still fall back to per-source.
    const backend = new DORPCBackend(makeNamespace(), { storageKey: 'root' });
    expect(backend.capabilities.has('query.join')).toBe(true);
  });

  it('declares query.select (Phase 7) — server-side projection via DO RPC', () => {
    // The DO backend forwards projection through `_fgFindEdgesProjected`,
    // which runs `compileDOFindEdgesProjected` against the per-DO SQLite and
    // returns `{ rows, columns }`. Decoding is deferred to the client side
    // because `GraphTimestampImpl` doesn't survive workerd's structured-
    // clone boundary as a class instance.
    const backend = new DORPCBackend(makeNamespace(), { storageKey: 'root' });
    expect(backend.capabilities.has('query.select')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Routing backend mirrors wrapped caps
// ---------------------------------------------------------------------------

function makeFakeBackend(caps: ReadonlySet<Capability>): StorageBackend {
  return {
    capabilities: createCapabilities(caps),
    collectionPath: 'firegraph',
    scopePath: '',
    getDoc: async (_docId: string): Promise<StoredGraphRecord | null> => null,
    query: async (
      _filters: QueryFilter[],
      _options?: QueryOptions,
    ): Promise<StoredGraphRecord[]> => [],
    setDoc: async (_id: string, _r: WritableRecord, _m: WriteMode): Promise<void> => {},
    updateDoc: async (_id: string, _u: UpdatePayload): Promise<void> => {},
    deleteDoc: async (_id: string): Promise<void> => {},
    runTransaction: async <T>(fn: (tx: TransactionBackend) => Promise<T>): Promise<T> =>
      fn({
        getDoc: async () => null,
        query: async () => [],
        setDoc: async () => {},
        updateDoc: async () => {},
        deleteDoc: async () => {},
      }),
    createBatch: () => ({
      setDoc: () => {},
      updateDoc: () => {},
      deleteDoc: () => {},
      commit: async () => {},
    }),
    subgraph(_uid: string, _name: string): StorageBackend {
      return makeFakeBackend(caps);
    },
    removeNodeCascade: async (
      _uid: string,
      _reader: GraphReader,
      _opts?: BulkOptions,
    ): Promise<CascadeResult> => ({
      deleted: 0,
      batches: 0,
      errors: [],
      edgesDeleted: 0,
      nodeDeleted: false,
    }),
    bulkRemoveEdges: async (
      _params: FindEdgesParams,
      _reader: GraphReader,
      _opts?: BulkOptions,
    ): Promise<BulkResult> => ({ deleted: 0, batches: 0, errors: [] }),
  };
}

describe('RoutingStorageBackend capabilities', () => {
  it('mirrors the wrapped backend cap set when no routedCapabilities are declared', () => {
    const base = makeFakeBackend(new Set<Capability>(['core.read', 'core.write', 'raw.sql']));
    const routed = createRoutingBackend(base, { route: () => null });
    expect(Array.from(routed.capabilities.values()).sort()).toEqual(
      ['core.read', 'core.write', 'raw.sql'].sort(),
    );
  });

  it('intersects base.capabilities with declared routedCapabilities', () => {
    const base = makeFakeBackend(
      new Set<Capability>(['core.read', 'core.write', 'core.transactions', 'raw.firestore']),
    );
    const routedChildCaps = createCapabilities(
      new Set<Capability>(['core.read', 'core.write', 'raw.sql']),
    );
    const routed = createRoutingBackend(base, {
      route: () => null,
      routedCapabilities: [routedChildCaps],
    });
    // Intersection drops `core.transactions` (base only) AND `raw.sql` (child
    // only); the two backends agree on `core.read` + `core.write` only.
    expect(Array.from(routed.capabilities.values()).sort()).toEqual(
      ['core.read', 'core.write'].sort(),
    );
    expect(routed.capabilities.has('core.transactions')).toBe(false);
    expect(routed.capabilities.has('raw.firestore')).toBe(false);
    expect(routed.capabilities.has('raw.sql')).toBe(false);
  });

  it('intersects across multiple routedCapabilities entries', () => {
    const base = makeFakeBackend(new Set<Capability>(['core.read', 'core.write', 'core.batch']));
    const childA = createCapabilities(new Set<Capability>(['core.read', 'core.write']));
    const childB = createCapabilities(new Set<Capability>(['core.read', 'core.batch']));
    const routed = createRoutingBackend(base, {
      route: () => null,
      routedCapabilities: [childA, childB],
    });
    // Only `core.read` is in all three sets.
    expect(Array.from(routed.capabilities.values())).toEqual(['core.read']);
  });

  it('reflects the routed-child cap set on grandchildren (child wrapper mirrors child)', () => {
    const base = makeFakeBackend(new Set<Capability>(['core.read']));
    const child = makeFakeBackend(new Set<Capability>(['core.read', 'core.write', 'raw.sql']));
    const routed = createRoutingBackend(base, { route: () => child });
    const grandchild = routed.subgraph('A', 'memories');
    // Child wrapper carries the routed child's actual caps — the intersection
    // logic only applies at the *root* wrapper because invariant 3 says caps
    // are static per instance. A user holding the grandchild handle is bound
    // to that specific backend and sees its real surface.
    expect(Array.from(grandchild.capabilities.values()).sort()).toEqual(
      ['core.read', 'core.write', 'raw.sql'].sort(),
    );
  });

  it('reflects the base subgraph caps on a pass-through child', () => {
    const base = makeFakeBackend(new Set<Capability>(['core.read', 'core.write', 'core.batch']));
    const routed = createRoutingBackend(base, { route: () => null });
    const child = routed.subgraph('A', 'memories');
    // No route — child wraps `base.subgraph(...)`, whose cap set our fake
    // factory makes identical to base. Verifies the pass-through path
    // forwards caps correctly.
    expect(Array.from(child.capabilities.values()).sort()).toEqual(
      ['core.batch', 'core.read', 'core.write'].sort(),
    );
  });
});
