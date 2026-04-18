/**
 * Firestore-specific client factory.
 *
 * Kept in its own module so that bundlers don't pull
 * `@google-cloud/firestore` into non-Firestore entry points — most
 * importantly the Cloudflare DO backend (`firegraph/cloudflare`) and the
 * routing primitive (`firegraph/backend`), both of which must load cleanly
 * in a Workers environment where the Node Firestore SDK is unavailable.
 */

import type { Firestore } from '@google-cloud/firestore';

import { GraphClientImpl } from './client.js';
import type { StorageBackend } from './internal/backend.js';
import { createFirestoreBackend } from './internal/firestore-backend.js';
import type {
  DynamicGraphClient,
  DynamicRegistryConfig,
  GraphClient,
  GraphClientOptions,
  QueryMode,
} from './types.js';

let _standardModeWarned = false;

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
  const requestedMode = options?.queryMode ?? 'pipeline';
  const isEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  const effectiveMode: QueryMode = isEmulator ? 'standard' : requestedMode;

  if (
    effectiveMode === 'standard' &&
    !isEmulator &&
    requestedMode === 'standard' &&
    !_standardModeWarned
  ) {
    _standardModeWarned = true;
    console.warn(
      '[firegraph] Standard query mode enabled. This is NOT recommended for production:\n' +
        '  - Enterprise Firestore: data.* filters cause full collection scans (high billing)\n' +
        '  - Standard Firestore: data.* filters without composite indexes will fail\n' +
        '  See: https://github.com/typicalday/firegraph#query-modes',
    );
  }

  const backend = createFirestoreBackend(db, collectionPath, { queryMode: effectiveMode });

  let metaBackend: StorageBackend | undefined;
  if (options?.registryMode?.collection && options.registryMode.collection !== collectionPath) {
    metaBackend = createFirestoreBackend(db, options.registryMode.collection, {
      queryMode: effectiveMode,
    });
  }

  return new GraphClientImpl(backend, options, metaBackend) as GraphClient | DynamicGraphClient;
}
