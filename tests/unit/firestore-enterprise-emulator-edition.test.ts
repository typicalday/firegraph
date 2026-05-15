/**
 * `FIRESTORE_EMULATOR_EDITION` gate on the Firestore Enterprise backend.
 *
 * firebase-tools v15.14+ ships an Enterprise-edition emulator that does
 * support the Pipeline API, so the historical "emulator forces classic"
 * coercion is too aggressive once an Enterprise emulator is in use. The
 * backend honors `FIRESTORE_EMULATOR_EDITION=enterprise` (case-insensitive)
 * as the opt-in switch — `backend.queryMode` is set at construction time
 * and reflects the *effective* mode, never the requested one.
 */
import type { Firestore } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFirestoreEnterpriseBackend } from '../../src/firestore-enterprise/backend.js';

function makeStubFirestore(): Firestore {
  const collectionStub = {
    doc: () => ({}),
    where: () => collectionStub,
    orderBy: () => collectionStub,
    limit: () => collectionStub,
    get: async () => ({ docs: [] }),
  };
  return {
    collection: () => collectionStub,
    collectionGroup: () => collectionStub,
  } as unknown as Firestore;
}

describe('Firestore Enterprise emulator-edition gate', () => {
  const ORIGINAL_HOST = process.env.FIRESTORE_EMULATOR_HOST;
  const ORIGINAL_EDITION = process.env.FIRESTORE_EMULATOR_EDITION;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.FIRESTORE_EMULATOR_EDITION;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (ORIGINAL_HOST === undefined) {
      delete process.env.FIRESTORE_EMULATOR_HOST;
    } else {
      process.env.FIRESTORE_EMULATOR_HOST = ORIGINAL_HOST;
    }
    if (ORIGINAL_EDITION === undefined) {
      delete process.env.FIRESTORE_EMULATOR_EDITION;
    } else {
      process.env.FIRESTORE_EMULATOR_EDITION = ORIGINAL_EDITION;
    }
    warn.mockRestore();
  });

  it('production (no emulator host): requested pipeline mode is honored', () => {
    // No emulator at all — the edition env var has no effect on production.
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph');
    expect(backend.queryMode).toBe('pipeline');
  });

  it('production (no emulator host): the edition env var is inert', () => {
    // Setting the var without an emulator host must NOT change anything;
    // production never reads it.
    process.env.FIRESTORE_EMULATOR_EDITION = 'enterprise';
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph');
    expect(backend.queryMode).toBe('pipeline');
  });

  it('emulator host set, edition unset: pipeline request is forced to classic (default)', () => {
    // Legacy / default emulator: edition var is unset, so we assume non-enterprise
    // and the historical "force classic" behavior applies. Existing consumers
    // see no change.
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8188';
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph');
    expect(backend.queryMode).toBe('classic');
  });

  it('emulator host set, edition=enterprise: pipeline request is honored', () => {
    // firebase-tools v15.14+ with `--database-edition enterprise`: pipelines
    // DO work in this emulator, so the historical coercion should NOT fire.
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8188';
    process.env.FIRESTORE_EMULATOR_EDITION = 'enterprise';
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'pipeline',
    });
    expect(backend.queryMode).toBe('pipeline');
  });

  it('emulator host set, edition=ENTERPRISE (uppercase): pipeline request is honored', () => {
    // Edition match is case-insensitive — `firebase.json` is technically
    // case-sensitive but users mistype this.
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8188';
    process.env.FIRESTORE_EMULATOR_EDITION = 'ENTERPRISE';
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'pipeline',
    });
    expect(backend.queryMode).toBe('pipeline');
  });

  it('emulator host set, edition=Enterprise (mixed case): pipeline request is honored', () => {
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8188';
    process.env.FIRESTORE_EMULATOR_EDITION = 'Enterprise';
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'pipeline',
    });
    expect(backend.queryMode).toBe('pipeline');
  });

  it('emulator host set, edition=standard: pipeline request is forced to classic', () => {
    // Any value other than `enterprise` (case-insensitive) is treated as
    // "not enterprise" and the historical coercion applies.
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8188';
    process.env.FIRESTORE_EMULATOR_EDITION = 'standard';
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'pipeline',
    });
    expect(backend.queryMode).toBe('classic');
  });

  it('emulator host set, edition=garbage: pipeline request is forced to classic', () => {
    // Unknown values: silently treated as non-enterprise. We do not throw —
    // the validation/error message is the consumer's responsibility.
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8188';
    process.env.FIRESTORE_EMULATOR_EDITION = 'totally-not-a-real-edition';
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'pipeline',
    });
    expect(backend.queryMode).toBe('classic');
  });

  it('emulator host set, edition=empty string: pipeline request is forced to classic', () => {
    // Empty string is "not enterprise" — same default-emulator behavior.
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8188';
    process.env.FIRESTORE_EMULATOR_EDITION = '';
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'pipeline',
    });
    expect(backend.queryMode).toBe('classic');
  });

  it('emulator host set, edition=enterprise, requested=classic: classic is honored verbatim', () => {
    // The env var only flips the coercion off — an explicit `classic`
    // request still resolves to classic.
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8188';
    process.env.FIRESTORE_EMULATOR_EDITION = 'enterprise';
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'classic',
    });
    expect(backend.queryMode).toBe('classic');
  });

  it('emulator host set, edition=" enterprise " (whitespace-padded): pipeline request is honored', () => {
    // `.trim()` is applied before `.toLowerCase()` so values copy-pasted
    // from shell profiles or Docker env files that carry stray whitespace
    // don't silently fall through to the classic coercion.
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8188';
    process.env.FIRESTORE_EMULATOR_EDITION = '  enterprise  ';
    const backend = createFirestoreEnterpriseBackend(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'pipeline',
    });
    expect(backend.queryMode).toBe('pipeline');
  });

  it('emulator host set, edition unset: warns once with the upgraded message', async () => {
    // The module-scoped `_emulatorFallbackWarned` flag leaks across tests
    // in the same worker, so `vi.resetModules()` gives this test a fresh
    // module state and a reliable signal that the warning fires AND
    // contains the new `FIRESTORE_EMULATOR_EDITION=enterprise` opt-in hint.
    vi.resetModules();
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8188';
    delete process.env.FIRESTORE_EMULATOR_EDITION;
    const { createFirestoreEnterpriseBackend: freshFactory } =
      await import('../../src/firestore-enterprise/backend.js');
    const backend = freshFactory(makeStubFirestore(), 'firegraph', {
      defaultQueryMode: 'pipeline',
    });
    expect(backend.queryMode).toBe('classic');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('FIRESTORE_EMULATOR_EDITION=enterprise'),
    );
    // Second construction must NOT re-warn (the flag is sticky on the
    // freshly-imported module instance).
    freshFactory(makeStubFirestore(), 'firegraph', { defaultQueryMode: 'pipeline' });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
