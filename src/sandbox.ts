/**
 * Sandbox module for compiling dynamic registry migration source strings
 * into executable functions.
 *
 * Uses a dedicated worker thread with SES (Secure ECMAScript) Compartments
 * for isolation. SES `lockdown()` and `Compartment` evaluation run in the
 * worker thread so that the host process's intrinsics remain unaffected.
 *
 * Each migration function runs in a hardened compartment with no ambient
 * authority — no access to `process`, `require`, `fetch`, `setTimeout`,
 * or any other host-provided globals. Data crosses the compartment boundary
 * as JSON strings to prevent prototype chain escapes.
 *
 * Static registry migrations are already in-memory functions and never
 * go through this module.
 */

import { createHash } from 'node:crypto';
import type { Worker } from 'node:worker_threads';

import { MigrationError } from './errors.js';
import type * as SerializationModule from './serialization.js';
import type {
  MigrationExecutor,
  MigrationFn,
  MigrationStep,
  StoredMigrationStep,
} from './types.js';

// ---------------------------------------------------------------------------
// Sandbox worker — SES lockdown and Compartment evaluation run in a
// dedicated worker thread so that lockdown() does not affect the host
// process's intrinsics. The worker is spawned lazily on first use.
// ---------------------------------------------------------------------------

let _worker: Worker | null = null;
let _requestId = 0;
const _pending = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }
>();

/**
 * Inline worker source evaluated as CJS in a dedicated worker thread.
 * Contains all SES setup, compilation, and execution logic.
 *
 * **Why inline?** Using `new Worker(code, { eval: true })` avoids
 * ESM/CJS file resolution issues when the library is consumed from
 * different module formats or bundlers.
 */
const WORKER_SOURCE = [
  `'use strict';`,
  `var _wt = require('node:worker_threads');`,
  `var _mod = require('node:module');`,
  `var _crypto = require('node:crypto');`,
  `var parentPort = _wt.parentPort;`,
  `var workerData = _wt.workerData;`,
  ``,
  `// Load SES using the parent module's resolution context`,
  `var esmRequire = _mod.createRequire(workerData.parentUrl);`,
  `esmRequire('ses');`,
  ``,
  `lockdown({`,
  `  errorTaming: 'unsafe',`,
  `  consoleTaming: 'unsafe',`,
  `  evalTaming: 'safe-eval',`,
  `  overrideTaming: 'moderate',`,
  `  stackFiltering: 'verbose'`,
  `});`,
  ``,
  `// Defense-in-depth: verify lockdown() actually hardened JSON.`,
  `if (!Object.isFrozen(JSON)) {`,
  `  throw new Error('SES lockdown failed: JSON is not frozen');`,
  `}`,
  ``,
  `var cache = new Map();`,
  ``,
  `function hashSource(s) {`,
  `  return _crypto.createHash('sha256').update(s).digest('hex');`,
  `}`,
  ``,
  `function buildWrapper(source) {`,
  `  return '(function() {' +`,
  `    '  var fn = (' + source + ');\\n' +`,
  `    '  if (typeof fn !== "function") return null;\\n' +`,
  `    '  return function(jsonIn) {\\n' +`,
  `    '    var data = JSON.parse(jsonIn);\\n' +`,
  `    '    var result = fn(data);\\n' +`,
  `    '    if (result !== null && typeof result === "object" && typeof result.then === "function") {\\n' +`,
  `    '      return result.then(function(r) { return JSON.stringify(r); });\\n' +`,
  `    '    }\\n' +`,
  `    '    return JSON.stringify(result);\\n' +`,
  `    '  };\\n' +`,
  `    '})()';`,
  `}`,
  ``,
  `function compileSource(source) {`,
  `  var key = hashSource(source);`,
  `  var cached = cache.get(key);`,
  `  if (cached) return cached;`,
  ``,
  `  var compartmentFn;`,
  `  try {`,
  `    var c = new Compartment({ JSON: JSON });`,
  `    compartmentFn = c.evaluate(buildWrapper(source));`,
  `  } catch (err) {`,
  `    throw new Error('Failed to compile migration source: ' + (err.message || String(err)));`,
  `  }`,
  ``,
  `  if (typeof compartmentFn !== 'function') {`,
  `    throw new Error('Migration source did not produce a function: ' + source.slice(0, 80));`,
  `  }`,
  ``,
  `  cache.set(key, compartmentFn);`,
  `  return compartmentFn;`,
  `}`,
  ``,
  `parentPort.on('message', function(msg) {`,
  `  var id = msg.id;`,
  `  try {`,
  `    if (msg.type === 'compile') {`,
  `      compileSource(msg.source);`,
  `      parentPort.postMessage({ id: id, type: 'compiled' });`,
  `      return;`,
  `    }`,
  `    if (msg.type === 'execute') {`,
  `      var fn = compileSource(msg.source);`,
  `      var raw;`,
  `      try {`,
  `        raw = fn(msg.jsonData);`,
  `      } catch (err) {`,
  `        parentPort.postMessage({ id: id, type: 'error', message: 'Migration function threw: ' + (err.message || String(err)) });`,
  `        return;`,
  `      }`,
  `      if (raw !== null && typeof raw === 'object' && typeof raw.then === 'function') {`,
  `        raw.then(`,
  `          function(jsonResult) {`,
  `            if (jsonResult === undefined || jsonResult === null) {`,
  `              parentPort.postMessage({ id: id, type: 'error', message: 'Migration returned a non-JSON-serializable value' });`,
  `            } else {`,
  `              parentPort.postMessage({ id: id, type: 'result', jsonResult: jsonResult });`,
  `            }`,
  `          },`,
  `          function(err) {`,
  `            parentPort.postMessage({ id: id, type: 'error', message: 'Async migration function threw: ' + (err.message || String(err)) });`,
  `          }`,
  `        );`,
  `        return;`,
  `      }`,
  `      if (raw === undefined || raw === null) {`,
  `        parentPort.postMessage({ id: id, type: 'error', message: 'Migration returned a non-JSON-serializable value' });`,
  `      } else {`,
  `        parentPort.postMessage({ id: id, type: 'result', jsonResult: raw });`,
  `      }`,
  `    }`,
  `  } catch (err) {`,
  `    parentPort.postMessage({ id: id, type: 'error', message: err.message || String(err) });`,
  `  }`,
  `});`,
].join('\n');

// ---------------------------------------------------------------------------
// Worker lifecycle management
// ---------------------------------------------------------------------------

interface WorkerResponse {
  id: number;
  type: string;
  message?: string;
  jsonResult?: string;
}

// `node:worker_threads` is loaded lazily so this module can be imported in
// runtimes without it (Cloudflare Workers, browsers). Only callers that
// actually exercise the default migration sandbox will trigger the import.
let _WorkerCtor: (new (source: string, opts: Record<string, unknown>) => Worker) | null = null;

async function loadWorkerCtor(): Promise<NonNullable<typeof _WorkerCtor>> {
  if (_WorkerCtor) return _WorkerCtor;
  const wt = await import('node:worker_threads');
  _WorkerCtor = wt.Worker as unknown as NonNullable<typeof _WorkerCtor>;
  return _WorkerCtor;
}

async function ensureWorker(): Promise<Worker> {
  if (_worker) return _worker;

  const Ctor = await loadWorkerCtor();
  _worker = new Ctor(WORKER_SOURCE, {
    eval: true,
    workerData: { parentUrl: import.meta.url },
  });

  // Don't let the worker prevent process exit
  _worker.unref();

  _worker.on('message', (msg: WorkerResponse) => {
    if (msg.id === undefined) return;
    const pending = _pending.get(msg.id);
    if (!pending) return;
    _pending.delete(msg.id);

    if (msg.type === 'error') {
      pending.reject(new MigrationError(msg.message ?? 'Unknown sandbox error'));
    } else {
      pending.resolve(msg);
    }
  });

  _worker.on('error', (err: Error) => {
    // Worker crashed — reject all pending requests and allow respawn
    for (const [, p] of _pending) {
      p.reject(new MigrationError(`Sandbox worker error: ${err.message}`));
    }
    _pending.clear();
    _worker = null;
  });

  _worker.on('exit', (code: number) => {
    // Always reject pending requests — a worker exiting while requests
    // are in-flight is always an error from the caller's perspective,
    // even if the exit code is 0 (e.g., graceful termination).
    if (_pending.size > 0) {
      for (const [, p] of _pending) {
        p.reject(new MigrationError(`Sandbox worker exited with code ${code}`));
      }
      _pending.clear();
    }
    _worker = null;
  });

  return _worker;
}

async function sendToWorker(msg: Record<string, unknown>): Promise<WorkerResponse> {
  const worker = await ensureWorker();
  if (_requestId >= Number.MAX_SAFE_INTEGER) _requestId = 0;
  const id = ++_requestId;
  return new Promise<WorkerResponse>((resolve, reject) => {
    _pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker.postMessage({ ...msg, id });
  });
}

// ---------------------------------------------------------------------------
// Compiled function cache (keyed by executor → SHA-256 hash of source string)
// ---------------------------------------------------------------------------

// Two-level cache: outer key is the executor reference (WeakMap so that
// short-lived executors and their caches can be garbage collected), inner
// key is the SHA-256 hash of the source string. This prevents cache
// poisoning when different clients use different sandbox executors in
// the same process.
const compiledCache = new WeakMap<MigrationExecutor, Map<string, MigrationFn>>();

function getExecutorCache(executor: MigrationExecutor): Map<string, MigrationFn> {
  let cache = compiledCache.get(executor);
  if (!cache) {
    cache = new Map();
    compiledCache.set(executor, cache);
  }
  return cache;
}

function hashSource(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

// ---------------------------------------------------------------------------
// Lazy serialization loader. Pulls `@google-cloud/firestore` only when the
// default executor actually runs a migration — keeps Firestore out of
// non-Firestore bundles (e.g. the Cloudflare DO backend).
// ---------------------------------------------------------------------------

let _serializationModule: typeof SerializationModule | null = null;

async function loadSerialization(): Promise<typeof SerializationModule> {
  if (_serializationModule) return _serializationModule;
  _serializationModule = await import('./serialization.js');
  return _serializationModule;
}

// ---------------------------------------------------------------------------
// Default executor
// ---------------------------------------------------------------------------

/**
 * Default executor using a worker-thread SES Compartment with JSON marshaling.
 *
 * Migration source is compiled and executed inside an isolated SES
 * Compartment running in a dedicated worker thread. The worker calls
 * `lockdown()` in its own V8 isolate, leaving the host process's
 * intrinsics completely unaffected.
 *
 * Data crosses the compartment boundary as JSON strings, preventing
 * prototype chain escapes. The compartment receives only `JSON` as an
 * endowment for parsing/stringifying data.
 *
 * The returned `MigrationFn` always returns a `Promise` (communication
 * with the worker is inherently async via `postMessage`).
 */
export function defaultExecutor(source: string): MigrationFn {
  // Worker is spawned lazily on first execution via `sendToWorker`.
  // Eager spawning here would force a top-level `node:worker_threads`
  // load and break Cloudflare Workers / browser callers that never
  // exercise the default sandbox.

  // Return a MigrationFn that delegates to the worker thread.
  // Compilation + execution happen in the worker's SES Compartment.
  return (async (data: Record<string, unknown>) => {
    const { serializeFirestoreTypes, deserializeFirestoreTypes } = await loadSerialization();
    const jsonData = JSON.stringify(serializeFirestoreTypes(data));
    const response = await sendToWorker({ type: 'execute', source, jsonData });
    if (response.jsonResult === undefined || response.jsonResult === null) {
      throw new MigrationError('Migration returned a non-JSON-serializable value');
    }
    try {
      return deserializeFirestoreTypes(JSON.parse(response.jsonResult));
    } catch {
      throw new MigrationError('Migration returned a non-JSON-serializable value');
    }
  }) as MigrationFn;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Eagerly validate a migration source string by compiling it in the
 * sandbox worker (or via a custom executor) without executing it.
 *
 * Use this to catch syntax errors at define-time or reload-time rather
 * than at first migration execution.
 *
 * @throws {MigrationError} If the source is syntactically invalid or
 *   does not produce a function.
 */
export async function precompileSource(
  source: string,
  executor?: MigrationExecutor,
): Promise<void> {
  if (executor && executor !== defaultExecutor) {
    // Custom executors validate synchronously the old way
    try {
      executor(source);
    } catch (err: unknown) {
      if (err instanceof MigrationError) throw err;
      throw new MigrationError(`Failed to compile migration source: ${(err as Error).message}`);
    }
    return;
  }

  // Default executor: send a compile-only message to the worker
  await sendToWorker({ type: 'compile', source });
}

/**
 * Compile a stored migration source string into an executable function.
 * Results are cached by SHA-256 hash of the source string so repeated
 * reads never re-parse the same migration.
 *
 * **Important:** When using the default executor, this function does NOT
 * validate the source synchronously — validation is deferred to the
 * worker thread at execution time. Callers that need eager validation
 * (e.g., `defineNodeType`, `reloadRegistry`) should call
 * `precompileSource()` before or alongside `compileMigrationFn()`.
 */
export function compileMigrationFn(
  source: string,
  executor: MigrationExecutor = defaultExecutor,
): MigrationFn {
  const cache = getExecutorCache(executor);
  const key = hashSource(source);
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const fn = executor(source);
    cache.set(key, fn);
    return fn;
  } catch (err: unknown) {
    if (err instanceof MigrationError) throw err;
    throw new MigrationError(`Failed to compile migration source: ${(err as Error).message}`);
  }
}

/**
 * Batch compile stored migration steps into executable MigrationStep[].
 *
 * With the default executor, source validation is deferred to execution
 * time. Use `precompileSource()` to validate eagerly — see
 * `createRegistryFromGraph()` for the recommended pattern.
 */
export function compileMigrations(
  stored: StoredMigrationStep[],
  executor?: MigrationExecutor,
): MigrationStep[] {
  return stored.map((step) => ({
    fromVersion: step.fromVersion,
    toVersion: step.toVersion,
    up: compileMigrationFn(step.up, executor),
  }));
}

/**
 * Terminate the sandbox worker thread. The worker will be respawned
 * on the next `defaultExecutor` call.
 *
 * Primarily useful for test cleanup to avoid vitest hanging on
 * unfinished worker threads.
 */
export async function destroySandboxWorker(): Promise<void> {
  if (!_worker) return;
  const w = _worker;
  _worker = null;
  // Reject any remaining pending requests
  for (const [, p] of _pending) {
    p.reject(new MigrationError('Sandbox worker terminated'));
  }
  _pending.clear();
  await w.terminate();
}
