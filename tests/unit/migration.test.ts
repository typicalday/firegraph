import { describe, it, expect } from 'vitest';
import { Timestamp } from '@google-cloud/firestore';
import { applyMigrationChain, validateMigrationChain, migrateRecord, migrateRecords } from '../../src/migration.js';
import { createRegistry } from '../../src/registry.js';
import { MigrationError } from '../../src/errors.js';
import type { StoredGraphRecord, MigrationStep } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(
  aType: string,
  data: Record<string, unknown>,
  axbType = 'is',
  bType?: string,
  v?: number,
): StoredGraphRecord {
  return {
    aType,
    aUid: 'uid1',
    axbType,
    bType: bType ?? aType,
    bUid: axbType === 'is' ? 'uid1' : 'uid2',
    data,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    v,
  };
}

// ---------------------------------------------------------------------------
// applyMigrationChain
// ---------------------------------------------------------------------------

describe('applyMigrationChain', () => {
  it('applies a single migration step', async () => {
    const migrations: MigrationStep[] = [
      { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, status: 'draft' }) },
    ];

    const result = await applyMigrationChain({ title: 'hello' }, 0, 1, migrations);
    expect(result).toEqual({ title: 'hello', status: 'draft' });
  });

  it('applies a multi-step chain (v0 -> v1 -> v2 -> v3)', async () => {
    const migrations: MigrationStep[] = [
      { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, status: 'draft' }) },
      { fromVersion: 1, toVersion: 2, up: (d) => ({ ...d, tags: [] }) },
      { fromVersion: 2, toVersion: 3, up: (d) => ({ ...d, priority: 'medium' }) },
    ];

    const result = await applyMigrationChain({ title: 'test' }, 0, 3, migrations);
    expect(result).toEqual({
      title: 'test',
      status: 'draft',
      tags: [],
      priority: 'medium',
    });
  });

  it('applies migrations out of definition order', async () => {
    const migrations: MigrationStep[] = [
      { fromVersion: 2, toVersion: 3, up: (d) => ({ ...d, c: true }) },
      { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, a: true }) },
      { fromVersion: 1, toVersion: 2, up: (d) => ({ ...d, b: true }) },
    ];

    const result = await applyMigrationChain({}, 0, 3, migrations);
    expect(result).toEqual({ a: true, b: true, c: true });
  });

  it('supports async migration functions', async () => {
    const migrations: MigrationStep[] = [
      {
        fromVersion: 0,
        toVersion: 1,
        up: async (d) => {
          await new Promise((r) => setTimeout(r, 1));
          return { ...d, migrated: true };
        },
      },
    ];

    const result = await applyMigrationChain({}, 0, 1, migrations);
    expect(result).toEqual({ migrated: true });
  });

  it('throws MigrationError for incomplete chain', async () => {
    const migrations: MigrationStep[] = [
      { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, a: true }) },
      // gap: missing v1 -> v2
      { fromVersion: 2, toVersion: 3, up: (d) => ({ ...d, c: true }) },
    ];

    await expect(
      applyMigrationChain({}, 0, 3, migrations),
    ).rejects.toThrow(MigrationError);
  });

  it('throws MigrationError when migration function throws', async () => {
    const migrations: MigrationStep[] = [
      {
        fromVersion: 0,
        toVersion: 1,
        up: () => {
          throw new Error('boom');
        },
      },
    ];

    await expect(
      applyMigrationChain({}, 0, 1, migrations),
    ).rejects.toThrow(MigrationError);
  });

  it('throws MigrationError when migration returns null', async () => {
    const migrations: MigrationStep[] = [
      { fromVersion: 0, toVersion: 1, up: () => null as unknown as Record<string, unknown> },
    ];

    await expect(
      applyMigrationChain({}, 0, 1, migrations),
    ).rejects.toThrow(MigrationError);
  });

  it('does not mutate original data', async () => {
    const original = { title: 'hello' };
    const migrations: MigrationStep[] = [
      { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, status: 'draft' }) },
    ];

    await applyMigrationChain(original, 0, 1, migrations);
    expect(original).toEqual({ title: 'hello' });
  });
});

// ---------------------------------------------------------------------------
// validateMigrationChain
// ---------------------------------------------------------------------------

describe('validateMigrationChain', () => {
  it('accepts a valid complete chain (v0 -> v1 -> v2)', () => {
    const migrations: MigrationStep[] = [
      { fromVersion: 0, toVersion: 1, up: (d) => d },
      { fromVersion: 1, toVersion: 2, up: (d) => d },
    ];

    expect(() => validateMigrationChain(migrations, 'test')).not.toThrow();
  });

  it('accepts an empty migrations array', () => {
    expect(() => validateMigrationChain([], 'test')).not.toThrow();
  });

  it('accepts migrations defined out of order', () => {
    const migrations: MigrationStep[] = [
      { fromVersion: 1, toVersion: 2, up: (d) => d },
      { fromVersion: 0, toVersion: 1, up: (d) => d },
    ];

    expect(() => validateMigrationChain(migrations, 'test')).not.toThrow();
  });

  it('throws MigrationError when chain has a gap', () => {
    const migrations: MigrationStep[] = [
      { fromVersion: 0, toVersion: 1, up: (d) => d },
      // gap: missing v1 -> v2
      { fromVersion: 2, toVersion: 3, up: (d) => d },
    ];

    expect(() => validateMigrationChain(migrations, 'test')).toThrow(MigrationError);
    expect(() => validateMigrationChain(migrations, 'test')).toThrow(/gap/);
  });

  it('throws MigrationError when chain starts above v0', () => {
    const migrations: MigrationStep[] = [
      { fromVersion: 1, toVersion: 2, up: (d) => d },
    ];

    expect(() => validateMigrationChain(migrations, 'test')).toThrow(MigrationError);
    expect(() => validateMigrationChain(migrations, 'test')).toThrow(/gap/);
  });

  it('includes label in error message', () => {
    const migrations: MigrationStep[] = [
      { fromVersion: 0, toVersion: 1, up: (d) => d },
      // gap: missing v1 -> v2
      { fromVersion: 2, toVersion: 3, up: (d) => d },
    ];

    expect(() => validateMigrationChain(migrations, 'MyEntry')).toThrow(/MyEntry/);
  });

  it('handles single-step chain correctly', () => {
    const migrations: MigrationStep[] = [
      { fromVersion: 0, toVersion: 1, up: (d) => d },
    ];

    expect(() => validateMigrationChain(migrations, 'test')).not.toThrow();
  });

  it('throws MigrationError for duplicate fromVersion', () => {
    const migrations: MigrationStep[] = [
      { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, a: true }) },
      { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, b: true }) },
    ];

    expect(() => validateMigrationChain(migrations, 'test')).toThrow(MigrationError);
    expect(() => validateMigrationChain(migrations, 'test')).toThrow(/duplicate/);
  });

  it('throws MigrationError when toVersion <= fromVersion', () => {
    const same: MigrationStep[] = [
      { fromVersion: 0, toVersion: 0, up: (d) => d },
    ];
    expect(() => validateMigrationChain(same, 'test')).toThrow(MigrationError);
    expect(() => validateMigrationChain(same, 'test')).toThrow(/toVersion.*<=.*fromVersion/);

    const backwards: MigrationStep[] = [
      { fromVersion: 1, toVersion: 0, up: (d) => d },
    ];
    expect(() => validateMigrationChain(backwards, 'test')).toThrow(MigrationError);
    expect(() => validateMigrationChain(backwards, 'test')).toThrow(/toVersion.*<=.*fromVersion/);
  });

  it('accepts non-contiguous version jumps (e.g., v0 -> v2)', () => {
    const migrations: MigrationStep[] = [
      { fromVersion: 0, toVersion: 2, up: (d) => ({ ...d, jumped: true }) },
    ];

    expect(() => validateMigrationChain(migrations, 'test')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// migrateRecord
// ---------------------------------------------------------------------------

describe('migrateRecord', () => {
  const tourSchemaV2 = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      status: { type: 'string' },
    },
  };

  const registryWithMigrations = createRegistry([
    {
      aType: 'tour',
      axbType: 'is',
      bType: 'tour',
      jsonSchema: tourSchemaV2,
      migrations: [
        { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, status: d.status ?? 'draft' }) },
        { fromVersion: 1, toVersion: 2, up: (d) => ({ ...d, active: true }) },
      ],
    },
  ]);

  const registryWithoutMigrations = createRegistry([
    {
      aType: 'tour',
      axbType: 'is',
      bType: 'tour',
      jsonSchema: tourSchemaV2,
    },
  ]);

  it('migrates a record from v0 to current version', async () => {
    const record = makeRecord('tour', { title: 'test' });
    const result = await migrateRecord(record, registryWithMigrations);

    expect(result.migrated).toBe(true);
    expect(result.record.v).toBe(2);
    expect(result.record.data).toEqual({
      title: 'test',
      status: 'draft',
      active: true,
    });
  });

  it('does not migrate records already at current version', async () => {
    const record = makeRecord('tour', { title: 'test' }, 'is', undefined, 2);
    const result = await migrateRecord(record, registryWithMigrations);

    expect(result.migrated).toBe(false);
    expect(result.record.data).toEqual({ title: 'test' });
  });

  it('does not migrate records without v (treated as v0) when no migrations', async () => {
    const record = makeRecord('tour', { title: 'test' });
    const result = await migrateRecord(record, registryWithoutMigrations);

    expect(result.migrated).toBe(false);
  });

  it('does not migrate unknown types', async () => {
    const record = makeRecord('unknown', { title: 'test' });
    const result = await migrateRecord(record, registryWithMigrations);

    expect(result.migrated).toBe(false);
  });

  it('resolves write-back from entry-level override', async () => {
    const registry = createRegistry([
      {
        aType: 'tour',
        axbType: 'is',
        bType: 'tour',
        migrations: [{ fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, x: 1 }) }],
        migrationWriteBack: 'eager',
      },
    ]);

    const record = makeRecord('tour', {});
    const result = await migrateRecord(record, registry, 'off');

    expect(result.writeBack).toBe('eager');
  });

  it('falls back to global write-back when entry has none', async () => {
    const record = makeRecord('tour', {});
    const result = await migrateRecord(record, registryWithMigrations, 'background');

    expect(result.writeBack).toBe('background');
  });

  it('defaults to off when no write-back is specified', async () => {
    const record = makeRecord('tour', {});
    const result = await migrateRecord(record, registryWithMigrations);

    expect(result.writeBack).toBe('off');
  });

  it('migrates from intermediate version', async () => {
    const record = makeRecord('tour', { title: 'test', status: 'active' }, 'is', undefined, 1);
    const result = await migrateRecord(record, registryWithMigrations);

    expect(result.migrated).toBe(true);
    expect(result.record.v).toBe(2);
    expect(result.record.data.active).toBe(true);
    // status should be preserved from v1 data, not overwritten
    expect(result.record.data.status).toBe('active');
  });

  it('skips migration when record version exceeds schema version', async () => {
    const record = makeRecord('tour', { title: 'test' }, 'is', undefined, 99);
    const result = await migrateRecord(record, registryWithMigrations);

    expect(result.migrated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// migrateRecords
// ---------------------------------------------------------------------------

describe('migrateRecords', () => {
  const registry = createRegistry([
    {
      aType: 'task',
      axbType: 'is',
      bType: 'task',
      migrations: [
        { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, done: false }) },
      ],
    },
  ]);

  it('migrates multiple records', async () => {
    const records = [
      makeRecord('task', { title: 'a' }),
      makeRecord('task', { title: 'b' }),
      makeRecord('task', { title: 'c' }, 'is', undefined, 1),
    ];

    const results = await migrateRecords(records, registry);
    expect(results[0].migrated).toBe(true);
    expect(results[0].record.data.done).toBe(false);
    expect(results[1].migrated).toBe(true);
    expect(results[2].migrated).toBe(false);
  });

  it('returns empty array for empty input', async () => {
    const results = await migrateRecords([], registry);
    expect(results).toEqual([]);
  });
});
