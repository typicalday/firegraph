/**
 * Cloudflare Workers compatibility check for the d1 and do-sqlite entry
 * points. These bundles must not statically import Node-only modules
 * (`node:worker_threads`) or the Firestore SDK — both are unavailable in
 * the Workers runtime. A regression here turns a deploy into a 502.
 *
 * Two complementary checks:
 *
 * 1. **ESM (`*.js`)** — Walk the static-import graph from the entry and
 *    fail on any reachable file that contains `import … from "<forbidden>"`.
 *    Static imports are what a Workers static analyzer cares about.
 *
 * 2. **CJS (`*.cjs`)** — tsup compiles the same source to a single CJS
 *    bundle but transforms our lazy `await import()` calls into
 *    `__esm({…})`-wrapped `require()` calls. Those are still lazy, so
 *    `require("@google-cloud/firestore")` is allowed inside an `__esm`
 *    block — but a top-level eager require would crash a Worker the
 *    moment the module is loaded. The CJS check finds every forbidden
 *    `require()` and asserts each occurrence is inside an `__esm({…})`
 *    region.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');

/**
 * Modules that must never appear in the d1/do-sqlite Worker bundles. Includes:
 *
 *   - `@google-cloud/firestore` — Node-only Firestore SDK, would crash a Worker.
 *   - `node:worker_threads`/`worker_threads` — Node-only; sandbox worker is
 *     lazy-loaded behind dynamic import so it must not be in the static graph.
 *   - `node:fs`/`fs` — Node-only filesystem APIs (used only by `discover.ts`,
 *     which the d1/do-sqlite entries should never transitively pull in).
 *   - `ses` — only used by the sandbox worker thread; should never be reachable
 *     statically from the Worker bundle.
 *
 * Each addition pays for itself by catching the regression at build time
 * instead of at first cold-start in production.
 */
const FORBIDDEN = [
  '@google-cloud/firestore',
  'node:worker_threads',
  'worker_threads',
  'node:fs',
  'fs',
  'ses',
];

const STATIC_IMPORT_RE = /(?:^|\n)\s*import\b[^;]*?from\s*["']([^"']+)["']/g;

function walkStaticImports(entry: string): Map<string, string> {
  const visited = new Map<string, string>();
  const stack: string[] = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    visited.set(file, src);
    for (const m of src.matchAll(STATIC_IMPORT_RE)) {
      const spec = m[1];
      if (spec.startsWith('./') || spec.startsWith('../')) {
        stack.push(resolve(dirname(file), spec));
      }
    }
  }
  return visited;
}

describe.each(['d1.js', 'do-sqlite.js'])(
  'bundle %s — Cloudflare Workers static-import allowlist',
  (entryName) => {
    const entry = resolve(DIST, entryName);

    it(`exists (run \`pnpm build\` first)`, () => {
      expect(existsSync(entry)).toBe(true);
    });

    it.each(FORBIDDEN)('does not statically import %s anywhere in its closure', (forbidden) => {
      const closure = walkStaticImports(entry);
      const offenders: string[] = [];
      for (const [file, src] of closure) {
        for (const m of src.matchAll(STATIC_IMPORT_RE)) {
          if (m[1] === forbidden) {
            offenders.push(file);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  },
);

type Range = { start: number; end: number };

/**
 * Single-pass scan over the bundle that returns:
 *   - `lazyRanges`: byte ranges of every `__esm({...})` block (deferred init)
 *   - `stringRanges`: byte ranges of every string literal (`"…"`, `'…'`, `` `…` ``)
 *
 * A forbidden `require()` is safe if it lives inside ANY of those ranges:
 * inside `__esm` it's lazy; inside a string it's just text (e.g. the source
 * code that the SES sandbox stringifies into a worker thread).
 *
 * The scan walks the file once, tracking brace depth + comment state, so
 * brace-balanced regions and string boundaries are computed correctly even
 * when nested. The level of escape complexity tsup actually emits stays
 * comfortably inside this subset.
 */
function scanRanges(src: string): { lazy: Range[]; strings: Range[] } {
  const lazy: Range[] = [];
  const strings: Range[] = [];
  // Stack of currently-open `__esm({…})` blocks — `start` is the position
  // of the `__esm` keyword, `depth` is the brace depth at which the block
  // closes (the depth just before `({` was consumed).
  const esmStack: Array<{ start: number; closeDepth: number }> = [];
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let stringStart = -1;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && src[i + 1] === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === inString) {
        strings.push({ start: stringStart, end: i });
        inString = null;
        stringStart = -1;
      }
      continue;
    }
    // Not in any string/comment.
    if (ch === '/' && src[i + 1] === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch as '"' | "'" | '`';
      stringStart = i;
      continue;
    }
    if (ch === '_' && src.slice(i, i + 7) === '__esm({') {
      // About to consume `({`. After consuming `(` depth is unchanged; after
      // consuming `{` depth increments to D+1. The matching close-brace is
      // when depth drops back to D — record `closeDepth` as the current depth.
      esmStack.push({ start: i, closeDepth: depth });
      depth += 1; // for the `{` we're about to step over
      i += 6; // skip past `__esm({`  (we consumed `_`)
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      // Did we just close an `__esm` block?
      for (let k = esmStack.length - 1; k >= 0; k--) {
        if (esmStack[k].closeDepth === depth) {
          lazy.push({ start: esmStack[k].start, end: i });
          esmStack.splice(k, 1);
          break;
        }
      }
    }
  }
  return { lazy, strings };
}

function isInsideAnyRange(pos: number, ranges: Range[]): boolean {
  for (const { start, end } of ranges) {
    if (pos >= start && pos <= end) return true;
  }
  return false;
}

describe.each(['d1.cjs', 'do-sqlite.cjs'])(
  'bundle %s — Cloudflare Workers no-eager-require allowlist (CJS)',
  (entryName) => {
    const entry = resolve(DIST, entryName);

    it(`exists (run \`pnpm build\` first)`, () => {
      expect(existsSync(entry)).toBe(true);
    });

    it.each(FORBIDDEN)('does not eagerly require %s at module init', (forbidden) => {
      const src = readFileSync(entry, 'utf8');
      const { lazy, strings } = scanRanges(src);
      // Match `require("X")` and `require('X')` — the `X` is escaped for
      // regex use because `@google-cloud/firestore` contains no metas, but
      // future entries here might.
      const escapedSpec = forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`require\\(\\s*["']${escapedSpec}["']\\s*\\)`, 'g');
      const offenders: number[] = [];
      let match: RegExpExecArray | null;
      while ((match = re.exec(src)) !== null) {
        // Skip occurrences inside string literals (e.g. SES sandbox source
        // that gets eval'd inside a worker thread — not real `require()`s).
        if (isInsideAnyRange(match.index, strings)) continue;
        // Inside an `__esm({…})` lazy wrapper — deferred until the wrapped
        // function is invoked, so safe.
        if (isInsideAnyRange(match.index, lazy)) continue;
        offenders.push(match.index);
      }
      expect(offenders).toEqual([]);
    });
  },
);
