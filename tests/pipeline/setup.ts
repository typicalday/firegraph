/**
 * Setup for pipeline integration tests against a real Firestore Enterprise database.
 *
 * STATUS: RESEARCH / EXPLORATORY
 * These tests validate raw Firestore Pipeline API capabilities against
 * firegraph's data model patterns. They do NOT test any firegraph pipeline
 * integration (which doesn't exist yet). Once firegraph has its own pipeline
 * query engine with proper integration tests, this exploratory suite can be
 * removed. Also consider removing once Pipeline operations exits Preview and
 * the emulator gains pipeline support.
 *
 * WHY A REAL DATABASE?
 * The Firestore emulator does NOT support Pipeline operations as of early 2026.
 * Pipeline operations are an Enterprise-only feature that requires a real
 * Firestore Enterprise database. Until emulator support lands, these tests
 * must run against a live project.
 *
 * REQUIRED ENVIRONMENT VARIABLES:
 *   PIPELINE_TEST_PROJECT  — Firebase/GCP project ID (e.g. "my-project")
 *   PIPELINE_TEST_DATABASE — Firestore Enterprise database ID (required)
 *
 * AUTHENTICATION:
 * Uses Application Default Credentials (ADC). Run one of:
 *   gcloud auth application-default login
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *
 * Example:
 *   PIPELINE_TEST_PROJECT=my-project PIPELINE_TEST_DATABASE=my-db pnpm vitest run tests/pipeline/
 */
import { Firestore, Pipelines } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';

const PROJECT_ID = process.env.PIPELINE_TEST_PROJECT;
const DATABASE_ID = process.env.PIPELINE_TEST_DATABASE;

if (!PROJECT_ID || !DATABASE_ID) {
  throw new Error(
    'PIPELINE_TEST_PROJECT and PIPELINE_TEST_DATABASE environment variables are required.\n\n' +
    'Pipeline tests require a real Firestore Enterprise database because ' +
    'the Firestore emulator does not support Pipeline operations.\n\n' +
    'Usage:\n' +
    '  PIPELINE_TEST_PROJECT=<project> PIPELINE_TEST_DATABASE=<db-id> pnpm vitest run tests/pipeline/\n\n' +
    'The database must be Firestore Enterprise edition. Create one with:\n' +
    '  gcloud firestore databases create --database=<db-id> --location=<region> \\\n' +
    '    --type=firestore-native --edition=enterprise --project=<project>\n\n' +
    'Make sure you have ADC configured:\n' +
    '  gcloud auth application-default login',
  );
}

/**
 * Returns a @google-cloud/firestore v8 Firestore instance with pipeline support.
 * This is the instance you call `.pipeline()` on.
 */
let _pipelineDb: Firestore | null = null;
export function getPipelineFirestore(): Firestore {
  if (!_pipelineDb) {
    _pipelineDb = new Firestore({
      projectId: PROJECT_ID,
      databaseId: DATABASE_ID,
    });
  }
  return _pipelineDb;
}

/**
 * Alias for getPipelineFirestore() — with the single SDK there is no
 * separate "admin" instance. Kept for backwards compatibility with tests
 * that reference getAdminFirestore().
 */
export function getAdminFirestore(): Firestore {
  return getPipelineFirestore();
}

/**
 * Generates a unique collection path to isolate each test run.
 * Uses a nested path under `_pipeline_tests` for easy cleanup.
 */
export function uniqueCollectionPath(): string {
  return `_pipeline_tests/${randomUUID()}/graph`;
}

/**
 * Cleans up all documents in a collection path.
 */
export async function cleanupCollection(collectionPath: string): Promise<number> {
  const db = getPipelineFirestore();
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

export { Pipelines };
