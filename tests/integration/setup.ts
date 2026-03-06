import { Firestore } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'demo-firegraph';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1';
const PORT = process.env.FIRESTORE_EMULATOR_PORT || '8188';

// Ensure the emulator host env var is set for @google-cloud/firestore
if (!process.env.FIRESTORE_EMULATOR_HOST?.includes(':')) {
  process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${PORT}`;
}

let _db: Firestore | null = null;

export function getTestFirestore(): Firestore {
  if (!_db) {
    _db = new Firestore({ projectId: PROJECT_ID });
  }
  return _db;
}

export function uniqueCollectionPath(): string {
  return `test/${randomUUID()}/graph`;
}
