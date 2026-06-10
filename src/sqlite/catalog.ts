/**
 * Graph catalog for the table-per-graph SQLite edition.
 *
 * Each graph (the root, and every subgraph reached via chained
 * `subgraph()` calls) lives in its own SQLite table. The catalog is a
 * small bookkeeping table — `<rootTable>_graphs` — mapping each graph's
 * storage scope (the interleaved `parentUid/name` path that uniquely
 * identifies a subgraph position) to its physical table name and its
 * logical scope path (chained subgraph names, used for `allowedIn`
 * matching).
 *
 * The catalog is what makes registry-free cascade possible: deleting a
 * node with subgraphs prefix-matches descendant storage scopes in the
 * catalog and drops each listed table, with no need to know the subgraph
 * topology from a schema registry.
 */

import { quoteIdent, validateTableName } from '../internal/sqlite-schema.js';
import type { CompiledStatement } from '../internal/sqlite-sql.js';

/** Name of the catalog table that tracks every graph under `rootTable`. */
export function catalogTableName(rootTable: string): string {
  validateTableName(rootTable);
  return `${rootTable}_graphs`;
}

/**
 * Deterministically mangle a storage scope into a SQL-identifier-safe
 * table-name suffix. The encoding is injective so two distinct scopes can
 * never collide on the same table:
 *
 *   - `[A-Za-z0-9]` pass through
 *   - `_` → `__`   (escape char, doubled)
 *   - `-` → `_h`   (nanoid alphabet includes `-`)
 *   - `/` → `_s`   (scope segment separator)
 *   - anything else → `_u<hex codepoint>_`
 *
 * Every escape sequence starts with `_` and no passthrough character is
 * `_`, so decoding is unambiguous (not that we ever decode — the catalog
 * stores the original scope alongside the table name).
 */
export function mangleStorageScope(scope: string): string {
  let out = '';
  for (const ch of scope) {
    if (/[A-Za-z0-9]/.test(ch)) out += ch;
    else if (ch === '_') out += '__';
    else if (ch === '-') out += '_h';
    else if (ch === '/') out += '_s';
    else out += `_u${ch.codePointAt(0)!.toString(16)}_`;
  }
  return out;
}

/**
 * Resolve the physical table for a graph position. The root graph
 * (`storageScope === ''`) uses `rootTable` itself; subgraphs get
 * `<rootTable>_g_<mangled scope>`.
 *
 * The `_g_` infix keeps subgraph tables disjoint from both the root table
 * and the catalog (`<rootTable>_graphs` — `_graphs` is never `_g_<x>`).
 */
export function tableForScope(rootTable: string, storageScope: string): string {
  validateTableName(rootTable);
  if (storageScope === '') return rootTable;
  return `${rootTable}_g_${mangleStorageScope(storageScope)}`;
}

/**
 * Escape LIKE wildcards in a literal prefix. The nanoid alphabet includes
 * `_` (a single-char LIKE wildcard), so prefix matches against storage
 * scopes MUST escape and carry an `ESCAPE '\'` clause — otherwise a scope
 * containing `_` would match unrelated siblings.
 */
export function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** DDL for the catalog table. Idempotent. */
export function buildCatalogDDL(rootTable: string): string {
  const t = quoteIdent(catalogTableName(rootTable));
  return `CREATE TABLE IF NOT EXISTS ${t} (
      storage_scope TEXT NOT NULL PRIMARY KEY,
      table_name    TEXT NOT NULL UNIQUE,
      scope_path    TEXT NOT NULL
    )`;
}

/** Register a graph in the catalog. Idempotent (`INSERT OR IGNORE`). */
export function compileCatalogRegister(
  rootTable: string,
  storageScope: string,
  tableName: string,
  scopePath: string,
): CompiledStatement {
  const t = quoteIdent(catalogTableName(rootTable));
  return {
    sql: `INSERT OR IGNORE INTO ${t} (storage_scope, table_name, scope_path) VALUES (?, ?, ?)`,
    params: [storageScope, tableName, scopePath],
  };
}

/**
 * List every descendant graph whose storage scope starts with
 * `scopePrefix + '/'`. Used by cascade delete to discover which tables to
 * drop. Ordered by scope for deterministic statement order.
 */
export function compileCatalogDescendants(
  rootTable: string,
  scopePrefix: string,
): CompiledStatement {
  const t = quoteIdent(catalogTableName(rootTable));
  return {
    sql:
      `SELECT storage_scope, table_name FROM ${t} ` +
      `WHERE storage_scope LIKE ? ESCAPE '\\' ORDER BY storage_scope`,
    params: [`${escapeLikePrefix(scopePrefix)}/%`],
  };
}

/** Remove one graph's catalog row (paired with its DROP TABLE). */
export function compileCatalogDelete(rootTable: string, storageScope: string): CompiledStatement {
  const t = quoteIdent(catalogTableName(rootTable));
  return {
    sql: `DELETE FROM ${t} WHERE storage_scope = ?`,
    params: [storageScope],
  };
}
