/**
 * Test-only helper that preserves the old Firestore-specific
 * `createGraphClient(db, collectionPath, options)` signature for tests
 * exercising the Firestore Enterprise backend directly.
 *
 * Production code uses the two-step pattern:
 *   const backend = createFirestoreEnterpriseBackend(db, path, opts);
 *   const client = createGraphClient(backend, opts);
 *
 * This helper exists purely so the post-Phase-2 test suite doesn't have to
 * inline that pattern in every `it()` block. New tests should still prefer
 * `createTestGraphClient` from `tests/integration/setup.ts` when backend
 * parity matters.
 */

import type { Firestore } from '@google-cloud/firestore';

import { createGraphClient as createGraphClientFromBackend } from '../../src/client.js';
import {
  createFirestoreEnterpriseBackend,
  type FirestoreEnterpriseQueryMode,
} from '../../src/firestore-enterprise/backend.js';
import type {
  DynamicGraphClient,
  DynamicRegistryConfig,
  GraphClient,
  GraphClientOptions,
  QueryMode,
} from '../../src/types.js';

function mapQueryMode(mode: QueryMode | undefined): FirestoreEnterpriseQueryMode | undefined {
  if (mode === undefined) return undefined;
  // Old `'standard'` (the classic Query API) maps to the Enterprise backend's
  // `'classic'` mode. `'pipeline'` is unchanged.
  return mode === 'standard' ? 'classic' : 'pipeline';
}

export function createGraphClient(
  db: Firestore,
  collectionPath: string,
  options: GraphClientOptions & { registryMode: DynamicRegistryConfig },
): DynamicGraphClient;
export function createGraphClient(
  db: Firestore,
  collectionPath: string,
  options?: GraphClientOptions,
): GraphClient;
export function createGraphClient(
  db: Firestore,
  collectionPath: string,
  options?: GraphClientOptions,
): GraphClient | DynamicGraphClient {
  const enterpriseMode = mapQueryMode(options?.queryMode);
  const backend = createFirestoreEnterpriseBackend(db, collectionPath, {
    defaultQueryMode: enterpriseMode,
  });

  let metaBackend;
  if (options?.registryMode?.collection && options.registryMode.collection !== collectionPath) {
    metaBackend = createFirestoreEnterpriseBackend(db, options.registryMode.collection, {
      defaultQueryMode: enterpriseMode,
    });
  }

  return createGraphClientFromBackend(backend, options, metaBackend) as
    | GraphClient
    | DynamicGraphClient;
}
