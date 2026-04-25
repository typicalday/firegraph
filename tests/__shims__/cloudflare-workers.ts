/**
 * Vitest shim for `cloudflare:workers`.
 *
 * The real `cloudflare:workers` module is a virtual builtin — only the
 * `workerd` runtime resolves it. Node has no idea what it is, so any test
 * that imports `FiregraphDO` (which extends `DurableObject` from
 * `cloudflare:workers` for production RPC compatibility) would crash at
 * load time.
 *
 * `vitest.config.ts` aliases `cloudflare:workers` to this file. We expose a
 * minimal `DurableObject` base that just captures `ctx` and `env` — exactly
 * what the real class does on the only field-init path that matters for
 * subclasses. Methods (`fetch`, `alarm`, `webSocketMessage`, …) are not
 * shimmed because Node tests never invoke them through the runtime; if a
 * subclass overrides them, the override stands.
 *
 * If a future test needs richer behavior (e.g. asserting that subclasses
 * call `super.fetch(...)`), extend this shim — the test-only blast radius
 * is contained.
 */

export class DurableObject<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/**
 * `WorkerEntrypoint` is exported by `cloudflare:workers` too. We don't use
 * it in firegraph today, but exposing a similar stub here means any future
 * code (or downstream consumer's tests) that imports it through the alias
 * doesn't break loading.
 */
export class WorkerEntrypoint<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
