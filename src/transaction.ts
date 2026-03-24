import { FieldValue } from '@google-cloud/firestore';
import type { Firestore } from '@google-cloud/firestore';
import { computeNodeDocId, computeEdgeDocId } from './docid.js';
import { buildNodeRecord, buildEdgeRecord } from './record.js';
import { buildEdgeQueryPlan, buildNodeQueryPlan } from './query.js';
import { NODE_RELATION } from './internal/constants.js';
import { QuerySafetyError } from './errors.js';
import { analyzeQuerySafety } from './query-safety.js';
import { deserializeFirestoreTypes } from './serialization.js';
import { migrateRecord, migrateRecords } from './migration.js';
import type { TransactionAdapter } from './internal/firestore-adapter.js';
import type {
  GraphTransaction,
  GraphRegistry,
  MigrationWriteBack,
  StoredGraphRecord,
  FindEdgesParams,
  FindNodesParams,
  ScanProtection,
  QueryFilter,
} from './types.js';

export class GraphTransactionImpl implements GraphTransaction {
  constructor(
    private readonly adapter: TransactionAdapter,
    private readonly registry?: GraphRegistry,
    private readonly scanProtection: ScanProtection = 'error',
    private readonly scopePath: string = '',
    private readonly globalWriteBack: MigrationWriteBack = 'off',
    private readonly db?: Firestore,
  ) {}

  async getNode(uid: string): Promise<StoredGraphRecord | null> {
    const docId = computeNodeDocId(uid);
    const record = await this.adapter.getDoc(docId);
    if (!record || !this.registry) return record;
    const result = await migrateRecord(record, this.registry, this.globalWriteBack);
    if (result.migrated && result.writeBack !== 'off') {
      const update: Record<string, unknown> = {
        data: deserializeFirestoreTypes(result.record.data as Record<string, unknown>, this.db),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (result.record.v !== undefined) {
        update.v = result.record.v;
      }
      this.adapter.updateDoc(docId, update);
    }
    return result.record;
  }

  async getEdge(aUid: string, axbType: string, bUid: string): Promise<StoredGraphRecord | null> {
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    const record = await this.adapter.getDoc(docId);
    if (!record || !this.registry) return record;
    const result = await migrateRecord(record, this.registry, this.globalWriteBack);
    if (result.migrated && result.writeBack !== 'off') {
      const update: Record<string, unknown> = {
        data: deserializeFirestoreTypes(result.record.data as Record<string, unknown>, this.db),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (result.record.v !== undefined) {
        update.v = result.record.v;
      }
      this.adapter.updateDoc(docId, update);
    }
    return result.record;
  }

  async edgeExists(aUid: string, axbType: string, bUid: string): Promise<boolean> {
    // Use raw getDoc to avoid migration overhead for existence checks
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    const record = await this.adapter.getDoc(docId);
    return record !== null;
  }

  private checkQuerySafety(filters: QueryFilter[], allowCollectionScan?: boolean): void {
    if (allowCollectionScan || this.scanProtection === 'off') return;

    const result = analyzeQuerySafety(filters);
    if (result.safe) return;

    if (this.scanProtection === 'error') {
      throw new QuerySafetyError(result.reason!);
    }

    // scanProtection === 'warn'
    console.warn(`[firegraph] Query safety warning: ${result.reason}`);
  }

  async findEdges(params: FindEdgesParams): Promise<StoredGraphRecord[]> {
    const plan = buildEdgeQueryPlan(params);
    let records: StoredGraphRecord[];
    if (plan.strategy === 'get') {
      const record = await this.adapter.getDoc(plan.docId);
      records = record ? [record] : [];
    } else {
      this.checkQuerySafety(plan.filters, params.allowCollectionScan);
      records = await this.adapter.query(plan.filters, plan.options);
    }
    return this.applyMigrations(records);
  }

  async findNodes(params: FindNodesParams): Promise<StoredGraphRecord[]> {
    const plan = buildNodeQueryPlan(params);
    let records: StoredGraphRecord[];
    if (plan.strategy === 'get') {
      const record = await this.adapter.getDoc(plan.docId);
      records = record ? [record] : [];
    } else {
      this.checkQuerySafety(plan.filters, params.allowCollectionScan);
      records = await this.adapter.query(plan.filters, plan.options);
    }
    return this.applyMigrations(records);
  }

  private async applyMigrations(records: StoredGraphRecord[]): Promise<StoredGraphRecord[]> {
    if (!this.registry || records.length === 0) return records;
    const results = await migrateRecords(records, this.registry, this.globalWriteBack);
    for (const result of results) {
      if (result.migrated && result.writeBack !== 'off') {
        const docId = result.record.axbType === NODE_RELATION
          ? computeNodeDocId(result.record.aUid)
          : computeEdgeDocId(result.record.aUid, result.record.axbType, result.record.bUid);
        const update: Record<string, unknown> = {
          data: deserializeFirestoreTypes(result.record.data as Record<string, unknown>, this.db),
          updatedAt: FieldValue.serverTimestamp(),
        };
        if (result.record.v !== undefined) {
          update.v = result.record.v;
        }
        this.adapter.updateDoc(docId, update);
      }
    }
    return results.map((r) => r.record);
  }

  async putNode(aType: string, uid: string, data: Record<string, unknown>): Promise<void> {
    if (this.registry) {
      this.registry.validate(aType, NODE_RELATION, aType, data, this.scopePath);
    }
    const docId = computeNodeDocId(uid);
    const record = buildNodeRecord(aType, uid, data);
    if (this.registry) {
      const entry = this.registry.lookup(aType, NODE_RELATION, aType);
      if (entry?.schemaVersion && entry.schemaVersion > 0) {
        (record as unknown as Record<string, unknown>).v = entry.schemaVersion;
      }
    }
    this.adapter.setDoc(docId, record as unknown as Record<string, unknown>);
  }

  async putEdge(
    aType: string,
    aUid: string,
    axbType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (this.registry) {
      this.registry.validate(aType, axbType, bType, data, this.scopePath);
    }
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    const record = buildEdgeRecord(aType, aUid, axbType, bType, bUid, data);
    if (this.registry) {
      const entry = this.registry.lookup(aType, axbType, bType);
      if (entry?.schemaVersion && entry.schemaVersion > 0) {
        (record as unknown as Record<string, unknown>).v = entry.schemaVersion;
      }
    }
    this.adapter.setDoc(docId, record as unknown as Record<string, unknown>);
  }

  async updateNode(uid: string, data: Record<string, unknown>): Promise<void> {
    const docId = computeNodeDocId(uid);
    const update: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };
    for (const [k, v] of Object.entries(data)) {
      update[`data.${k}`] = v;
    }
    this.adapter.updateDoc(docId, update);
  }

  async removeNode(uid: string): Promise<void> {
    const docId = computeNodeDocId(uid);
    this.adapter.deleteDoc(docId);
  }

  async removeEdge(aUid: string, axbType: string, bUid: string): Promise<void> {
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    this.adapter.deleteDoc(docId);
  }
}
