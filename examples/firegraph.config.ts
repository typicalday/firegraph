import { defineConfig } from 'firegraph';

export default defineConfig({
  entities: './entities',

  // GCP project ID
  project: 'demo-firegraph',

  // Firestore collection path
  collection: 'graph',

  // Use the Firestore emulator
  emulator: '127.0.0.1:8188',

  // Editor-specific settings
  editor: {
    port: 3883,
    readonly: false,
  },
});
