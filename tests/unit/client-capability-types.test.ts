/**
 * Type-level tests for capability gating on `GraphClient<C>`.
 *
 * Phase 3 plumbed the backend's declared capability union (`StorageBackend<C>`)
 * through `createGraphClient` so the returned client is `GraphClient<C>` /
 * `DynamicGraphClient<C>`. The extension interfaces are still empty (their
 * methods land in Phases 4–10), so the assertions here exercise the
 * *plumbing* — the per-backend `XCapability` literals and the generic
 * propagation through the factory — rather than method-level gating.
 *
 * These tests run as regular `vitest` cases so a regression surfaces in
 * `pnpm test:unit`, but every body uses `expectTypeOf` for compile-time
 * checks. Runtime expectations are minimal (a single `expect(true).toBe(true)`
 * keeps vitest happy when a describe block has no other runtime assertion).
 */

import type { Firestore } from '@google-cloud/firestore';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { createGraphClient } from '../../src/client.js';
import type { CloudflareCapability } from '../../src/cloudflare/backend.js';
import type { FirestoreEnterpriseCapability } from '../../src/firestore-enterprise/backend.js';
import type { FirestoreStandardCapability } from '../../src/firestore-standard/backend.js';
import type { StorageBackend } from '../../src/internal/backend.js';
import type { SqliteCapability } from '../../src/sqlite/backend.js';
import type {
  Capability,
  CoreGraphClient,
  DynamicGraphClient,
  DynamicRegistryConfig,
  GraphClient,
  GraphClientOptions,
} from '../../src/types.js';

// ---------------------------------------------------------------------------
// Static capability-union shapes
// ---------------------------------------------------------------------------

describe('Per-backend capability unions', () => {
  it('FirestoreStandardCapability is the conservative core surface plus raw.firestore + query.aggregate (Phase 4)', () => {
    type Expected =
      | 'core.read'
      | 'core.write'
      | 'core.transactions'
      | 'core.batch'
      | 'core.subgraph'
      | 'raw.firestore'
      | 'query.aggregate';
    expectTypeOf<FirestoreStandardCapability>().toEqualTypeOf<Expected>();
    // Guard against silent expansion into Enterprise-only territory.
    expectTypeOf<FirestoreStandardCapability>().not.toEqualTypeOf<Capability>();
    // Phase 4 ships query.aggregate — keep the positive assertion explicit so a
    // regression that drops it from STANDARD_CAPS shows up here.
    expectTypeOf<FirestoreStandardCapability>().toMatchTypeOf<'query.aggregate'>();
    // Concrete negative checks — every extension capability that lands in
    // Phases 5-10 must NOT yet appear in the Standard union. Using
    // `not.toMatchTypeOf` (per-cap) catches a regression that adds, e.g.,
    // 'query.dml' to STANDARD_CAPS without the matching method.
    expectTypeOf<FirestoreStandardCapability>().not.toMatchTypeOf<'query.dml'>();
    expectTypeOf<FirestoreStandardCapability>().not.toMatchTypeOf<'search.vector'>();
    expectTypeOf<FirestoreStandardCapability>().not.toMatchTypeOf<'realtime.listen'>();
    expect(true).toBe(true);
  });

  it('FirestoreEnterpriseCapability matches Standard plus query.aggregate (Phase 4)', () => {
    type Expected =
      | 'core.read'
      | 'core.write'
      | 'core.transactions'
      | 'core.batch'
      | 'core.subgraph'
      | 'raw.firestore'
      | 'query.aggregate';
    expectTypeOf<FirestoreEnterpriseCapability>().toEqualTypeOf<Expected>();
    // Phase 4 ships query.aggregate on Enterprise too.
    expectTypeOf<FirestoreEnterpriseCapability>().toMatchTypeOf<'query.aggregate'>();
    // Same negative parity as Standard — remaining extensions arrive in Phases 5-10.
    expectTypeOf<FirestoreEnterpriseCapability>().not.toMatchTypeOf<'query.dml'>();
    expectTypeOf<FirestoreEnterpriseCapability>().not.toMatchTypeOf<'search.vector'>();
    expectTypeOf<FirestoreEnterpriseCapability>().not.toMatchTypeOf<'realtime.listen'>();
    expect(true).toBe(true);
  });

  it('SqliteCapability declares interactive transactions statically and query.aggregate (Phase 4)', () => {
    type Expected =
      | 'core.read'
      | 'core.write'
      | 'core.transactions'
      | 'core.batch'
      | 'core.subgraph'
      | 'raw.sql'
      | 'query.aggregate';
    expectTypeOf<SqliteCapability>().toEqualTypeOf<Expected>();
    expectTypeOf<SqliteCapability>().toMatchTypeOf<'query.aggregate'>();
    expect(true).toBe(true);
  });

  it('CloudflareCapability omits transactions and raw.sql by design but ships query.aggregate (Phase 4)', () => {
    type Expected = 'core.read' | 'core.write' | 'core.batch' | 'core.subgraph' | 'query.aggregate';
    expectTypeOf<CloudflareCapability>().toEqualTypeOf<Expected>();
    // The DO RPC backend deliberately drops these — the type must reflect
    // that, not just the runtime cap-set.
    expectTypeOf<CloudflareCapability>().not.toMatchTypeOf<'core.transactions'>();
    expectTypeOf<CloudflareCapability>().not.toMatchTypeOf<'raw.sql'>();
    // Aggregate is supported via the DO RPC `_fgAggregate` call.
    expectTypeOf<CloudflareCapability>().toMatchTypeOf<'query.aggregate'>();
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Factory return-type narrowing
// ---------------------------------------------------------------------------

describe('createGraphClient narrows GraphClient<C> to the backend capability union', () => {
  // Bare-minimum stubs — the assertions are compile-time, but `createGraphClient`
  // does construct an instance during the test run, so we need shapes that
  // satisfy `StorageBackend<C>` at runtime.
  function makeBackend<C extends Capability>(): StorageBackend<C> {
    return {
      capabilities: { has: (() => false) as never, values: () => [].values() } as never,
      collectionPath: 'firegraph',
      scopePath: '',
      getDoc: vi.fn().mockResolvedValue(null),
      query: vi.fn().mockResolvedValue([]),
      setDoc: vi.fn().mockResolvedValue(undefined),
      updateDoc: vi.fn().mockResolvedValue(undefined),
      deleteDoc: vi.fn().mockResolvedValue(undefined),
      runTransaction: vi.fn().mockResolvedValue(undefined),
      createBatch: vi.fn(),
      subgraph: vi.fn(),
      removeNodeCascade: vi.fn(),
      bulkRemoveEdges: vi.fn(),
    } as unknown as StorageBackend<C>;
  }

  it('Firestore Standard backend produces GraphClient<FirestoreStandardCapability>', () => {
    const backend = makeBackend<FirestoreStandardCapability>();
    const client = createGraphClient(backend);
    expectTypeOf(client).toEqualTypeOf<GraphClient<FirestoreStandardCapability>>();
    expect(true).toBe(true);
  });

  it('Firestore Enterprise backend produces GraphClient<FirestoreEnterpriseCapability>', () => {
    const backend = makeBackend<FirestoreEnterpriseCapability>();
    const client = createGraphClient(backend);
    expectTypeOf(client).toEqualTypeOf<GraphClient<FirestoreEnterpriseCapability>>();
    expect(true).toBe(true);
  });

  it('SQLite backend produces GraphClient<SqliteCapability>', () => {
    const backend = makeBackend<SqliteCapability>();
    const client = createGraphClient(backend);
    expectTypeOf(client).toEqualTypeOf<GraphClient<SqliteCapability>>();
    expect(true).toBe(true);
  });

  it('Cloudflare DO backend produces GraphClient<CloudflareCapability>', () => {
    const backend = makeBackend<CloudflareCapability>();
    const client = createGraphClient(backend);
    expectTypeOf(client).toEqualTypeOf<GraphClient<CloudflareCapability>>();
    expect(true).toBe(true);
  });

  it('registryMode in options narrows the return type to DynamicGraphClient<C>', () => {
    const backend = makeBackend<FirestoreStandardCapability>();
    const dynamicOptions: GraphClientOptions & { registryMode: DynamicRegistryConfig } = {
      registryMode: { mode: 'dynamic' },
    };
    const client = createGraphClient(backend, dynamicOptions);
    expectTypeOf(client).toEqualTypeOf<DynamicGraphClient<FirestoreStandardCapability>>();
    expect(true).toBe(true);
  });

  it('default Capability parameter yields the permissive (full-surface) GraphClient', () => {
    // Backends that haven't been narrowed (e.g. legacy callers, or
    // ad-hoc backends typed as plain `StorageBackend`) keep working —
    // their `C` defaults to the full `Capability` union, so every
    // extension is intersected in.
    const backend: StorageBackend = makeBackend();
    const client = createGraphClient(backend);
    expectTypeOf(client).toEqualTypeOf<GraphClient<Capability>>();
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-backend assignability
// ---------------------------------------------------------------------------

describe('GraphClient<C> assignability tracks the capability union', () => {
  // The `Firestore` import is type-only — we never construct one. These
  // tests document the assignability rules so a regression in `types.ts`
  // (e.g. forgetting the conditional intersection on a new extension)
  // is caught at typecheck time.
  type EnterpriseClient = GraphClient<FirestoreEnterpriseCapability>;
  type DOClient = GraphClient<CloudflareCapability>;
  type FullClient = GraphClient<Capability>;
  // Force `Firestore` to count as "used" so eslint/tsc don't strip the
  // import — it documents that the runtime backends still depend on the
  // Firestore types even though this file is purely type-level.
  type _FirestoreShape = Firestore;

  it('the Enterprise and DO clients share an aggregate method (Phase 4) so they are mutually structurally assignable', () => {
    // Both EnterpriseClient and DOClient declare `query.aggregate`. The
    // remaining extension interfaces (Phases 5-10) are still empty, so the
    // two surfaces line up exactly. Once a later phase adds a real method
    // behind a capability that's only in one of the two unions, this
    // assertion will start to fail (intentionally) and should be split.
    expectTypeOf<DOClient>().toMatchTypeOf<EnterpriseClient>();
    expectTypeOf<EnterpriseClient>().toMatchTypeOf<DOClient>();
    expect(true).toBe(true);
  });

  it('the permissive (Capability) client subsumes every narrowed shape', () => {
    expectTypeOf<EnterpriseClient>().toMatchTypeOf<FullClient>();
    expectTypeOf<DOClient>().toMatchTypeOf<FullClient>();
    expect(true).toBe(true);
  });

  it('GraphClient<core-only-cap> exposes only CoreGraphClient keys (no extension leak)', () => {
    // Positive narrowing pin: when `C` contains *no* extension capability,
    // every conditional in `GraphClient<C>` evaluates to its empty `object`
    // branch, so the resulting key set must equal `keyof CoreGraphClient`.
    // A regression that drops a conditional gate (e.g. forgetting
    // `'query.aggregate' extends C ? … : object`) would cause keys from
    // `AggregateExtension` to leak in even when `C` doesn't declare it.
    type CoreOnlyClient = GraphClient<'core.read' | 'core.write'>;
    expectTypeOf<keyof CoreOnlyClient>().toEqualTypeOf<keyof CoreGraphClient>();
    expect(true).toBe(true);
  });

  it('GraphClient<C> with query.aggregate exposes the aggregate method', () => {
    // Phase 4 ships `aggregate()` behind `query.aggregate`. Cloudflare,
    // SQLite, and both Firestore editions all declare it, so the gated
    // method must show up on each narrowed client.
    type CapWithAgg = GraphClient<'core.read' | 'core.write' | 'query.aggregate'>;
    expectTypeOf<CapWithAgg>().toHaveProperty('aggregate');
    expectTypeOf<DOClient>().toHaveProperty('aggregate');
    expectTypeOf<EnterpriseClient>().toHaveProperty('aggregate');

    // Negative pin: the method is absent when the capability isn't declared.
    // We can't directly assert "key X is not on T" with expectTypeOf without
    // tripping a hidden property; the equality with `keyof CoreGraphClient`
    // above already encodes that — `aggregate` is not on `CoreGraphClient`,
    // so the previous test would fail if the conditional gate broke.
    expect(true).toBe(true);
  });

  it('Cloudflare client (only core caps + query.aggregate) is locked to CoreGraphClient + AggregateExtension keys', () => {
    // CloudflareCapability declares only the core caps plus `query.aggregate`.
    // No matter what methods Phases 5-10 add to `DmlExtension`, `JoinExtension`,
    // etc., the key set of `GraphClient<CloudflareCapability>` must remain
    // `keyof CoreGraphClient | 'aggregate'`. This is the test that survives
    // future extension growth and guards the Cloudflare contract going forward.
    type ExpectedKeys = keyof CoreGraphClient | 'aggregate';
    expectTypeOf<keyof DOClient>().toEqualTypeOf<ExpectedKeys>();
    expect(true).toBe(true);
  });
});
