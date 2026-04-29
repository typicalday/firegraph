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

  it('Standard edition does not silently declare unimplemented extension capabilities', () => {
    const backend = createFirestoreStandardBackend(makeStubFirestore(), 'firegraph');
    const caps = backend.capabilities;
    expect(caps.has('raw.sql')).toBe(false);
    // query.aggregate ships in Phase 4 — see the dedicated assertion above.
    expect(caps.has('query.join')).toBe(false);
    expect(caps.has('query.dml')).toBe(false);
    expect(caps.has('query.select')).toBe(false);
    expect(caps.has('search.fullText')).toBe(false);
    expect(caps.has('search.geo')).toBe(false);
    expect(caps.has('search.vector')).toBe(false);
    expect(caps.has('realtime.listen')).toBe(false);
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

  it('Enterprise edition does not silently declare unimplemented extension capabilities', () => {
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
    });
    const caps = backend.capabilities;
    expect(caps.has('raw.sql')).toBe(false);
    // query.aggregate ships in Phase 4 — see the dedicated assertion above.
    expect(caps.has('query.join')).toBe(false);
    expect(caps.has('query.dml')).toBe(false);
    expect(caps.has('query.select')).toBe(false);
    expect(caps.has('search.fullText')).toBe(false);
    expect(caps.has('search.geo')).toBe(false);
    expect(caps.has('search.vector')).toBe(false);
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

  it('does not silently declare query.* extensions before they ship', () => {
    const backend = createSqliteBackend(makeStubExecutorWithTransaction(), 'firegraph');
    const caps = backend.capabilities;
    // query.aggregate ships in Phase 4; query.dml ships in Phase 5 — see the
    // dedicated assertions above.
    expect(caps.has('query.join')).toBe(false);
    expect(caps.has('query.select')).toBe(false);
    expect(caps.has('search.fullText')).toBe(false);
    expect(caps.has('search.geo')).toBe(false);
    expect(caps.has('search.vector')).toBe(false);
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
