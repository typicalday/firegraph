/**
 * Firestore composite index generator.
 *
 * Translates firegraph's declarative `IndexSpec[]` (core preset plus per-entry
 * registry indexes) into the `firestore.indexes.json` shape consumed by
 * `firebase deploy --only firestore:indexes`.
 *
 * ## What Firestore needs
 *
 * Firestore auto-indexes every top-level field (including `data.*`) for
 * single-field equality queries — we only need to emit *composite* indexes
 * here. That means:
 *
 *   1. Single-field specs are dropped (Firestore already covers them).
 *   2. Composite specs (two or more fields) get one `FirestoreIndex`.
 *   3. Specs with `where` are dropped with a warning — Firestore composite
 *      indexes do not support partial predicates.
 *   4. When a registry entry has `targetGraph` set, every composite is also
 *      emitted with `queryScope: 'COLLECTION_GROUP'` under the targetGraph
 *      name, so `findEdgesGlobal()` queries across subgraphs can hit an
 *      index.
 *
 * The SQLite-flavored backends (DO, legacy) consume the same `IndexSpec[]`
 * via `src/internal/sqlite-index-ddl.ts` but emit every spec (single fields
 * included) as `CREATE INDEX` DDL.
 */

import { DEFAULT_CORE_INDEXES } from './default-indexes.js';
import type { DiscoveryResult, IndexFieldSpec, IndexSpec, RegistryEntry } from './types.js';

export interface FirestoreIndexField {
  fieldPath: string;
  order: 'ASCENDING' | 'DESCENDING';
}

export interface FirestoreIndex {
  collectionGroup: string;
  queryScope: 'COLLECTION' | 'COLLECTION_GROUP';
  fields: FirestoreIndexField[];
}

export interface FirestoreIndexConfig {
  indexes: FirestoreIndex[];
  fieldOverrides: unknown[];
}

export interface GenerateIndexOptions {
  /**
   * Replaces firegraph's built-in core preset. Defaults to
   * `DEFAULT_CORE_INDEXES`. Pass `[]` to disable core indexes entirely.
   */
  coreIndexes?: IndexSpec[];
  /**
   * Registry entries supplying per-triple `indexes`. Entries without
   * `indexes` contribute no composites; entries with `targetGraph` also
   * trigger `COLLECTION_GROUP` mirrors under each distinct targetGraph
   * segment name.
   */
  registryEntries?: ReadonlyArray<RegistryEntry>;
  /**
   * Entity discovery result. Convenience for callers that have a
   * `DiscoveryResult` but not a built registry — treated as if every
   * discovered entity were expanded to its registry entries carrying just
   * `indexes` + `targetGraph`. Mutually usable with `registryEntries`
   * (both are concatenated and deduplicated at the spec level).
   */
  entities?: DiscoveryResult;
}

function normalizeField(f: string | IndexFieldSpec): IndexFieldSpec {
  return typeof f === 'string' ? { path: f, desc: false } : { path: f.path, desc: !!f.desc };
}

function specFingerprint(spec: IndexSpec, scope: string): string {
  const normalized = spec.fields.map(normalizeField);
  return `${scope}::${JSON.stringify(normalized)}`;
}

function toFirestoreFields(spec: IndexSpec): FirestoreIndexField[] {
  return spec.fields.map((f) => {
    const n = normalizeField(f);
    return {
      fieldPath: n.path,
      order: n.desc ? 'DESCENDING' : 'ASCENDING',
    };
  });
}

let warnedOnPartialIndex = false;

/**
 * Build a Firestore index configuration from firegraph's declarative index
 * specs. Deduplicates by field list + scope before emitting. Single-field
 * specs are dropped; partial-index specs (`where` set) are dropped with a
 * one-time warning.
 */
export function generateIndexConfig(
  collection: string,
  options: GenerateIndexOptions = {},
): FirestoreIndexConfig {
  const core = options.coreIndexes ?? [...DEFAULT_CORE_INDEXES];
  const fromEntries = (options.registryEntries ?? []).flatMap((e) => {
    if (!e.indexes) return [] as IndexSpec[];
    return e.indexes;
  });

  // DiscoveryResult is a pre-registry shape — it doesn't carry `indexes`
  // per triple (those live on registry entries once built). Accept it to
  // keep the CLI ergonomic, but the only thing we can pull from it right
  // now is the set of distinct `targetGraph` values, which belongs to
  // discovery-time topology metadata. Consumers who need per-entity data
  // indexes must go through the registry path.
  const targetGraphNames = new Set<string>();
  for (const entry of options.registryEntries ?? []) {
    if (entry.targetGraph) targetGraphNames.add(entry.targetGraph);
  }
  if (options.entities) {
    for (const [, entity] of options.entities.edges) {
      const tg = entity.targetGraph ?? entity.topology?.targetGraph;
      if (tg) targetGraphNames.add(tg);
    }
  }

  const allSpecs = [...core, ...fromEntries];
  const seen = new Set<string>();
  const indexes: FirestoreIndex[] = [];

  for (const spec of allSpecs) {
    if (!spec.fields || spec.fields.length < 2) {
      // Single-field: Firestore auto-indexes — nothing to emit.
      continue;
    }
    if (spec.where) {
      if (!warnedOnPartialIndex) {
        warnedOnPartialIndex = true;
        console.warn(
          'firegraph: IndexSpec.where is ignored by the Firestore generator — ' +
            'Firestore composite indexes do not support predicates. ' +
            'The SQLite backends will still honor `where`.',
        );
      }
      continue;
    }

    const fields = toFirestoreFields(spec);

    const colKey = specFingerprint(spec, `col:${collection}`);
    if (!seen.has(colKey)) {
      seen.add(colKey);
      indexes.push({
        collectionGroup: collection,
        queryScope: 'COLLECTION',
        fields,
      });
    }

    // Mirror into every distinct `targetGraph` as a collection group index.
    // `findEdgesGlobal()` runs across all subcollections matching the
    // targetGraph name, and each pattern needs its own CG index.
    for (const tg of targetGraphNames) {
      const cgKey = specFingerprint(spec, `cg:${tg}`);
      if (seen.has(cgKey)) continue;
      seen.add(cgKey);
      indexes.push({
        collectionGroup: tg,
        queryScope: 'COLLECTION_GROUP',
        fields,
      });
    }
  }

  return { indexes, fieldOverrides: [] };
}

/**
 * Internal test hook — reset the one-time partial-index warning flag so
 * tests covering the warn branch can run sequentially without sharing
 * state.
 */
export function _resetIndexGenWarningsForTest(): void {
  warnedOnPartialIndex = false;
}
