/**
 * Schema versioning & auto-migration
 *
 * Firegraph supports schema versioning with automatic migration of records on
 * read. The schema version is derived automatically as max(toVersion) from
 * the migrations array. When a record's stored version (`v`) is behind the
 * derived version, migration functions run automatically to bring data up to
 * the current version.
 *
 * This example demonstrates:
 * - Defining migrations in a static registry
 * - Automatic migration on read (lazy migration)
 * - Version stamping on writes
 * - Write-back modes (eager, background, off)
 * - Dynamic registry migrations (stored as source code strings)
 *
 * Run against the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx examples/12-schema-migrations.ts
 */
import { Firestore, Timestamp, GeoPoint } from '@google-cloud/firestore';
import {
  createGraphClient,
  createRegistry,
  generateId,
  SERIALIZATION_TAG,
} from '../src/index.js';
import type { MigrationStep } from '../src/types.js';

const db = new Firestore({ projectId: 'demo-firegraph' });

async function main() {
  // ═══════════════════════════════════════════════════════════════
  // 1. Write legacy data (no registry, no version)
  // ═══════════════════════════════════════════════════════════════

  const collPath = `examples/migrations/${Date.now()}`;
  const bare = createGraphClient(db, collPath);

  const tourId = generateId();
  await bare.putNode('tour', tourId, { title: 'Dolomites Classic' });
  console.log('Wrote legacy v0 tour:', tourId);

  // Verify: no version stamp on a bare client
  const legacy = await bare.getNode(tourId);
  console.log('  v:', legacy!.v);         // undefined
  console.log('  status:', legacy!.data.status); // undefined
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 2. Define migrations — a chain of transform functions
  // ═══════════════════════════════════════════════════════════════

  // Each MigrationStep transforms data from one version to the next.
  // They run sequentially: v0 -> v1 -> v2.
  const migrations: MigrationStep[] = [
    {
      fromVersion: 0,
      toVersion: 1,
      up: (d) => ({ ...d, status: d.status ?? 'draft' }),
    },
    {
      fromVersion: 1,
      toVersion: 2,
      up: (d) => ({ ...d, active: true }),
    },
  ];

  // Schema v2 reflects the fully migrated shape
  const tourSchemaV2 = {
    type: 'object',
    required: ['title'],
    properties: {
      title: { type: 'string' },
      status: { type: 'string' },
      active: { type: 'boolean' },
    },
    additionalProperties: false,
  };

  // ═══════════════════════════════════════════════════════════════
  // 3. Create a registry with versioning + migrations
  // ═══════════════════════════════════════════════════════════════

  const registry = createRegistry([
    {
      aType: 'tour',
      axbType: 'is',
      bType: 'tour',
      jsonSchema: tourSchemaV2,
      migrations,                    // version derived as max(toVersion) = 2
      migrationWriteBack: 'eager',   // persist migrated data back to Firestore
    },
  ]);

  const g = createGraphClient(db, collPath, { registry });

  // ═══════════════════════════════════════════════════════════════
  // 4. Read triggers automatic migration
  // ═══════════════════════════════════════════════════════════════

  const migrated = await g.getNode(tourId);
  console.log('After migration:');
  console.log('  v:', migrated!.v);              // 2
  console.log('  status:', migrated!.data.status); // 'draft' (added by v0->v1)
  console.log('  active:', migrated!.data.active); // true (added by v1->v2)
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 5. Write-back: migrated data is persisted to Firestore
  // ═══════════════════════════════════════════════════════════════

  // With 'eager' write-back, the migrated data is written back to Firestore
  // as a fire-and-forget operation. Wait briefly for it to complete.
  await new Promise((r) => setTimeout(r, 500));

  // Reading with the bare client now shows the updated data
  const persisted = await bare.getNode(tourId);
  console.log('After write-back (raw Firestore):');
  console.log('  v:', persisted!.v);              // 2
  console.log('  status:', persisted!.data.status); // 'draft'
  console.log('  active:', persisted!.data.active); // true
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 6. New writes are automatically stamped with the current version
  // ═══════════════════════════════════════════════════════════════

  const newTourId = generateId();
  await g.putNode('tour', newTourId, {
    title: 'Alps Explorer',
    status: 'published',
    active: true,
  });

  const newTour = await g.getNode(newTourId);
  console.log('New tour (written with registry):');
  console.log('  v:', newTour!.v); // 2 — stamped on write
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 7. Write-back in transactions
  // ═══════════════════════════════════════════════════════════════

  // Write another legacy record
  const tourId2 = generateId();
  await bare.putNode('tour', tourId2, { title: 'Pyrenees Challenge' });

  // Reading inside a transaction also triggers migration + write-back
  await g.runTransaction(async (tx) => {
    const node = await tx.getNode(tourId2);
    console.log('Transaction read:');
    console.log('  v:', node!.v);              // 2
    console.log('  status:', node!.data.status); // 'draft'
    // In transactions, write-back happens inline within the same transaction
  });

  // The write-back is committed with the transaction
  const txResult = await bare.getNode(tourId2);
  console.log('After transaction commit:');
  console.log('  v:', txResult!.v); // 2
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 8. Dynamic registry with stored migration strings
  // ═══════════════════════════════════════════════════════════════

  const dynCollPath = `examples/migrations-dynamic/${Date.now()}`;
  const dynClient = createGraphClient(db, dynCollPath, {
    registryMode: { mode: 'dynamic' },
  });

  // Migrations stored as source code strings (no imports allowed)
  // Version is derived automatically as max(toVersion) = 1
  await dynClient.defineNodeType(
    'task',
    {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        done: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    'A task entity',
    {
      migrations: [
        { fromVersion: 0, toVersion: 1, up: '(d) => ({ ...d, done: false })' },
      ],
    },
  );

  await dynClient.reloadRegistry();

  // Write legacy data and read it back
  const dynBare = createGraphClient(db, dynCollPath);
  const taskId = generateId();
  await dynBare.putNode('task', taskId, { name: 'Build feature' });

  const task = await dynClient.getNode(taskId);
  console.log('Dynamic migration:');
  console.log('  v:', task!.v);          // 1
  console.log('  done:', task!.data.done); // false (added by migration)

  // ═══════════════════════════════════════════════════════════════
  // 9. Firestore type preservation in dynamic migrations
  // ═══════════════════════════════════════════════════════════════

  // The default sandbox transparently preserves Firestore special types
  // (Timestamp, GeoPoint, VectorValue, DocumentReference) through the
  // JSON boundary via tagged serialization. Inside the sandbox, these
  // types appear as tagged plain objects that the migration can read
  // and modify.

  const eventCollPath = `examples/migrations-events/${Date.now()}`;
  const eventClient = createGraphClient(db, eventCollPath, {
    registryMode: { mode: 'dynamic' },
  });

  await eventClient.defineNodeType(
    'event',
    {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
      },
    },
    'An event with timestamps',
    {
      migrations: [
        {
          fromVersion: 0,
          toVersion: 1,
          // Migration can read tagged Timestamp values and create new ones.
          // Inside the sandbox: { __firegraph_ser__: 'Timestamp', seconds: N, nanoseconds: N }
          // After the sandbox: reconstructed into real Timestamp instances.
          up: `(d) => ({
            ...d,
            updatedAt: { ${JSON.stringify(SERIALIZATION_TAG)}: 'Timestamp', seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 }
          })`,
        },
      ],
    },
  );

  await eventClient.reloadRegistry();

  // Write a legacy event with a Timestamp using the bare client
  const eventBare = createGraphClient(db, eventCollPath);
  const eventId = generateId();
  await eventBare.putNode('event', eventId, {
    name: 'Conference',
    createdAt: new Timestamp(1700000000, 0),
    location: new GeoPoint(37.7749, -122.4194),
  });

  // Read through the dynamic client — migration runs, types are preserved
  const event = await eventClient.getNode(eventId);
  console.log('Firestore type preservation:');
  console.log('  name:', event!.data.name);             // 'Conference'
  console.log('  createdAt type:', event!.data.createdAt?.constructor?.name); // 'Timestamp'
  console.log('  location type:', event!.data.location?.constructor?.name);   // 'GeoPoint'
  console.log('  updatedAt type:', event!.data.updatedAt?.constructor?.name); // 'Timestamp' (added by migration)

  console.log();
  console.log('Done!');
}

main().catch(console.error);
