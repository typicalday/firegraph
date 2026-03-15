import { describe, it, expect, afterAll } from 'vitest';
import { Timestamp, GeoPoint, FieldValue } from '@google-cloud/firestore';
import {
  defaultExecutor,
  compileMigrationFn,
  compileMigrations,
  precompileSource,
  destroySandboxWorker,
} from '../../src/sandbox.js';
import { SERIALIZATION_TAG } from '../../src/serialization.js';
import { MigrationError } from '../../src/errors.js';

// Cleanup: terminate the sandbox worker after all tests so vitest doesn't hang.
afterAll(async () => {
  await destroySandboxWorker();
});

// ---------------------------------------------------------------------------
// defaultExecutor
// ---------------------------------------------------------------------------

describe('defaultExecutor', () => {
  it('compiles and runs an arrow function', async () => {
    const fn = defaultExecutor('(data) => ({ ...data, status: "draft" })');
    expect(typeof fn).toBe('function');
    const result = await fn({ title: 'hello' });
    expect(result).toEqual({ title: 'hello', status: 'draft' });
  });

  it('compiles and runs a function declaration', async () => {
    const fn = defaultExecutor('function(data) { return { ...data, x: 1 }; }');
    expect(typeof fn).toBe('function');
    expect(await fn({})).toEqual({ x: 1 });
  });

  it('compiles and runs an async arrow function', async () => {
    const fn = defaultExecutor('async (data) => ({ ...data, async: true })');
    const result = await fn({});
    expect(result).toEqual({ async: true });
  });

  it('rejects with MigrationError for malformed source', async () => {
    const fn = defaultExecutor('not a function {');
    await expect(fn({})).rejects.toThrow(MigrationError);
  });

  it('rejects with MigrationError when source produces non-function', async () => {
    const fn = defaultExecutor('"hello"');
    await expect(fn({})).rejects.toThrow(MigrationError);
  });
});

// ---------------------------------------------------------------------------
// defaultExecutor — sandbox isolation
// Note: lockdown() runs inside a dedicated worker thread, so the main
// process's intrinsics remain completely unaffected.
// ---------------------------------------------------------------------------

describe('defaultExecutor — sandbox isolation', () => {
  it('blocks access to process', async () => {
    const fn = defaultExecutor('(d) => ({ ...d, pid: typeof process })');
    const result = await fn({ x: 1 });
    expect(result).toEqual({ x: 1, pid: 'undefined' });
  });

  it('blocks access to require', async () => {
    const fn = defaultExecutor('(d) => ({ ...d, req: typeof require })');
    const result = await fn({ x: 1 });
    expect(result).toEqual({ x: 1, req: 'undefined' });
  });

  it('blocks access to globalThis properties', async () => {
    const fn = defaultExecutor('(d) => ({ ...d, ft: typeof fetch, st: typeof setTimeout })');
    const result = await fn({});
    expect(result).toEqual({ ft: 'undefined', st: 'undefined' });
  });

  it('blocks prototype chain escape via data argument', async () => {
    // Classic escape: d.constructor.constructor('return this')().process
    // With JSON marshaling, d is parsed inside the compartment — its
    // prototype chain stays within the compartment scope, not the host.
    const fn = defaultExecutor(
      `(d) => {
        try {
          var g = d.constructor.constructor('return this')();
          return { escaped: true, hasProcess: typeof g.process !== 'undefined' };
        } catch (e) {
          return { escaped: false, error: e.message };
        }
      }`,
    );
    const result = await fn({ x: 1 });
    // The escape may succeed in reaching the vm's global, but there's no
    // process/require/fetch there — so it's harmless
    if ((result as Record<string, unknown>).escaped) {
      expect((result as Record<string, unknown>).hasProcess).toBe(false);
    } else {
      // If it threw, that's also fine
      expect((result as Record<string, unknown>).escaped).toBe(false);
    }
  });

  it('rejects direct eval expressions at compile time', async () => {
    // SES statically rejects direct eval() expressions in
    // compartment.evaluate() source — they are caught before execution.
    const fn = defaultExecutor(`(d) => { var r = eval('1+1'); return { ...d, r }; }`);
    await expect(fn({})).rejects.toThrow(MigrationError);
  });

  it('blocks dynamic code generation via prototype chain', async () => {
    // After lockdown(), Function.prototype.constructor is neutered.
    // This prevents d.constructor.constructor('...') from generating
    // new code that could escape the compartment.
    const fn = defaultExecutor(
      `(d) => {
        try {
          var Ctor = d.constructor.constructor;
          var f = Ctor('return 1');
          return { ...d, escaped: true, r: f() };
        } catch(e) {
          return { ...d, blocked: true, error: e.message };
        }
      }`,
    );
    const result = await fn({ x: 1 }) as Record<string, unknown>;
    // lockdown() makes Function.prototype.constructor throw
    expect(result.blocked).toBe(true);
  });

  it('preserves JSON-serializable data through marshaling', async () => {
    const fn = defaultExecutor('(d) => ({ ...d, added: true })');
    const input = { str: 'hello', num: 42, arr: [1, 2], nested: { a: 1 } };
    const result = await fn(input);
    expect(result).toEqual({ ...input, added: true });
  });

  it('wraps runtime errors from migration function in MigrationError', async () => {
    const fn = defaultExecutor('(d) => { throw new Error("boom"); }');
    await expect(fn({ x: 1 })).rejects.toThrow(MigrationError);
  });

  it('wraps non-JSON-serializable return in MigrationError', async () => {
    // undefined is not JSON-serializable — JSON.stringify returns undefined
    const fn = defaultExecutor('(d) => undefined');
    await expect(fn({ x: 1 })).rejects.toThrow(MigrationError);
  });

  it('blocks dynamic import() expressions', async () => {
    // SES statically rejects import() expressions at compile time,
    // preventing migration code from loading external modules.
    const fn = defaultExecutor('async (d) => { const m = await import("fs"); return d; }');
    await expect(fn({})).rejects.toThrow(MigrationError);
  });
});

// ---------------------------------------------------------------------------
// precompileSource
// ---------------------------------------------------------------------------

describe('precompileSource', () => {
  it('resolves for valid source', async () => {
    await expect(precompileSource('(d) => ({ ...d, ok: true })')).resolves.toBeUndefined();
  });

  it('rejects with MigrationError for malformed source', async () => {
    await expect(precompileSource('not valid {')).rejects.toThrow(MigrationError);
  });

  it('rejects with MigrationError for non-function source', async () => {
    await expect(precompileSource('"hello"')).rejects.toThrow(MigrationError);
  });

  it('rejects with MigrationError for eval expressions', async () => {
    await expect(
      precompileSource(`(d) => { var r = eval('1+1'); return { ...d, r }; }`),
    ).rejects.toThrow(MigrationError);
  });

  it('rejects with MigrationError for import() expressions', async () => {
    await expect(
      precompileSource('async (d) => { const m = await import("fs"); return d; }'),
    ).rejects.toThrow(MigrationError);
  });

  it('uses custom executor when provided', async () => {
    let called = false;
    const customExecutor = (source: string) => {
      called = true;
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return new Function('return ' + source)() as (d: Record<string, unknown>) => Record<string, unknown>;
    };

    await precompileSource('(d) => d', customExecutor);
    expect(called).toBe(true);
  });

  it('wraps non-MigrationError from custom executor', async () => {
    const badExecutor = () => {
      throw new Error('bad executor');
    };

    await expect(precompileSource('(d) => d', badExecutor)).rejects.toThrow(MigrationError);
  });
});

// ---------------------------------------------------------------------------
// compileMigrationFn
// ---------------------------------------------------------------------------

describe('compileMigrationFn', () => {
  it('compiles and returns executable function', async () => {
    const fn = compileMigrationFn('(d) => ({ ...d, compiled: true })');
    expect(await fn({ a: 1 })).toEqual({ a: 1, compiled: true });
  });

  it('caches compiled functions by source', () => {
    const source = '(d) => ({ ...d, cached: true })';
    const fn1 = compileMigrationFn(source);
    const fn2 = compileMigrationFn(source);
    expect(fn1).toBe(fn2); // same reference = cache hit
  });

  it('uses custom executor when provided', () => {
    let executorCalled = false;
    const customExecutor = (source: string) => {
      executorCalled = true;
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return new Function('return ' + source)() as (d: Record<string, unknown>) => Record<string, unknown>;
    };

    // Use a unique source to avoid cache
    const fn = compileMigrationFn('(d) => ({ ...d, custom: true })', customExecutor);
    expect(executorCalled).toBe(true);
    expect(fn({})).toEqual({ custom: true });
  });

  it('isolates caches per executor (no cross-executor poisoning)', () => {
    const source = '(d) => ({ ...d, isolated: true })';
    let executorACalls = 0;
    let executorBCalls = 0;

    const executorA = (s: string) => {
      executorACalls++;
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return new Function('return ' + s)() as (d: Record<string, unknown>) => Record<string, unknown>;
    };
    const executorB = (s: string) => {
      executorBCalls++;
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return new Function('return ' + s)() as (d: Record<string, unknown>) => Record<string, unknown>;
    };

    const fnA = compileMigrationFn(source, executorA);
    const fnB = compileMigrationFn(source, executorB);

    // Both executors should have been called (no cross-pollination)
    expect(executorACalls).toBe(1);
    expect(executorBCalls).toBe(1);
    // Same source, different executors → different function references
    expect(fnA).not.toBe(fnB);
  });

  it('wraps non-MigrationError from executor', () => {
    const badExecutor = () => {
      throw new Error('bad executor');
    };

    expect(() =>
      compileMigrationFn('(d) => d', badExecutor),
    ).toThrow(MigrationError);
  });
});

// ---------------------------------------------------------------------------
// compileMigrations
// ---------------------------------------------------------------------------

describe('compileMigrations', () => {
  it('compiles an array of stored migration steps', async () => {
    const stored = [
      { fromVersion: 0, toVersion: 1, up: '(d) => ({ ...d, v1: true })' },
      { fromVersion: 1, toVersion: 2, up: '(d) => ({ ...d, v2: true })' },
    ];

    const steps = compileMigrations(stored);
    expect(steps).toHaveLength(2);
    expect(steps[0].fromVersion).toBe(0);
    expect(steps[0].toVersion).toBe(1);
    expect(typeof steps[0].up).toBe('function');
    expect(await steps[0].up({})).toEqual({ v1: true });
    expect(await steps[1].up({})).toEqual({ v2: true });
  });

  it('returns empty array for empty input', () => {
    expect(compileMigrations([])).toEqual([]);
  });

  it('passes custom executor through', () => {
    let calls = 0;
    const countingExecutor = (source: string) => {
      calls++;
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return new Function('return ' + source)() as (d: Record<string, unknown>) => Record<string, unknown>;
    };

    // Use unique sources to avoid cache
    const stored = [
      { fromVersion: 0, toVersion: 1, up: '(d) => ({ ...d, count1: true })' },
      { fromVersion: 1, toVersion: 2, up: '(d) => ({ ...d, count2: true })' },
    ];

    compileMigrations(stored, countingExecutor);
    expect(calls).toBe(2);
  });

  it('throws MigrationError when a source string is syntactically invalid (custom executor)', () => {
    const stored = [
      { fromVersion: 0, toVersion: 1, up: '(d) => ({ ...d, ok: true })' },
      { fromVersion: 1, toVersion: 2, up: 'not valid {' },
    ];

    // With custom executor, compile errors surface synchronously at
    // compileMigrations time. With defaultExecutor, validation is deferred
    // to execution time — use precompileSource() for eager validation.
    const syncExecutor = (source: string) => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return new Function('return ' + source)() as (d: Record<string, unknown>) => Record<string, unknown>;
    };

    expect(() => compileMigrations(stored, syncExecutor)).toThrow(MigrationError);
  });

  it('with default executor, invalid source errors surface at execution time', async () => {
    // defaultExecutor defers validation to the worker — compileMigrations
    // succeeds, but the compiled function rejects when called.
    const stored = [
      { fromVersion: 0, toVersion: 1, up: 'not valid {' },
    ];

    const steps = compileMigrations(stored);
    expect(steps).toHaveLength(1);
    expect(typeof steps[0].up).toBe('function');
    // Error surfaces at call time, not compile time
    await expect(steps[0].up({})).rejects.toThrow(MigrationError);
  });

  it('precompileSource catches invalid source eagerly with default executor', async () => {
    // The recommended pattern: precompileSource for eager validation,
    // then compileMigrations for the actual function references.
    await expect(precompileSource('not valid {')).rejects.toThrow(MigrationError);
  });
});

// ---------------------------------------------------------------------------
// Worker crash recovery
// ---------------------------------------------------------------------------

describe('worker crash recovery', () => {
  it('recovers from worker termination and processes subsequent requests', async () => {
    // First call: ensure the worker is spawned and functional
    const fn1 = defaultExecutor('(d) => ({ ...d, first: true })');
    expect(await fn1({})).toEqual({ first: true });

    // Terminate the worker mid-session
    await destroySandboxWorker();

    // Subsequent call should spawn a new worker and succeed
    const fn2 = defaultExecutor('(d) => ({ ...d, recovered: true })');
    expect(await fn2({})).toEqual({ recovered: true });
  });

  it('handles concurrent executions correctly', async () => {
    // Fire multiple migration functions concurrently
    const fns = [
      defaultExecutor('(d) => ({ ...d, idx: 1 })'),
      defaultExecutor('(d) => ({ ...d, idx: 2 })'),
      defaultExecutor('(d) => ({ ...d, idx: 3 })'),
    ];

    const results = await Promise.all(fns.map((fn) => fn({})));
    expect(results).toEqual([{ idx: 1 }, { idx: 2 }, { idx: 3 }]);
  });
});

// ---------------------------------------------------------------------------
// Firestore type preservation through sandbox
// ---------------------------------------------------------------------------

describe('defaultExecutor — Firestore type preservation', () => {
  it('preserves Timestamp through sandbox round-trip', async () => {
    const fn = defaultExecutor('(d) => ({ ...d, added: true })');
    const input = { createdAt: new Timestamp(1700000000, 123456789), name: 'test' };
    const result = await fn(input);
    expect(result.added).toBe(true);
    expect(result.name).toBe('test');
    // Timestamp should be reconstructed on the host side
    expect(result.createdAt).toBeInstanceOf(Timestamp);
    const ts = result.createdAt as Timestamp;
    expect(ts.seconds).toBe(1700000000);
    expect(ts.nanoseconds).toBe(123456789);
  });

  it('preserves GeoPoint through sandbox round-trip', async () => {
    const fn = defaultExecutor('(d) => ({ ...d, processed: true })');
    const input = { location: new GeoPoint(37.7749, -122.4194) };
    const result = await fn(input);
    expect(result.processed).toBe(true);
    expect(result.location).toBeInstanceOf(GeoPoint);
    const gp = result.location as GeoPoint;
    expect(gp.latitude).toBe(37.7749);
    expect(gp.longitude).toBe(-122.4194);
  });

  it('preserves VectorValue through sandbox round-trip', async () => {
    const vector = FieldValue.vector([1.5, 2.5, 3.5]);
    const fn = defaultExecutor('(d) => ({ ...d, scored: true })');
    const input = { embedding: vector };
    const result = await fn(input);
    expect(result.scored).toBe(true);
    expect((result.embedding as Record<string, unknown>).constructor?.name).toBe('VectorValue');
  });

  it('migration function can read tagged Timestamp values', async () => {
    // Inside the sandbox, Timestamp appears as a tagged object.
    // The migration can read its fields.
    const fn = defaultExecutor(
      `(d) => ({ ...d, year: Math.floor(d.createdAt.seconds / (365.25 * 86400)) + 1970 })`,
    );
    // 1700000000 seconds ≈ 2023
    const input = { createdAt: new Timestamp(1700000000, 0) };
    const result = await fn(input);
    expect(result.year).toBe(2023);
    // Timestamp should still be preserved
    expect(result.createdAt).toBeInstanceOf(Timestamp);
  });

  it('migration function can create new tagged Firestore values', async () => {
    // Migration authors can create tagged objects directly using the tag format
    const tag = SERIALIZATION_TAG;
    const fn = defaultExecutor(
      `(d) => ({ ...d, updatedAt: { ${JSON.stringify(tag)}: 'Timestamp', seconds: 2000000000, nanoseconds: 0 } })`,
    );
    const result = await fn({ name: 'test' });
    expect(result.name).toBe('test');
    // The tagged object should be deserialized into a real Timestamp
    expect(result.updatedAt).toBeInstanceOf(Timestamp);
    expect((result.updatedAt as Timestamp).seconds).toBe(2000000000);
  });

  it('preserves complex nested Firestore types', async () => {
    const fn = defaultExecutor('(d) => ({ ...d, migrated: true })');
    const input = {
      name: 'complex',
      meta: {
        created: new Timestamp(1000, 0),
        location: new GeoPoint(10, 20),
      },
      points: [new GeoPoint(1, 2), new GeoPoint(3, 4)],
    };
    const result = await fn(input);
    expect(result.migrated).toBe(true);
    expect(result.name).toBe('complex');

    const meta = result.meta as Record<string, unknown>;
    expect(meta.created).toBeInstanceOf(Timestamp);
    expect(meta.location).toBeInstanceOf(GeoPoint);

    const points = result.points as GeoPoint[];
    expect(points[0]).toBeInstanceOf(GeoPoint);
    expect(points[1]).toBeInstanceOf(GeoPoint);
    expect(points[0].latitude).toBe(1);
    expect(points[1].latitude).toBe(3);
  });

  it('plain data still works (regression guard)', async () => {
    const fn = defaultExecutor('(d) => ({ ...d, added: true })');
    const input = { str: 'hello', num: 42, arr: [1, 2], nested: { a: 1 } };
    const result = await fn(input);
    expect(result).toEqual({ ...input, added: true });
  });
});
