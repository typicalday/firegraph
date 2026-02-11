import { RegistryViolationError, ValidationError } from './errors.js';
import type { GraphRegistry, RegistryEntry } from './types.js';

function tripleKey(aType: string, abType: string, bType: string): string {
  return `${aType}:${abType}:${bType}`;
}

export function createRegistry(entries: RegistryEntry[]): GraphRegistry {
  const map = new Map<string, RegistryEntry>();

  for (const entry of entries) {
    map.set(tripleKey(entry.aType, entry.abType, entry.bType), entry);
  }

  return {
    lookup(aType: string, abType: string, bType: string): RegistryEntry | undefined {
      return map.get(tripleKey(aType, abType, bType));
    },

    validate(aType: string, abType: string, bType: string, data: unknown): void {
      const entry = map.get(tripleKey(aType, abType, bType));

      if (!entry) {
        throw new RegistryViolationError(aType, abType, bType);
      }

      if (entry.dataSchema) {
        try {
          entry.dataSchema.parse(data);
        } catch (err: unknown) {
          throw new ValidationError(
            `Data validation failed for (${aType}) -[${abType}]-> (${bType})`,
            err,
          );
        }
      }
    },
  };
}
