/**
 * Public `firegraph/backend` surface guard.
 *
 * `StorageBackend` and friends graduated from an internal-only type to a
 * public, versioned contract when `firegraph/backend` was introduced. Any
 * accidental breaking change to the shape (field rename, required ->
 * optional, method signature drift) would ship as a patch-level release
 * and silently break downstream backend implementations.
 *
 * This file pulls double duty:
 *
 *   1. **Compile-time shape lock.** The `satisfies`-anchored type fixtures
 *      below force `tsc --noEmit` to fail if the public interfaces drift
 *      in an incompatible way. `pnpm typecheck` runs these as part of the
 *      ordinary CI step — no extra toolchain needed.
 *
 *   2. **Runtime export manifest.** A tiny vitest assertion verifies that
 *      every expected name is actually exported from `../../src/backend.js`,
 *      catching the simple class of regression where someone deletes an
 *      export without noticing the re-export barrel.
 */

import { describe, expect, it } from 'vitest';

import type {
  BatchBackend,
  RoutingBackendOptions,
  RoutingContext,
  StorageBackend,
  StorageScopeSegment,
  TransactionBackend,
  UpdatePayload,
  WritableRecord,
  WriteMode,
} from '../../src/backend.js';
import * as backend from '../../src/backend.js';
import { flattenPatch } from '../../src/internal/write-plan.js';
import type {
  BulkOptions,
  BulkResult,
  CascadeResult,
  FindEdgesParams,
  GraphReader,
  QueryFilter,
  QueryOptions,
  StoredGraphRecord,
} from '../../src/types.js';

// ---- 1. Compile-time shape lock ------------------------------------------

/**
 * If `StorageBackend` drops a method, renames one, or tightens a signature
 * in an incompatible way, this fixture stops compiling. The point of the
 * `satisfies` is to check the full shape without widening the inferred type.
 */
const _storageBackendShape = {
  collectionPath: '' as string,
  scopePath: '' as string,
  getDoc: async (_docId: string): Promise<StoredGraphRecord | null> => null,
  query: async (
    _filters: QueryFilter[],
    _options?: QueryOptions,
  ): Promise<StoredGraphRecord[]> => [],
  setDoc: async (_docId: string, _record: WritableRecord, _mode: WriteMode): Promise<void> => {
    /* noop */
  },
  updateDoc: async (_docId: string, _update: UpdatePayload): Promise<void> => {
    /* noop */
  },
  deleteDoc: async (_docId: string): Promise<void> => {
    /* noop */
  },
  runTransaction: async <T>(fn: (tx: TransactionBackend) => Promise<T>): Promise<T> =>
    fn(_transactionBackendShape),
  createBatch: (): BatchBackend => _batchBackendShape,
  subgraph: (_parent: string, _name: string): StorageBackend =>
    _storageBackendShape as StorageBackend,
  removeNodeCascade: async (
    _uid: string,
    _reader: GraphReader,
    _options?: BulkOptions,
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
    _options?: BulkOptions,
  ): Promise<BulkResult> => ({ deleted: 0, batches: 0, errors: [] }),
  findEdgesGlobal: async (
    _params: FindEdgesParams,
    _collectionName?: string,
  ): Promise<StoredGraphRecord[]> => [],
} satisfies StorageBackend;

const _transactionBackendShape = {
  getDoc: async (_docId: string): Promise<StoredGraphRecord | null> => null,
  query: async (
    _filters: QueryFilter[],
    _options?: QueryOptions,
  ): Promise<StoredGraphRecord[]> => [],
  setDoc: async (_docId: string, _record: WritableRecord, _mode: WriteMode): Promise<void> => {
    /* noop */
  },
  updateDoc: async (_docId: string, _update: UpdatePayload): Promise<void> => {
    /* noop */
  },
  deleteDoc: async (_docId: string): Promise<void> => {
    /* noop */
  },
} satisfies TransactionBackend;

const _batchBackendShape = {
  setDoc: (_docId: string, _record: WritableRecord, _mode: WriteMode): void => {
    /* noop */
  },
  updateDoc: (_docId: string, _update: UpdatePayload): void => {
    /* noop */
  },
  deleteDoc: (_docId: string): void => {
    /* noop */
  },
  commit: async (): Promise<void> => {
    /* noop */
  },
} satisfies BatchBackend;

const _writableRecordShape = {
  aType: '',
  aUid: '',
  axbType: '',
  bType: '',
  bUid: '',
  data: {} as Record<string, unknown>,
  v: 0 as number | undefined,
} satisfies WritableRecord;

const _updatePayloadEmpty = {} satisfies UpdatePayload;
const _updatePayloadFields = {
  dataOps: flattenPatch({ foo: 1 }),
} satisfies UpdatePayload;
const _updatePayloadReplace = {
  replaceData: { foo: 1 },
  v: 3,
} satisfies UpdatePayload;

const _routingContextShape = {
  parentUid: '',
  subgraphName: '',
  scopePath: '',
  storageScope: '',
} satisfies RoutingContext;

const _routingOptionsShape = {
  route: (_ctx: RoutingContext): StorageBackend | null => null,
} satisfies RoutingBackendOptions;

// Confirm `StorageBackend.findEdgesGlobal` is optional — callers omitting
// it must still satisfy the type. If this ever becomes required the block
// will stop compiling.
const _storageBackendWithoutGlobal = {
  ..._storageBackendShape,
  findEdgesGlobal: undefined,
} satisfies StorageBackend;

const _segmentShape = { uid: '', name: '' } satisfies StorageScopeSegment;

// Mark fixtures as "used" so strict mode doesn't complain.
void _storageBackendShape;
void _transactionBackendShape;
void _batchBackendShape;
void _writableRecordShape;
void _updatePayloadEmpty;
void _updatePayloadFields;
void _updatePayloadReplace;
void _routingContextShape;
void _routingOptionsShape;
void _storageBackendWithoutGlobal;
void _segmentShape;

// ---- 2. Runtime export manifest ------------------------------------------

describe('firegraph/backend — public export surface', () => {
  it('exports the routing primitive and scope-path helpers', () => {
    expect(typeof backend.createRoutingBackend).toBe('function');
    expect(typeof backend.parseStorageScope).toBe('function');
    expect(typeof backend.resolveAncestorScope).toBe('function');
    expect(typeof backend.isAncestorScopeUid).toBe('function');
    expect(typeof backend.appendStorageScope).toBe('function');
  });

  it('re-exports CrossBackendTransactionError for app-level catching', () => {
    expect(typeof backend.CrossBackendTransactionError).toBe('function');
    const err = new backend.CrossBackendTransactionError('test');
    expect(err.code).toBe('CROSS_BACKEND_TRANSACTION');
    expect(err.name).toBe('CrossBackendTransactionError');
  });

  it('does not leak internal symbols onto the public surface', () => {
    // These are runtime symbols only — if anyone adds them to `src/backend.ts`
    // they should show up here; the exact list doubles as documentation of
    // what's deliberately *not* exported.
    const keys = Object.keys(backend).sort();
    expect(keys).toEqual(
      [
        'CrossBackendTransactionError',
        'DELETE_FIELD',
        'appendStorageScope',
        'createRoutingBackend',
        'deleteField',
        'flattenPatch',
        'isAncestorScopeUid',
        'isDeleteSentinel',
        'parseStorageScope',
        'resolveAncestorScope',
      ].sort(),
    );
  });
});
