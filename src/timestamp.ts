/**
 * Backend-agnostic timestamp.
 *
 * Structurally compatible with `@google-cloud/firestore`'s `Timestamp` so
 * that records returned by either the Firestore or SQLite backend can be
 * consumed through the same `StoredGraphRecord` shape.
 *
 * Firestore's native `Timestamp` already satisfies this interface, so
 * existing Firestore consumers see no behavior change. The SQLite backend
 * returns instances of `GraphTimestampImpl` which also satisfies it.
 */

export interface GraphTimestamp {
  readonly seconds: number;
  readonly nanoseconds: number;
  toDate(): Date;
  toMillis(): number;
}

/**
 * Concrete `GraphTimestamp` implementation used by non-Firestore backends.
 * Mirrors the surface of Firestore's `Timestamp` enough for typical use.
 */
export class GraphTimestampImpl implements GraphTimestamp {
  constructor(
    public readonly seconds: number,
    public readonly nanoseconds: number,
  ) {}

  toDate(): Date {
    return new Date(this.toMillis());
  }

  toMillis(): number {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
  }

  toJSON(): { seconds: number; nanoseconds: number } {
    return { seconds: this.seconds, nanoseconds: this.nanoseconds };
  }

  static fromMillis(ms: number): GraphTimestampImpl {
    const seconds = Math.floor(ms / 1000);
    const nanoseconds = (ms - seconds * 1000) * 1e6;
    return new GraphTimestampImpl(seconds, nanoseconds);
  }

  static now(): GraphTimestampImpl {
    return GraphTimestampImpl.fromMillis(Date.now());
  }
}

/**
 * Sentinel returned by `StorageBackend.serverTimestamp()` when the backend
 * has no native server-time concept and just wants a placeholder that the
 * adapter resolves to a concrete time at write commit. SQLite backends
 * substitute the wall-clock millis at the moment of `setDoc`/`updateDoc`.
 */
export const SERVER_TIMESTAMP_SENTINEL = Symbol.for('firegraph.serverTimestamp');
export type ServerTimestampSentinel = typeof SERVER_TIMESTAMP_SENTINEL;

export function isServerTimestampSentinel(value: unknown): value is ServerTimestampSentinel {
  return value === SERVER_TIMESTAMP_SENTINEL;
}
