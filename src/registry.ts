import { RegistryViolationError, ValidationError } from './errors.js';
import { compileSchema } from './json-schema.js';
import { NODE_RELATION } from './internal/constants.js';
import type { GraphRegistry, RegistryEntry, DiscoveryResult } from './types.js';

function tripleKey(aType: string, abType: string, bType: string): string {
  return `${aType}:${abType}:${bType}`;
}

/**
 * Build a registry from either explicit entries or a DiscoveryResult.
 *
 * @example
 * ```ts
 * // From explicit entries (programmatic)
 * const registry = createRegistry([
 *   { aType: 'user', abType: 'is', bType: 'user', jsonSchema: userSchema },
 *   { aType: 'user', abType: 'follows', bType: 'user', jsonSchema: followsSchema },
 * ]);
 *
 * // From discovery result (folder convention)
 * const discovered = await discoverEntities('./entities');
 * const registry = createRegistry(discovered);
 * ```
 */
export function createRegistry(
  input: RegistryEntry[] | DiscoveryResult,
): GraphRegistry {
  const map = new Map<string, { entry: RegistryEntry; validate?: (data: unknown) => void }>();

  let entries: RegistryEntry[];

  if (Array.isArray(input)) {
    entries = input;
  } else {
    entries = discoveryToEntries(input);
  }

  const entryList: ReadonlyArray<RegistryEntry> = Object.freeze([...entries]);

  for (const entry of entries) {
    const key = tripleKey(entry.aType, entry.abType, entry.bType);
    const validator = entry.jsonSchema
      ? compileSchema(entry.jsonSchema, `(${entry.aType}) -[${entry.abType}]-> (${entry.bType})`)
      : undefined;
    map.set(key, { entry, validate: validator });
  }

  return {
    lookup(aType: string, abType: string, bType: string): RegistryEntry | undefined {
      return map.get(tripleKey(aType, abType, bType))?.entry;
    },

    validate(aType: string, abType: string, bType: string, data: unknown): void {
      const rec = map.get(tripleKey(aType, abType, bType));

      if (!rec) {
        throw new RegistryViolationError(aType, abType, bType);
      }

      if (rec.validate) {
        try {
          rec.validate(data);
        } catch (err: unknown) {
          if (err instanceof ValidationError) throw err;
          throw new ValidationError(
            `Data validation failed for (${aType}) -[${abType}]-> (${bType})`,
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
      abType: NODE_RELATION,
      bType: name,
      jsonSchema: entity.schema,
      description: entity.description,
    });
  }

  // Edges → expand from/to into one triple per combination
  for (const [abType, entity] of discovery.edges) {
    const topology = entity.topology;
    if (!topology) continue;

    const fromTypes = Array.isArray(topology.from) ? topology.from : [topology.from];
    const toTypes = Array.isArray(topology.to) ? topology.to : [topology.to];

    for (const aType of fromTypes) {
      for (const bType of toTypes) {
        entries.push({
          aType,
          abType,
          bType,
          jsonSchema: entity.schema,
          description: entity.description,
          inverseLabel: topology.inverseLabel,
        });
      }
    }
  }

  return entries;
}
