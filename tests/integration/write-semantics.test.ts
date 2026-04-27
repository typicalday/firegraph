/**
 * Cross-backend contract for `putNode`/`putEdge` (deep-merge),
 * `replaceNode`/`replaceEdge` (full replace), `updateNode`/`updateEdge`
 * (deep-merge partial), and the `deleteField()` sentinel.
 *
 * Runs against whichever backend is selected by `BACKEND=` — Firestore
 * (default, via emulator) or SQLite (`BACKEND=sqlite`). The whole point of
 * the 0.12 write-semantics refactor was that callers shouldn't observe any
 * difference between backends, so every behavioural assertion below has to
 * hold for both.
 *
 * Coverage matrix:
 *   - put / replace, on nodes and edges
 *   - update with deep paths, on nodes and edges
 *   - sibling-key survival at depth (the bug the refactor fixed)
 *   - arrays as terminal values (replaced, not element-merged)
 *   - `null` preserved verbatim
 *   - `undefined` skipped (no op generated)
 *   - `deleteField()` sentinel removes the field
 *   - cross-method round-trips (put → update → replace → update)
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { deleteField } from '../../src/internal/write-plan.js';
import type { GraphClient } from '../../src/types.js';
import { createTestGraphClient, ensureSqliteBackend, uniqueCollectionPath } from './setup.js';

describe('write semantics contract — put/replace/update/deleteField', () => {
  let g: GraphClient;

  beforeAll(async () => {
    await ensureSqliteBackend();
  });

  beforeEach(() => {
    g = createTestGraphClient(uniqueCollectionPath());
  });

  // -------------------------------------------------------------------------
  // putNode — deep merge
  // -------------------------------------------------------------------------
  describe('putNode (default merge)', () => {
    it('preserves top-level sibling keys on second put', async () => {
      await g.putNode('tour', 'a', { name: 'Original', kept: 'yes' });
      await g.putNode('tour', 'a', { name: 'Updated' });
      const node = await g.getNode('a');
      expect(node!.data).toEqual({ name: 'Updated', kept: 'yes' });
    });

    it('preserves nested sibling keys on second put (deep merge)', async () => {
      await g.putNode('tour', 'a', { meta: { name: 'A', region: 'EU' } });
      await g.putNode('tour', 'a', { meta: { name: 'B' } });
      const node = await g.getNode('a');
      expect(node!.data).toEqual({ meta: { name: 'B', region: 'EU' } });
    });

    it('replaces arrays wholesale (arrays are terminal)', async () => {
      await g.putNode('tour', 'a', { tags: ['alpha', 'beta'] });
      await g.putNode('tour', 'a', { tags: ['gamma'] });
      const node = await g.getNode('a');
      expect(node!.data.tags).toEqual(['gamma']);
    });
  });

  // -------------------------------------------------------------------------
  // replaceNode — full replace
  // -------------------------------------------------------------------------
  describe('replaceNode', () => {
    it('discards any prior keys not in the new payload', async () => {
      await g.putNode('tour', 'a', { name: 'A', kept: 'yes', meta: { region: 'EU' } });
      await g.replaceNode('tour', 'a', { name: 'B' });
      const node = await g.getNode('a');
      expect(node!.data).toEqual({ name: 'B' });
    });
  });

  // -------------------------------------------------------------------------
  // updateNode — deep partial merge
  // -------------------------------------------------------------------------
  describe('updateNode (deep partial)', () => {
    it('updates a nested leaf without disturbing siblings at any depth', async () => {
      await g.putNode('tour', 'a', {
        meta: { name: 'A', address: { street: 'Old', city: 'Madrid' } },
        kept: 'yes',
      });
      await g.updateNode('a', { meta: { address: { street: 'New' } } });
      const node = await g.getNode('a');
      expect(node!.data).toEqual({
        meta: { name: 'A', address: { street: 'New', city: 'Madrid' } },
        kept: 'yes',
      });
    });

    it('treats arrays as terminal (replaces, does not element-merge)', async () => {
      await g.putNode('tour', 'a', { tags: ['x', 'y'], kept: 'yes' });
      await g.updateNode('a', { tags: ['z'] });
      const node = await g.getNode('a');
      expect(node!.data).toEqual({ tags: ['z'], kept: 'yes' });
    });

    it('skips undefined values without dropping siblings', async () => {
      await g.putNode('tour', 'a', { name: 'A', meta: { kept: 'yes' } });
      await g.updateNode('a', { meta: { kept: undefined, added: 'new' } });
      const node = await g.getNode('a');
      // `kept: undefined` is a no-op — original `kept: 'yes'` survives.
      expect(node!.data).toEqual({ name: 'A', meta: { kept: 'yes', added: 'new' } });
    });

    it('preserves null verbatim', async () => {
      await g.putNode('tour', 'a', { meta: { region: 'EU' } });
      await g.updateNode('a', { meta: { region: null } });
      const node = await g.getNode('a');
      expect(node!.data).toEqual({ meta: { region: null } });
    });
  });

  // -------------------------------------------------------------------------
  // deleteField sentinel
  // -------------------------------------------------------------------------
  describe('deleteField()', () => {
    it('removes a top-level field', async () => {
      await g.putNode('tour', 'a', { name: 'A', drop: 'gone-soon', kept: 'yes' });
      await g.updateNode('a', { drop: deleteField() });
      const node = await g.getNode('a');
      expect(node!.data).toEqual({ name: 'A', kept: 'yes' });
    });

    it('removes a nested field without disturbing siblings', async () => {
      await g.putNode('tour', 'a', { meta: { name: 'A', drop: 'gone-soon' }, kept: 'yes' });
      await g.updateNode('a', { meta: { drop: deleteField() } });
      const node = await g.getNode('a');
      expect(node!.data).toEqual({ meta: { name: 'A' }, kept: 'yes' });
    });
  });

  // -------------------------------------------------------------------------
  // Edge-side parity — same semantics, different docId-shape (sharded).
  // -------------------------------------------------------------------------
  describe('edge writes — same semantics as nodes', () => {
    beforeEach(async () => {
      // Ensure both endpoints exist so getEdge resolves them.
      await g.putNode('tour', 'a', {});
      await g.putNode('departure', 'b', {});
    });

    it('putEdge deep-merges and replaceEdge wipes', async () => {
      await g.putEdge('tour', 'a', 'hasDeparture', 'departure', 'b', {
        meta: { order: 0, weight: 1 },
        kept: 'yes',
      });
      await g.putEdge('tour', 'a', 'hasDeparture', 'departure', 'b', {
        meta: { order: 5 },
      });
      let edge = await g.getEdge('a', 'hasDeparture', 'b');
      expect(edge!.data).toEqual({ meta: { order: 5, weight: 1 }, kept: 'yes' });

      await g.replaceEdge('tour', 'a', 'hasDeparture', 'departure', 'b', {
        meta: { order: 9 },
      });
      edge = await g.getEdge('a', 'hasDeparture', 'b');
      expect(edge!.data).toEqual({ meta: { order: 9 } });
    });

    it('updateEdge deep-merges + deleteField removes nested keys', async () => {
      await g.putEdge('tour', 'a', 'hasDeparture', 'departure', 'b', {
        meta: { order: 0, weight: 1 },
        notes: { drop: 'gone' },
      });
      await g.updateEdge('a', 'hasDeparture', 'b', {
        meta: { weight: 2 },
        notes: { drop: deleteField() },
      });
      const edge = await g.getEdge('a', 'hasDeparture', 'b');
      expect(edge!.data).toEqual({ meta: { order: 0, weight: 2 }, notes: {} });
    });
  });

  // -------------------------------------------------------------------------
  // Mixed deleteField + sets — both forms appear in the same payload.
  // -------------------------------------------------------------------------
  describe('updateNode mixing deleteField + sets', () => {
    it('removes one field while setting another in the same patch', async () => {
      await g.putNode('tour', 'a', {
        meta: { drop: 'gone-soon', region: 'EU', tags: ['old'] },
      });
      await g.updateNode('a', {
        meta: { drop: deleteField(), region: 'NA', added: 'new' },
      });
      const node = await g.getNode('a');
      expect(node!.data).toEqual({
        meta: { region: 'NA', added: 'new', tags: ['old'] },
      });
    });

    it('handles delete and set at sibling depths in one patch', async () => {
      await g.putNode('tour', 'a', {
        top: 'kept',
        nested: { dropMe: 1, keepMe: 2 },
        otherTop: 'gone-soon',
      });
      await g.updateNode('a', {
        nested: { dropMe: deleteField(), addMe: 3 },
        otherTop: deleteField(),
      });
      const node = await g.getNode('a');
      expect(node!.data).toEqual({
        top: 'kept',
        nested: { keepMe: 2, addMe: 3 },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Refusal cases — public API rejects illegal payloads at the entry.
  // -------------------------------------------------------------------------
  describe('public-API rejections', () => {
    it('rejects deleteField() inside a replaceNode payload', async () => {
      await g.putNode('tour', 'a', { name: 'A' });
      await expect(g.replaceNode('tour', 'a', { name: 'B', drop: deleteField() })).rejects.toThrow(
        /replaceNode payload contains a deleteField\(\) sentinel/,
      );
    });

    it('rejects deleteField() inside a putNode payload', async () => {
      await expect(g.putNode('tour', 'a', { name: 'A', drop: deleteField() })).rejects.toThrow(
        /putNode payload contains a deleteField\(\) sentinel/,
      );
    });

    it('rejects deleteField() inside a replaceEdge payload', async () => {
      await g.putNode('tour', 'a', {});
      await g.putNode('departure', 'b', {});
      await expect(
        g.replaceEdge('tour', 'a', 'hasDeparture', 'departure', 'b', {
          drop: deleteField(),
        }),
      ).rejects.toThrow(/replaceEdge payload contains a deleteField\(\) sentinel/);
    });
  });

  // -------------------------------------------------------------------------
  // Round-trip — combinations across all four methods.
  // -------------------------------------------------------------------------
  describe('round-trip across methods', () => {
    it('put → update → replace → update reaches the expected state', async () => {
      await g.putNode('tour', 'a', { meta: { region: 'EU' }, kept: 'one' });
      await g.updateNode('a', { meta: { lang: 'es' } });
      // After update: { meta: { region: 'EU', lang: 'es' }, kept: 'one' }

      await g.replaceNode('tour', 'a', { meta: { region: 'NA' } });
      // After replace: { meta: { region: 'NA' } } — `kept` and `lang` gone.

      await g.updateNode('a', { meta: { lang: 'en' }, added: 'two' });
      // Final:  { meta: { region: 'NA', lang: 'en' }, added: 'two' }
      const node = await g.getNode('a');
      expect(node!.data).toEqual({ meta: { region: 'NA', lang: 'en' }, added: 'two' });
    });
  });

  // -------------------------------------------------------------------------
  // Batch + transaction parity — the same semantics flow through commit/tx.
  // -------------------------------------------------------------------------
  describe('batch parity', () => {
    it('batch put deep-merges; batch replace wipes', async () => {
      await g.putNode('tour', 'a', { meta: { name: 'A', region: 'EU' }, kept: 'yes' });

      const b1 = g.batch();
      await b1.putNode('tour', 'a', { meta: { name: 'B' } });
      await b1.commit();
      let node = await g.getNode('a');
      expect(node!.data).toEqual({ meta: { name: 'B', region: 'EU' }, kept: 'yes' });

      const b2 = g.batch();
      await b2.replaceNode('tour', 'a', { meta: { name: 'C' } });
      await b2.commit();
      node = await g.getNode('a');
      expect(node!.data).toEqual({ meta: { name: 'C' } });
    });

    it('batch updateNode applies dataOps with deep merge + deleteField', async () => {
      await g.putNode('tour', 'a', { meta: { name: 'A', region: 'EU' }, drop: 'gone' });

      const b = g.batch();
      await b.updateNode('a', { meta: { name: 'B' }, drop: deleteField() });
      await b.commit();

      const node = await g.getNode('a');
      expect(node!.data).toEqual({ meta: { name: 'B', region: 'EU' } });
    });
  });

  describe('transaction parity', () => {
    it('tx put deep-merges and tx replace wipes', async () => {
      await g.putNode('tour', 'a', { meta: { name: 'A', region: 'EU' }, kept: 'yes' });

      await g.runTransaction(async (tx) => {
        await tx.putNode('tour', 'a', { meta: { name: 'B' } });
      });
      let node = await g.getNode('a');
      expect(node!.data).toEqual({ meta: { name: 'B', region: 'EU' }, kept: 'yes' });

      await g.runTransaction(async (tx) => {
        await tx.replaceNode('tour', 'a', { meta: { name: 'C' } });
      });
      node = await g.getNode('a');
      expect(node!.data).toEqual({ meta: { name: 'C' } });
    });

    it('tx updateNode applies dataOps with deep merge + deleteField', async () => {
      await g.putNode('tour', 'a', { meta: { name: 'A', region: 'EU' }, drop: 'gone' });

      await g.runTransaction(async (tx) => {
        await tx.updateNode('a', { meta: { name: 'B' }, drop: deleteField() });
      });
      const node = await g.getNode('a');
      expect(node!.data).toEqual({ meta: { name: 'B', region: 'EU' } });
    });
  });
});
