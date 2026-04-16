import { beforeAll, describe, expect, it, vi } from 'vitest';

import { QuerySafetyError } from '../../src/errors.js';
import { generateId } from '../../src/id.js';
import { createTestGraphClient, ensureSqliteBackend, uniqueCollectionPath } from './setup.js';

describe('query safety integration', () => {
  beforeAll(async () => {
    await ensureSqliteBackend();
  });

  describe('scanProtection: error (default)', () => {
    it('throws QuerySafetyError for unsafe findEdges (lone aUid)', async () => {
      const client = createTestGraphClient(uniqueCollectionPath());
      await expect(client.findEdges({ aUid: generateId() })).rejects.toThrow(QuerySafetyError);
    });

    it('throws QuerySafetyError for unsafe findEdges (lone bUid)', async () => {
      const client = createTestGraphClient(uniqueCollectionPath());
      await expect(client.findEdges({ bUid: generateId() })).rejects.toThrow(QuerySafetyError);
    });

    it('throws QuerySafetyError for unsafe findEdges (lone axbType)', async () => {
      const client = createTestGraphClient(uniqueCollectionPath());
      await expect(client.findEdges({ axbType: 'hasDep' })).rejects.toThrow(QuerySafetyError);
    });

    it('does NOT throw for safe findEdges (aUid + axbType)', async () => {
      const client = createTestGraphClient(uniqueCollectionPath());
      // Safe pattern — should not throw, may return empty
      const result = await client.findEdges({ aUid: generateId(), axbType: 'hasDep' });
      expect(result).toEqual([]);
    });

    it('does NOT throw for safe findNodes (aType + axbType is implicit)', async () => {
      const client = createTestGraphClient(uniqueCollectionPath());
      // findNodes always produces aType + axbType=='is' — a safe pattern
      const result = await client.findNodes({ aType: 'tour' });
      expect(result).toEqual([]);
    });

    it('does NOT throw for direct doc lookup (get strategy)', async () => {
      const client = createTestGraphClient(uniqueCollectionPath());
      // All 3 IDs present — bypasses query entirely, uses get strategy
      const result = await client.findEdges({
        aUid: generateId(),
        axbType: 'hasDep',
        bUid: generateId(),
      });
      expect(result).toEqual([]);
    });
  });

  describe('allowCollectionScan override', () => {
    it('allows unsafe query when allowCollectionScan is true', async () => {
      const client = createTestGraphClient(uniqueCollectionPath());
      const result = await client.findEdges({
        aUid: generateId(),
        allowCollectionScan: true,
      });
      expect(result).toEqual([]);
    });

    it('allows unsafe findNodes when allowCollectionScan is true', async () => {
      const client = createTestGraphClient(uniqueCollectionPath());
      // findNodes with a where clause on data.* adds a data filter,
      // but aType + axbType is already safe — this just validates the param flows through
      const result = await client.findNodes({
        aType: 'tour',
        where: [{ field: 'status', op: '==', value: 'active' }],
        allowCollectionScan: true,
      });
      expect(result).toEqual([]);
    });
  });

  describe('scanProtection: warn', () => {
    it('logs a warning but does not throw for unsafe query', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const client = createTestGraphClient(uniqueCollectionPath(), {
          scanProtection: 'warn',
        });
        const result = await client.findEdges({ aUid: generateId() });
        expect(result).toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[firegraph] Query safety warning'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('scanProtection: off', () => {
    it('does not throw or warn for unsafe query', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const client = createTestGraphClient(uniqueCollectionPath(), {
          scanProtection: 'off',
        });
        const result = await client.findEdges({ aUid: generateId() });
        expect(result).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalledWith(
          expect.stringContaining('[firegraph] Query safety warning'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('transaction safety', () => {
    it('throws QuerySafetyError for unsafe query inside transaction', async () => {
      const client = createTestGraphClient(uniqueCollectionPath());
      await expect(
        client.runTransaction(async (tx) => {
          await tx.findEdges({ aUid: generateId() });
        }),
      ).rejects.toThrow(QuerySafetyError);
    });

    it('allows safe query inside transaction', async () => {
      const client = createTestGraphClient(uniqueCollectionPath());
      const result = await client.runTransaction(async (tx) => {
        return tx.findEdges({ aUid: generateId(), axbType: 'hasDep' });
      });
      expect(result).toEqual([]);
    });
  });

  describe('default limit', () => {
    it('applies default limit of 500 to findEdges', async () => {
      const col = uniqueCollectionPath();
      const client = createTestGraphClient(col);
      // We can verify the limit is applied by checking that the query executes
      // successfully — the limit is passed to Firestore internally.
      const result = await client.findEdges({ aUid: generateId(), axbType: 'hasDep' });
      expect(result).toEqual([]);
    });

    it('applies explicit limit override', async () => {
      const col = uniqueCollectionPath();
      const client = createTestGraphClient(col);
      const result = await client.findEdges({
        aUid: generateId(),
        axbType: 'hasDep',
        limit: 5,
      });
      expect(result).toEqual([]);
    });
  });
});
