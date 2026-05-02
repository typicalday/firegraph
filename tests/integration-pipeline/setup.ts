/**
 * Setup for pipeline integration tests.
 *
 * These tests validate firegraph's pipeline query engine against a real
 * Firestore Enterprise database. Unlike the research tests in tests/pipeline/
 * (which test raw Pipeline API capabilities), these test firegraph's
 * createGraphClient() with queryMode: 'pipeline'.
 *
 * REQUIRED ENVIRONMENT VARIABLES:
 *   PIPELINE_TEST_PROJECT  — Firebase/GCP project ID
 *   PIPELINE_TEST_DATABASE — Firestore Enterprise database ID
 *
 * AUTHENTICATION:
 * Uses Application Default Credentials (ADC). Run one of:
 *   gcloud auth application-default login
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *
 * Example:
 *   PIPELINE_TEST_PROJECT=my-project PIPELINE_TEST_DATABASE=my-db pnpm vitest run tests/integration-pipeline/
 */
import { randomUUID } from 'node:crypto';

import { Firestore } from '@google-cloud/firestore';

import type { GraphClient } from '../../src/types.js';
import { createGraphClient } from '../helpers/firestore-client.js';

const PROJECT_ID = process.env.PIPELINE_TEST_PROJECT;
const DATABASE_ID = process.env.PIPELINE_TEST_DATABASE;

if (!PROJECT_ID || !DATABASE_ID) {
  throw new Error(
    'PIPELINE_TEST_PROJECT and PIPELINE_TEST_DATABASE environment variables are required.\n\n' +
      'Pipeline integration tests require a real Firestore Enterprise database.\n\n' +
      'Usage:\n' +
      '  PIPELINE_TEST_PROJECT=<project> PIPELINE_TEST_DATABASE=<db-id> pnpm vitest run tests/integration-pipeline/\n',
  );
}

let _db: Firestore | null = null;

export function getFirestore(): Firestore {
  if (!_db) {
    _db = new Firestore({
      projectId: PROJECT_ID,
      databaseId: DATABASE_ID,
    });
  }
  return _db;
}

/** Creates a unique collection path to isolate each test run. */
export function uniqueCollectionPath(): string {
  return `_pipeline_integration/${randomUUID()}/graph`;
}

/** Creates a graph client in pipeline mode. */
export function createPipelineClient(collectionPath: string): GraphClient {
  return createGraphClient(getFirestore(), collectionPath, {
    queryMode: 'pipeline',
  });
}

/** Creates a graph client in standard mode (for comparison tests). */
export function createStandardClient(collectionPath: string): GraphClient {
  return createGraphClient(getFirestore(), collectionPath, {
    queryMode: 'standard',
  });
}

/** Cleans up all documents in a collection path. */
export async function cleanupCollection(collectionPath: string): Promise<number> {
  const db = getFirestore();
  const collRef = db.collection(collectionPath);
  const snap = await collRef.get();
  if (snap.empty) return 0;

  const batch = db.batch();
  for (const doc of snap.docs) {
    batch.delete(doc.ref);
  }
  await batch.commit();
  return snap.size;
}
