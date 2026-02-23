import { defineConfig } from 'firegraph';

export default defineConfig({
  // Path to entities directory (per-entity folder convention)
  entities: './entities',

  // Path to your views file (legacy, use per-entity views.ts instead)
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

  // Declarative view defaults — pick which view to show for each entity type.
  // Context-specific keys (listing, detail, inline) override the global default
  // based on where the view is rendered.
  viewDefaults: {
    nodes: {
      tour: {
        default: 'card',
        listing: 'card',      // compact card in browse listing
        detail: 'detail',     // full details on node page
        inline: 'card',       // compact card in edge rows
      },
      departure: {
        default: 'badge',
        listing: 'badge',
        detail: 'badge',
      },
    },
    edges: {
      hasDeparture: {
        default: 'timeline',
        inline: 'timeline',
      },
      hasRider: { default: 'card' },
    },
  },
});
