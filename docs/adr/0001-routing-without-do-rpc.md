# ADR 0001: Ship `createRoutingBackend` without a Durable Object RPC layer

- **Status:** Accepted
- **Date:** 2026-04-17
- **Context:** firegraph v0.9.0 (planned)

## Context

The Cloudflare port (D1 + Durable Object SQLite, shipped in v0.8.0) runs into a hard 10 GB per-DO storage cap. Applications that would exceed that ceiling under a single-DO layout need a way to split parts of a logical graph across multiple physical storage backends — conceptually the same boundary that `.subgraph()` already draws, just with a different physical footprint.

The natural seam is `StorageBackend.subgraph(parentUid, name)`. Routing some subset of those calls to a different backend — typically another DO over RPC — gives apps a way to scale horizontally without redesigning their data model.

Two reasonable scopes for what firegraph could ship:

1. **Routing primitive only.** Promote `StorageBackend` to a public type, ship `createRoutingBackend(base, { route })`, scope-path helpers, and a typed error. Leave the RPC protocol, DO class, and enumeration index to the caller.
2. **Full cross-DO stack.** On top of (1), ship a `firegraph/do-rpc` entry point with a matched client + server wire protocol, a D1-backed live-scope directory, and built-in cross-backend cascade.

## Decision

Ship scope (1) only. Specifically:

- Public `firegraph/backend` entry point with `StorageBackend`, `TransactionBackend`, `BatchBackend`, `UpdatePayload`, `WritableRecord`, `createRoutingBackend`, scope-path helpers, `CrossBackendTransactionError`.
- `createRoutingBackend` delegates everything to the base backend except `subgraph()`, which consults a synchronous `route()` callback. Routed children are themselves wrapped so grandchildren keep routing.
- Transactions and batches never span routed backends — `TransactionBackend` / `BatchBackend` don't expose `subgraph()`, so the type system rejects the mistake at compile time. The runtime error exists as a public type for dynamic code paths.
- `findEdgesGlobal` and `removeNodeCascade` on a routing backend run against the base backend only. Callers needing cross-shard behaviour maintain their own enumeration index.

Do **not** ship:

- A `firegraph/do-rpc` entry point with a DO class + client.
- A managed live-scope directory (D1 / KV / Registry DO).
- Cross-backend cascade fan-out.
- An async `route()` callback.

## Rationale

### The RPC protocol is not one-size-fits-all

Every Cloudflare app's DO binding shape differs: binding name, auth layer (service bindings vs. RPC vs. fetch), timeout policy, retry behaviour, serialization format, observability hooks. A built-in `do-rpc` would either:

- Bake one set of choices into the library and lock out everyone whose app doesn't fit (painful for users, library-expansion pressure for maintainers), or
- Accept a pluggable protocol object, at which point the primitive is already a `StorageBackend` implementation — which the user can write directly without firegraph's help.

The `StorageBackend` interface is already the pluggable primitive. Shipping another layer on top of it would be redundant.

### The enumeration index is an app choice

Cross-shard cascade and cross-shard `findEdgesGlobal` both need a live-scope directory: "which routed backends exist under this parent?" That directory is persistence. Firegraph can't pick:

- Storage (D1? KV? Registry DO? colocated SQLite?)
- Indexing (by parent UID? by subgraph name? both?)
- Expiry / tombstoning policy
- Consistency model (strongly consistent? eventually consistent?)

Every one of those is an architectural decision the app must make. Firegraph shipping a directory would drag all of those into the library's surface.

### Async `route()` has a high blast radius

`.subgraph()` is synchronous throughout the public API. Making `route()` async would require making every client-factory call site async (`client.subgraph(...)` becomes `await client.subgraph(...)`), which touches traversal, cross-graph edges, tests, and every downstream consumer. The win — "ask an external service whether this DO exists" — is better served by lazy failure: the first read against the returned backend surfaces the problem naturally.

### The common case stays local

Most graphs never cross the 10 GB ceiling for a single tenant. Shipping a full cross-DO stack as the default path would bloat the core install, slow down cold starts, and confuse new users with choices they don't need. Keeping the core local-first and making routing opt-in preserves the fast path.

## Consequences

### Positive

- `firegraph/backend` surface stays small (one function, one options type, one context type, one error class, four scope helpers). Small surface = stable surface.
- Users who don't need routing pay zero cost.
- Users who need routing can implement any DO RPC protocol that fits their app, including ones firegraph's maintainers haven't thought of yet.
- The routing primitive composes with non-DO backends: an in-memory test backend, a queue-buffered backend, a branching "shadow-write to second backend" backend, etc. Baking DO specifics in would have prevented those.

### Negative

- Every app using routing re-implements roughly the same DO RPC boilerplate. Mitigation: point to a reference implementation (expected to live in the ive platform repo). See routing.md.
- App-side bugs in the DO RPC layer are invisible to firegraph tests. Mitigation: the `StorageBackend` surface is small and has compile-time shape lock (`tests/unit/backend-surface.test.ts`); users get clear type errors if they diverge.
- Cross-backend cascade is a footgun. Mitigation: documented in routing.md as an explicit non-feature.

### Revisit criteria

Promote scope (2) to firegraph only if:

- Multiple independent apps converge on the same DO RPC protocol (suggests there's a real default worth shipping), AND
- The enumeration-index design becomes settled across those apps, AND
- Cross-backend cascade proves more valuable than the surface-area cost.

Until all three hold, keep the library surface narrow.

## References

- `.claude/rules/routing.md` — contract + usage documentation
- `src/internal/routing-backend.ts` — implementation + module-level contract
- `tests/unit/routing-backend.test.ts` — contract coverage
