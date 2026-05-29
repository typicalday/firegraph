/**
 * Unit tests for `buildFirestoreUpdateArgs` — the pure helper that turns an
 * `UpdatePayload` into the variadic argument list for Firestore's
 * `DocumentReference.update(field, value, …)` overload.
 *
 * The key behaviour under test: deep-path ops are addressed with
 * `FieldPath('data', …segments)` literal segments rather than a dotted
 * `data.a.b` string. That makes exotic object keys (digit-leading,
 * hyphens, dots, brackets, whitespace) address the literal key instead of
 * being reparsed by Firestore's dotted-path syntax. Verified here without a
 * live Firestore — the function is pure given a `db` handle (only used to
 * reconstruct tagged types inside `replaceData`).
 */

import type { Firestore } from '@google-cloud/firestore';
import { FieldPath, FieldValue } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';

import { buildFirestoreUpdateArgs } from '../../src/internal/firestore-update.js';
import { deleteField, flattenPatch } from '../../src/internal/write-plan.js';

const db = {} as Firestore;

describe('buildFirestoreUpdateArgs — dataOps', () => {
  it('stamps updatedAt as a trailing serverTimestamp field/value pair', () => {
    const args = buildFirestoreUpdateArgs({ dataOps: flattenPatch({ status: 'active' }) }, db);
    const idx = args.indexOf('updatedAt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect((args[idx + 1] as FieldValue).isEqual(FieldValue.serverTimestamp())).toBe(true);
  });

  it('addresses a shallow op via FieldPath(data, key)', () => {
    const args = buildFirestoreUpdateArgs({ dataOps: flattenPatch({ status: 'active' }) }, db);
    expect(args[0]).toBeInstanceOf(FieldPath);
    expect((args[0] as FieldPath).isEqual(new FieldPath('data', 'status'))).toBe(true);
    expect(args[1]).toBe('active');
  });

  it('addresses a deep exotic key via literal FieldPath segments (no dotted reparse)', () => {
    const args = buildFirestoreUpdateArgs(
      { dataOps: flattenPatch({ holds: { '4f9Kq_2bN': { userId: 'u1' } } }) },
      db,
    );
    expect(
      (args[0] as FieldPath).isEqual(new FieldPath('data', 'holds', '4f9Kq_2bN', 'userId')),
    ).toBe(true);
    expect(args[1]).toBe('u1');
  });

  it('keeps a dotted key as a single literal segment', () => {
    const args = buildFirestoreUpdateArgs({ dataOps: flattenPatch({ 'a.b': 1 }) }, db);
    expect((args[0] as FieldPath).isEqual(new FieldPath('data', 'a.b'))).toBe(true);
  });

  it('emits FieldValue.delete() for a deleteField() op', () => {
    const args = buildFirestoreUpdateArgs(
      { dataOps: flattenPatch({ obsolete: deleteField() }) },
      db,
    );
    expect((args[0] as FieldPath).isEqual(new FieldPath('data', 'obsolete'))).toBe(true);
    expect((args[1] as FieldValue).isEqual(FieldValue.delete())).toBe(true);
  });

  it('stamps v as a top-level string field when provided', () => {
    const args = buildFirestoreUpdateArgs({ dataOps: flattenPatch({ a: 1 }), v: 3 }, db);
    const idx = args.indexOf('v');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(3);
  });
});

describe('buildFirestoreUpdateArgs — replaceData', () => {
  it('sets the whole data field via the string "data" key', () => {
    const args = buildFirestoreUpdateArgs({ replaceData: { name: 'x' } }, db);
    expect(args[0]).toBe('data');
    expect(args[1]).toEqual({ name: 'x' });
  });

  it('rejects combining replaceData and dataOps', () => {
    expect(() => buildFirestoreUpdateArgs({ replaceData: {}, dataOps: [] }, db)).toThrow(
      /cannot specify both/,
    );
  });
});
