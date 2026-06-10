/**
 * DO RPC wire helpers for the Cloudflare backend.
 *
 * SQL compilation lives in the shared scope-free compiler
 * (`src/internal/sqlite-sql.ts`) — every `FiregraphDO` owns one SQLite
 * database holding exactly one subgraph's triples, the same one-table /
 * one-graph shape the shared SQLite edition uses, so the compilers are
 * identical. This module keeps only what is specific to crossing the DO
 * RPC boundary: the structured-clone-safe record shape and its
 * serialize / hydrate pair.
 */

import { rowTimestampToMillis } from '../internal/sqlite-sql.js';
import { type GraphTimestamp, GraphTimestampImpl } from '../timestamp.js';
import type { StoredGraphRecord } from '../types.js';

export type { CompiledStatement } from '../internal/sqlite-sql.js';

/**
 * Wire representation of a stored record across the DO RPC boundary.
 *
 * Durable Object RPC uses structured clone, which preserves plain data but
 * drops user-defined class prototypes — a `GraphTimestampImpl` from the DO
 * arrives at the client as a plain `{seconds, nanoseconds}` object without
 * its `toMillis()` / `toDate()` methods. To avoid silent `.toMillis is not a
 * function` crashes downstream, records returned from DO RPC carry the two
 * timestamps as plain millisecond numbers in `createdAtMs` / `updatedAtMs`;
 * the client-side backend rewraps them as `GraphTimestampImpl` via
 * `hydrateDORecord` before handing the record to the GraphClient.
 */
export interface DORecordWire {
  aType: string;
  aUid: string;
  axbType: string;
  bType: string;
  bUid: string;
  data: Record<string, unknown>;
  v?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * Convert a SQLite row into a `DORecordWire` — the wire-safe shape returned
 * across DO RPC. Timestamps stay as plain millisecond numbers here; the
 * client-side backend calls `hydrateDORecord` to rewrap them as
 * `GraphTimestampImpl` before surfacing the record to the GraphClient.
 *
 * Splitting serialization from hydration like this is what lets the DO
 * return values safely through structured clone without pretending its
 * output is a full `StoredGraphRecord`.
 */
export function rowToDORecord(row: Record<string, unknown>): DORecordWire {
  const dataString = row.data as string | null;
  const data = dataString ? (JSON.parse(dataString) as Record<string, unknown>) : {};

  const createdAtMs = rowTimestampToMillis(row.created_at);
  const updatedAtMs = rowTimestampToMillis(row.updated_at);

  const record: DORecordWire = {
    aType: row.a_type as string,
    aUid: row.a_uid as string,
    axbType: row.axb_type as string,
    bType: row.b_type as string,
    bUid: row.b_uid as string,
    data,
    createdAtMs,
    updatedAtMs,
  };

  if (row.v !== null && row.v !== undefined) {
    record.v = Number(row.v);
  }
  return record;
}

/**
 * Rewrap a `DORecordWire` as a full `StoredGraphRecord`, restoring
 * `GraphTimestampImpl` instances from the wire-level millisecond numbers.
 * Called by `DORPCBackend` on every record returned from a DO RPC.
 */
export function hydrateDORecord(wire: DORecordWire): StoredGraphRecord {
  const record: Record<string, unknown> = {
    aType: wire.aType,
    aUid: wire.aUid,
    axbType: wire.axbType,
    bType: wire.bType,
    bUid: wire.bUid,
    data: wire.data,
    createdAt: GraphTimestampImpl.fromMillis(wire.createdAtMs) as unknown as GraphTimestamp,
    updatedAt: GraphTimestampImpl.fromMillis(wire.updatedAtMs) as unknown as GraphTimestamp,
  };
  if (wire.v !== undefined) {
    record.v = wire.v;
  }
  return record as unknown as StoredGraphRecord;
}
