import { defineConfig } from 'firegraph';

export default defineConfig({
  // Path to your registry file (relative to this config file's directory)
  registry: './05-registry-validation.ts',

  // Path to your views file
  views: './07-model-views.ts',

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

  // Declarative view defaults — pick which view to show for each entity type
  viewDefaults: {
    nodes: {
      tour: {
        default: 'card',
        rules: [
          { when: { status: 'departed' }, view: 'detail' },
          { when: { status: 'completed' }, view: 'detail' },
        ],
      },
      departure: { default: 'badge' },
    },
    edges: {
      hasDeparture: {
        default: 'timeline',
        rules: [
          { when: { status: 'cancelled' }, view: 'timeline' },
        ],
      },
      hasRider: { default: 'card' },
    },
  },
});
