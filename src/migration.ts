/**
 * Migration pipeline for auto-migrating records on read.
 *
 * When a record's `v` is behind the version derived from the registry
 * entry's migrations, the pipeline applies migration steps sequentially
 * to bring the data up to the current version.
 */

import { MigrationError } from './errors.js';
import type {
  GraphRegistry,
  MigrationStep,
  MigrationWriteBack,
  StoredGraphRecord,
} from './types.js';

/** Result of attempting to migrate a single record. */
export interface MigrationResult {
  record: StoredGraphRecord;
  migrated: boolean;
  /** Resolved write-back mode for this record (entry-level > global > 'off'). */
  writeBack: MigrationWriteBack;
}

/**
 * Apply a chain of migration steps to transform data from `currentVersion`
 * to `targetVersion`. Throws `MigrationError` if the chain is incomplete
 * or a migration function fails.
 *
 * Returns the migrated data payload only — the caller is responsible for
 * stamping `v` on the record envelope.
 */
export async function applyMigrationChain(
  data: Record<string, unknown>,
  currentVersion: number,
  targetVersion: number,
  migrations: MigrationStep[],
): Promise<Record<string, unknown>> {
  const sorted = [...migrations].sort((a, b) => a.fromVersion - b.fromVersion);
  let result = { ...data };
  let version = currentVersion;

  for (const step of sorted) {
    if (step.fromVersion === version) {
      try {
        result = await step.up(result);
      } catch (err: unknown) {
        if (err instanceof MigrationError) throw err;
        throw new MigrationError(
          `Migration from v${step.fromVersion} to v${step.toVersion} failed: ${(err as Error).message}`,
        );
      }
      if (!result || typeof result !== 'object') {
        throw new MigrationError(
          `Migration from v${step.fromVersion} to v${step.toVersion} returned invalid data (expected object)`,
        );
      }
      version = step.toVersion;
    }
  }

  if (version !== targetVersion) {
    throw new MigrationError(
      `Incomplete migration chain: reached v${version} but target is v${targetVersion}`,
    );
  }

  return result;
}

/**
 * Validate that a migration chain forms a contiguous path from version 0
 * to the highest `toVersion`. Throws `MigrationError` if the chain has
 * gaps or duplicate `fromVersion` values.
 *
 * Called at registry construction time to catch incomplete chains early,
 * rather than at read time when a record is migrated.
 */
export function validateMigrationChain(migrations: MigrationStep[], label: string): void {
  if (migrations.length === 0) return;

  // Validate individual steps
  const seen = new Set<number>();
  for (const step of migrations) {
    if (step.toVersion <= step.fromVersion) {
      throw new MigrationError(
        `${label}: migration step has toVersion (${step.toVersion}) <= fromVersion (${step.fromVersion})`,
      );
    }
    if (seen.has(step.fromVersion)) {
      throw new MigrationError(
        `${label}: duplicate migration step for fromVersion ${step.fromVersion}`,
      );
    }
    seen.add(step.fromVersion);
  }

  const sorted = [...migrations].sort((a, b) => a.fromVersion - b.fromVersion);
  const targetVersion = Math.max(...migrations.map((m) => m.toVersion));
  let version = 0;

  for (const step of sorted) {
    if (step.fromVersion === version) {
      version = step.toVersion;
    } else if (step.fromVersion > version) {
      throw new MigrationError(
        `${label}: migration chain has a gap — no step covers v${version} → v${step.fromVersion}`,
      );
    }
  }

  if (version !== targetVersion) {
    throw new MigrationError(
      `${label}: migration chain does not reach v${targetVersion} (stuck at v${version})`,
    );
  }
}

/**
 * Attempt to migrate a single record based on its registry entry.
 *
 * Returns the original record unchanged if no migration is needed
 * (no schema version, already at current version, or no migrations defined).
 */
export async function migrateRecord(
  record: StoredGraphRecord,
  registry: GraphRegistry,
  globalWriteBack: MigrationWriteBack = 'off',
): Promise<MigrationResult> {
  const entry = registry.lookup(record.aType, record.axbType, record.bType);

  if (!entry?.migrations?.length || !entry.schemaVersion) {
    return { record, migrated: false, writeBack: 'off' };
  }

  const currentVersion = record.v ?? 0;

  if (currentVersion >= entry.schemaVersion) {
    return { record, migrated: false, writeBack: 'off' };
  }

  const migratedData = await applyMigrationChain(
    record.data,
    currentVersion,
    entry.schemaVersion,
    entry.migrations,
  );

  // Two-tier resolution: entry-level > global > 'off'
  const writeBack = entry.migrationWriteBack ?? globalWriteBack ?? 'off';

  return {
    record: { ...record, data: migratedData, v: entry.schemaVersion },
    migrated: true,
    writeBack,
  };
}

/**
 * Migrate an array of records, returning all results.
 * If any single migration fails, the entire call rejects — a broken
 * migration function is a bug that should surface immediately.
 */
export async function migrateRecords(
  records: StoredGraphRecord[],
  registry: GraphRegistry,
  globalWriteBack: MigrationWriteBack = 'off',
): Promise<MigrationResult[]> {
  return Promise.all(records.map((r) => migrateRecord(r, registry, globalWriteBack)));
}
