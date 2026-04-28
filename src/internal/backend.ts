/**
 * Backend abstraction for firegraph.
 *
 * `StorageBackend` is the single interface every storage driver implements.
 * The Firestore backend wraps `@google-cloud/firestore`; the SQLite backend
 * (shared by D1 and Durable Object SQLite) uses a parameterized SQL executor.
 *
 * `GraphClientImpl` and friends depend only on this interface — they have
 * no direct knowledge of Firestore or SQLite.
 */

import type {
  BulkOptions,
  BulkResult,
  CascadeResult,
  FindEdgesParams,
  GraphReader,
  QueryFilter,
  QueryOptions,
  StoredGraphRecord,
} from '../types.js';
import type { DataPathOp } from './write-plan.js';

/**
 * Per-record write payload — backend-agnostic. Timestamps are not present;
 * the backend supplies them via `serverTimestamp()` placeholders that it
 * itself resolves at commit time.
 */
export interface WritableRecord {
  aType: string;
  aUid: string;
  axbType: string;
  bType: string;
  bUid: string;
  data: Record<string, unknown>;
  /** Schema version (set by the writer when registry has migrations). */
  v?: number;
}

/**
 * Write semantics for `setDoc`.
 *
 *   - `'merge'` — the new contract (0.12+). Existing fields not mentioned
 *     in the new data survive; nested objects are recursively merged;
 *     arrays are replaced as a unit. This is the default for
 *     `putNode` / `putEdge`.
 *   - `'replace'` — the document is replaced wholesale, dropping any
 *     fields not present in the payload. This is the explicit escape
 *     hatch surfaced as `replaceNode` / `replaceEdge` and used by
 *     migration write-back.
 */
export type WriteMode = 'merge' | 'replace';

/**
 * Patch shape for `updateDoc`.
 *
 *   - `dataOps`: list of deep-path terminal ops produced by
 *     `flattenPatch()` (one op per leaf — arrays / primitives / Firestore
 *     special types are terminal). Used by `updateNode` / `updateEdge`.
 *     Sibling keys at every depth are preserved.
 *   - `replaceData`: full `data` replacement. Used only by the migration
 *     write-back path, which has already produced a complete migrated
 *     document.
 *   - `v`: optional schema-version stamp.
 *
 * `updatedAt` is always set by the backend.
 */
export interface UpdatePayload {
  dataOps?: DataPathOp[];
  replaceData?: Record<string, unknown>;
  v?: number;
}

/**
 * Read/write transaction adapter. Mirrors Firestore's transaction semantics:
 * reads are snapshot-consistent; writes are issued inside the transaction
 * and a rejection from any write aborts the surrounding `runTransaction`.
 *
 * Writes return `Promise<void>` so SQL drivers can surface row-level errors
 * (constraint violations, malformed JSON paths) rather than swallowing them.
 * Firestore implementations can resolve synchronously since the underlying
 * `Transaction.set/update/delete` calls are themselves synchronous buffers.
 */
export interface TransactionBackend {
  getDoc(docId: string): Promise<StoredGraphRecord | null>;
  query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]>;
  setDoc(docId: string, record: WritableRecord, mode: WriteMode): Promise<void>;
  updateDoc(docId: string, update: UpdatePayload): Promise<void>;
  deleteDoc(docId: string): Promise<void>;
}

/**
 * Atomic multi-write batch.
 */
export interface BatchBackend {
  setDoc(docId: string, record: WritableRecord, mode: WriteMode): void;
  updateDoc(docId: string, update: UpdatePayload): void;
  deleteDoc(docId: string): void;
  commit(): Promise<void>;
}

/**
 * The single storage abstraction.
 *
 * Each backend instance is scoped to a "graph location" — for Firestore
 * that's a collection path; for SQLite it's a (table, scopePath) pair.
 * `subgraph()` returns a child backend bound to a nested location.
 */
export interface StorageBackend {
  /** Backend-internal location identifier (collection path or table name). */
  readonly collectionPath: string;
  /** Subgraph scope (empty string for root). */
  readonly scopePath: string;

  // --- Reads ---
  getDoc(docId: string): Promise<StoredGraphRecord | null>;
  query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]>;

  // --- Writes ---
  setDoc(docId: string, record: WritableRecord, mode: WriteMode): Promise<void>;
  updateDoc(docId: string, update: UpdatePayload): Promise<void>;
  deleteDoc(docId: string): Promise<void>;

  // --- Transactions & batches ---
  runTransaction<T>(fn: (tx: TransactionBackend) => Promise<T>): Promise<T>;
  createBatch(): BatchBackend;

  // --- Subgraphs ---
  subgraph(parentNodeUid: string, name: string): StorageBackend;

  // --- Cascade & bulk ---
  removeNodeCascade(
    uid: string,
    reader: GraphReader,
    options?: BulkOptions,
  ): Promise<CascadeResult>;
  bulkRemoveEdges(
    params: FindEdgesParams,
    reader: GraphReader,
    options?: BulkOptions,
  ): Promise<BulkResult>;

  // --- Cross-collection queries ---
  /**
   * Find edges across all subgraphs sharing a given collection name.
   * Optional — backends that can't support this should throw a clear error.
   */
  findEdgesGlobal?(params: FindEdgesParams, collectionName?: string): Promise<StoredGraphRecord[]>;
}
