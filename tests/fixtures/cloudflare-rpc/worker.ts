/**
 * Worker fixture for `tests/integration/cloudflare-rpc.test.ts`.
 *
 * Bundled at test time by esbuild (with `cloudflare:workers` left external),
 * then handed to Miniflare. The bundle exposes:
 *
 * - `FiregraphDO` — re-exported from the firegraph source tree (see comment
 *   above the export for why we bundle from `src/` and not `dist/`).
 *
 * - `PlainDO` — a sibling class that deliberately does NOT extend
 *   `DurableObject`. Used as the negative control: calling an RPC method on
 *   its stub should throw the canonical "does not support RPC" error,
 *   confirming that the FiregraphDO success isn't an accident of Miniflare
 *   leniently dispatching to plain classes.
 *
 * - `fetch` — present only because Miniflare requires every Worker module to
 *   have *some* default export; the test never invokes it.
 */

// Imported directly from `do.ts` rather than the `cloudflare/index.ts`
// barrel. The barrel re-exports `DORPCBackend` and `createDOClient`, which
// transitively pull in `src/client.ts` → `migration.ts` → `registry.ts` →
// type-only references to `@google-cloud/firestore` that esbuild's
// dependency walker can't always elide cleanly. Importing the leaf module
// keeps the fixture bundle minimal and keeps the test focused on the only
// thing it's checking: that the `extends DurableObject` declaration in
// `do.ts` reaches workerd's RPC dispatcher intact.
//
// We bundle from `src/` rather than `dist/` because tsup's chunk-splitting
// shares output across the Firestore entry point too, dragging in firestore
// + grpc transitively. A regression that strips `extends DurableObject`
// from the dist build would still be caught by `pnpm build` + `pnpm
// typecheck`, both of which run pre-commit.
export { FiregraphDO } from '../../../src/cloudflare/do.js';

/**
 * Plain class DO — the "before" state of `ad50298`. Has the right
 * constructor shape to load, can serve `fetch()` via the stub, but RPC method
 * dispatch on the stub throws because the class doesn't extend the magic
 * `DurableObject` base.
 */
export class PlainDO {
  state: unknown;
  env: unknown;

  constructor(state: unknown, env: unknown) {
    this.state = state;
    this.env = env;
  }

  // Same RPC method shape FiregraphDO exposes. The point of the test is that
  // calling this through the stub throws *before* we ever land here — it
  // never executes.
  async _fgGetDoc(_docId: string): Promise<null> {
    return null;
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response('fixture worker — fetch handler is unused');
  },
};
