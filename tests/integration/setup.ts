import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'demo-firegraph';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1';
const PORT = process.env.FIRESTORE_EMULATOR_PORT || '8188';

// Ensure firebase-admin connects to the emulator
if (!process.env.FIRESTORE_EMULATOR_HOST?.includes(':')) {
  process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${PORT}`;
}

let initialized = false;

export function getTestFirestore() {
  if (!initialized) {
    if (getApps().length === 0) {
      initializeApp({ projectId: PROJECT_ID });
    }
    initialized = true;
  }
  return getFirestore();
}

export function uniqueCollectionPath(): string {
  return `test/${randomUUID()}/graph`;
}
