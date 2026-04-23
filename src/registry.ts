import { RegistryScopeError, RegistryViolationError, ValidationError } from './errors.js';
import { NODE_RELATION } from './internal/constants.js';
import { compileSchema } from './json-schema.js';
import { validateMigrationChain } from './migration.js';
import { matchScopeAny } from './scope.js';
import type { DiscoveryResult, GraphRegistry, RegistryEntry } from './types.js';

function tripleKey(aType: string, axbType: string, bType: string): string {
  return `${aType}:${axbType}:${bType}`;
}

function tripleKeyFor(e: RegistryEntry): string {
  return tripleKey(e.aType, e.axbType, e.bType);
}

/**
 * Build a registry from either explicit entries or a DiscoveryResult.
 *
 * @example
 * ```ts
 * // From explicit entries (programmatic)
 * const registry = createRegistry([
 *   { aType: 'user', axbType: 'is', bType: 'user', jsonSchema: userSchema },
 *   { aType: 'user', axbType: 'follows', bType: 'user', jsonSchema: followsSchema },
 * ]);
 *
 * // From discovery result (folder convention)
 * const discovered = await discoverEntities('./entities');
 * const registry = createRegistry(discovered);
 * ```
 */
export function createRegistry(input: RegistryEntry[] | DiscoveryResult): GraphRegistry {
  const map = new Map<string, { entry: RegistryEntry; validate?: (data: unknown) => void }>();

  let entries: RegistryEntry[];

  if (Array.isArray(input)) {
    entries = input;
  } else {
    entries = discoveryToEntries(input);
  }

  const entryList: ReadonlyArray<RegistryEntry> = Object.freeze([...entries]);

  for (const entry of entries) {
    if (entry.targetGraph && entry.targetGraph.includes('/')) {
      throw new ValidationError(
        `Entry (${entry.aType}) -[${entry.axbType}]-> (${entry.bType}) has invalid targetGraph "${entry.targetGraph}" — must be a single segment (no "/")`,
      );
    }
    if (entry.migrations?.length) {
      const label = `Entry (${entry.aType}) -[${entry.axbType}]-> (${entry.bType})`;
      validateMigrationChain(entry.migrations, label);
      // Derive schemaVersion from migrations — single source of truth
      entry.schemaVersion = Math.max(...entry.migrations.map((m) => m.toVersion));
    } else {
      // No migrations → no versioning (ignore any user-supplied schemaVersion)
      entry.schemaVersion = undefined;
    }
    const key = tripleKey(entry.aType, entry.axbType, entry.bType);
    const validator = entry.jsonSchema
      ? compileSchema(entry.jsonSchema, `(${entry.aType}) -[${entry.axbType}]-> (${entry.bType})`)
      : undefined;
    map.set(key, { entry, validate: validator });
  }

  // Build axbType index for lookupByAxbType
  const axbIndex = new Map<string, ReadonlyArray<RegistryEntry>>();
  const axbBuild = new Map<string, RegistryEntry[]>();
  for (const entry of entries) {
    const existing = axbBuild.get(entry.axbType);
    if (existing) {
      existing.push(entry);
    } else {
      axbBuild.set(entry.axbType, [entry]);
    }
  }
  for (const [key, arr] of axbBuild) {
    axbIndex.set(key, Object.freeze(arr));
  }

  // Build aType → subgraph-topology index.
  //
  // For each source aType, collect edge entries whose `targetGraph` is set —
  // these are the aType's direct subgraph children. Dedupe by `targetGraph`
  // alone (not by axbType): the physical subgraph store is addressed by
  // (parentUid, targetGraph) and the cascade caller only cares about which
  // child subgraphs to tear down. Two distinct edge relations pointing into
  // the same `targetGraph` would otherwise produce duplicate destroy calls
  // on the same physical backend.
  const topologyIndex = new Map<string, ReadonlyArray<RegistryEntry>>();
  const topologyBuild = new Map<string, RegistryEntry[]>();
  const topologySeen = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (!entry.targetGraph) continue;
    let seen = topologySeen.get(entry.aType);
    if (!seen) {
      seen = new Set();
      topologySeen.set(entry.aType, seen);
    }
    if (seen.has(entry.targetGraph)) continue;
    seen.add(entry.targetGraph);
    const existing = topologyBuild.get(entry.aType);
    if (existing) {
      existing.push(entry);
    } else {
      topologyBuild.set(entry.aType, [entry]);
    }
  }
  for (const [key, arr] of topologyBuild) {
    topologyIndex.set(key, Object.freeze(arr));
  }

  return {
    lookup(aType: string, axbType: string, bType: string): RegistryEntry | undefined {
      return map.get(tripleKey(aType, axbType, bType))?.entry;
    },

    lookupByAxbType(axbType: string): ReadonlyArray<RegistryEntry> {
      return axbIndex.get(axbType) ?? [];
    },

    getSubgraphTopology(aType: string): ReadonlyArray<RegistryEntry> {
      return topologyIndex.get(aType) ?? [];
    },

    validate(
      aType: string,
      axbType: string,
      bType: string,
      data: unknown,
      scopePath?: string,
    ): void {
      const rec = map.get(tripleKey(aType, axbType, bType));

      if (!rec) {
        throw new RegistryViolationError(aType, axbType, bType);
      }

      // Scope validation: check allowedIn patterns when a scope context is provided
      if (scopePath !== undefined && rec.entry.allowedIn && rec.entry.allowedIn.length > 0) {
        if (!matchScopeAny(scopePath, rec.entry.allowedIn)) {
          throw new RegistryScopeError(aType, axbType, bType, scopePath, rec.entry.allowedIn);
        }
      }

      if (rec.validate) {
        try {
          rec.validate(data);
        } catch (err: unknown) {
          if (err instanceof ValidationError) throw err;
          throw new ValidationError(
            `Data validation failed for (${aType}) -[${axbType}]-> (${bType})`,
            err,
          );
        }
      }
    },

    entries(): ReadonlyArray<RegistryEntry> {
      return entryList;
    },
  };
}

/**
 * Create a merged registry where `base` entries take priority and `extension`
 * entries fill in gaps. Lookups and validation check `base` first; only if the
 * triple is not found there does the merged registry fall through to
 * `extension`.
 *
 * The `entries()` method returns a deduplicated list (base wins on collision).
 * The `lookupByAxbType()` method merges results from both registries,
 * deduplicating by triple key with base entries winning.
 */
export function createMergedRegistry(base: GraphRegistry, extension: GraphRegistry): GraphRegistry {
  // Build a set of triple keys from the base registry for fast collision checks.
  const baseKeys = new Set(base.entries().map(tripleKeyFor));

  return {
    lookup(aType: string, axbType: string, bType: string): RegistryEntry | undefined {
      return base.lookup(aType, axbType, bType) ?? extension.lookup(aType, axbType, bType);
    },

    lookupByAxbType(axbType: string): ReadonlyArray<RegistryEntry> {
      const baseResults = base.lookupByAxbType(axbType);
      const extResults = extension.lookupByAxbType(axbType);
      if (extResults.length === 0) return baseResults;
      if (baseResults.length === 0) return extResults;

      // Merge, base wins on triple-key collision
      const seen = new Set(baseResults.map(tripleKeyFor));
      const merged = [...baseResults];
      for (const entry of extResults) {
        if (!seen.has(tripleKeyFor(entry))) {
          merged.push(entry);
        }
      }
      return Object.freeze(merged);
    },

    getSubgraphTopology(aType: string): ReadonlyArray<RegistryEntry> {
      const baseResults = base.getSubgraphTopology(aType);
      const extResults = extension.getSubgraphTopology(aType);
      if (extResults.length === 0) return baseResults;
      if (baseResults.length === 0) return extResults;

      // Merge, base wins on `targetGraph` collision. Extension entries only
      // contribute new subgraph segments the base doesn't cover. Dedupe key
      // matches the physical DO address — (parentUid, targetGraph) — so two
      // different axbTypes pointing into the same segment collapse to one.
      const seen = new Set(baseResults.map((e) => e.targetGraph));
      const merged = [...baseResults];
      for (const entry of extResults) {
        if (!seen.has(entry.targetGraph)) {
          seen.add(entry.targetGraph);
          merged.push(entry);
        }
      }
      return Object.freeze(merged);
    },

    validate(
      aType: string,
      axbType: string,
      bType: string,
      data: unknown,
      scopePath?: string,
    ): void {
      if (baseKeys.has(tripleKey(aType, axbType, bType))) {
        return base.validate(aType, axbType, bType, data, scopePath);
      }
      // Falls through to extension (which throws RegistryViolationError if not found)
      return extension.validate(aType, axbType, bType, data, scopePath);
    },

    entries(): ReadonlyArray<RegistryEntry> {
      const extEntries = extension.entries();
      if (extEntries.length === 0) return base.entries();

      const merged = [...base.entries()];
      for (const entry of extEntries) {
        if (!baseKeys.has(tripleKeyFor(entry))) {
          merged.push(entry);
        }
      }
      return Object.freeze(merged);
    },
  };
}

/**
 * Convert a DiscoveryResult into flat RegistryEntry[].
 * Nodes become self-loop triples `(name, 'is', name)`.
 * Edges expand `from`/`to` arrays into one triple per combination.
 */
function discoveryToEntries(discovery: DiscoveryResult): RegistryEntry[] {
  const entries: RegistryEntry[] = [];

  // Nodes → self-loop triples
  for (const [name, entity] of discovery.nodes) {
    entries.push({
      aType: name,
      axbType: NODE_RELATION,
      bType: name,
      jsonSchema: entity.schema,
      description: entity.description,
      titleField: entity.titleField,
      subtitleField: entity.subtitleField,
      allowedIn: entity.allowedIn,
      migrations: entity.migrations,
      migrationWriteBack: entity.migrationWriteBack,
      indexes: entity.indexes,
    });
  }

  // Edges → expand from/to into one triple per combination
  for (const [axbType, entity] of discovery.edges) {
    const topology = entity.topology;
    if (!topology) continue;

    const fromTypes = Array.isArray(topology.from) ? topology.from : [topology.from];
    const toTypes = Array.isArray(topology.to) ? topology.to : [topology.to];

    const resolvedTargetGraph = entity.targetGraph ?? topology.targetGraph;
    if (resolvedTargetGraph && resolvedTargetGraph.includes('/')) {
      throw new ValidationError(
        `Edge "${axbType}" has invalid targetGraph "${resolvedTargetGraph}" — must be a single segment (no "/")`,
      );
    }

    for (const aType of fromTypes) {
      for (const bType of toTypes) {
        entries.push({
          aType,
          axbType,
          bType,
          jsonSchema: entity.schema,
          description: entity.description,
          inverseLabel: topology.inverseLabel,
          titleField: entity.titleField,
          subtitleField: entity.subtitleField,
          allowedIn: entity.allowedIn,
          targetGraph: resolvedTargetGraph,
          migrations: entity.migrations,
          migrationWriteBack: entity.migrationWriteBack,
          indexes: entity.indexes,
        });
      }
    }
  }

  return entries;
}
