import { computeEdgeDocId, computeNodeDocId } from './docid.js';
import { QuerySafetyError } from './errors.js';
import type { TransactionBackend, WritableRecord } from './internal/backend.js';
import { NODE_RELATION } from './internal/constants.js';
import { assertNoDeleteSentinels, flattenPatch } from './internal/write-plan.js';
import { migrateRecord, migrateRecords } from './migration.js';
import { buildEdgeQueryPlan, buildNodeQueryPlan } from './query.js';
import { analyzeQuerySafety } from './query-safety.js';
import type {
  FindEdgesParams,
  FindNodesParams,
  GraphRegistry,
  GraphTransaction,
  MigrationWriteBack,
  QueryFilter,
  ScanProtection,
  StoredGraphRecord,
} from './types.js';

function buildWritableNodeRecord(
  aType: string,
  uid: string,
  data: Record<string, unknown>,
): WritableRecord {
  return { aType, aUid: uid, axbType: NODE_RELATION, bType: aType, bUid: uid, data };
}

function buildWritableEdgeRecord(
  aType: string,
  aUid: string,
  axbType: string,
  bType: string,
  bUid: string,
  data: Record<string, unknown>,
): WritableRecord {
  return { aType, aUid, axbType, bType, bUid, data };
}

export class GraphTransactionImpl implements GraphTransaction {
  constructor(
    private readonly backend: TransactionBackend,
    private readonly registry?: GraphRegistry,
    private readonly scanProtection: ScanProtection = 'error',
    private readonly scopePath: string = '',
    private readonly globalWriteBack: MigrationWriteBack = 'off',
  ) {}

  async getNode(uid: string): Promise<StoredGraphRecord | null> {
    const docId = computeNodeDocId(uid);
    const record = await this.backend.getDoc(docId);
    if (!record || !this.registry) return record;
    const result = await migrateRecord(record, this.registry, this.globalWriteBack);
    if (result.migrated && result.writeBack !== 'off') {
      await this.backend.updateDoc(docId, {
        replaceData: result.record.data as Record<string, unknown>,
        v: result.record.v,
      });
    }
    return result.record;
  }

  async getEdge(aUid: string, axbType: string, bUid: string): Promise<StoredGraphRecord | null> {
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    const record = await this.backend.getDoc(docId);
    if (!record || !this.registry) return record;
    const result = await migrateRecord(record, this.registry, this.globalWriteBack);
    if (result.migrated && result.writeBack !== 'off') {
      await this.backend.updateDoc(docId, {
        replaceData: result.record.data as Record<string, unknown>,
        v: result.record.v,
      });
    }
    return result.record;
  }

  async edgeExists(aUid: string, axbType: string, bUid: string): Promise<boolean> {
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    const record = await this.backend.getDoc(docId);
    return record !== null;
  }

  private checkQuerySafety(filters: QueryFilter[], allowCollectionScan?: boolean): void {
    if (allowCollectionScan || this.scanProtection === 'off') return;

    const result = analyzeQuerySafety(filters);
    if (result.safe) return;

    if (this.scanProtection === 'error') {
      throw new QuerySafetyError(result.reason!);
    }

    console.warn(`[firegraph] Query safety warning: ${result.reason}`);
  }

  async findEdges(params: FindEdgesParams): Promise<StoredGraphRecord[]> {
    const plan = buildEdgeQueryPlan(params);
    let records: StoredGraphRecord[];
    if (plan.strategy === 'get') {
      const record = await this.backend.getDoc(plan.docId);
      records = record ? [record] : [];
    } else {
      this.checkQuerySafety(plan.filters, params.allowCollectionScan);
      records = await this.backend.query(plan.filters, plan.options);
    }
    return this.applyMigrations(records);
  }

  async findNodes(params: FindNodesParams): Promise<StoredGraphRecord[]> {
    const plan = buildNodeQueryPlan(params);
    let records: StoredGraphRecord[];
    if (plan.strategy === 'get') {
      const record = await this.backend.getDoc(plan.docId);
      records = record ? [record] : [];
    } else {
      this.checkQuerySafety(plan.filters, params.allowCollectionScan);
      records = await this.backend.query(plan.filters, plan.options);
    }
    return this.applyMigrations(records);
  }

  private async applyMigrations(records: StoredGraphRecord[]): Promise<StoredGraphRecord[]> {
    if (!this.registry || records.length === 0) return records;
    const results = await migrateRecords(records, this.registry, this.globalWriteBack);
    for (const result of results) {
      if (result.migrated && result.writeBack !== 'off') {
        const docId =
          result.record.axbType === NODE_RELATION
            ? computeNodeDocId(result.record.aUid)
            : computeEdgeDocId(result.record.aUid, result.record.axbType, result.record.bUid);
        await this.backend.updateDoc(docId, {
          replaceData: result.record.data as Record<string, unknown>,
          v: result.record.v,
        });
      }
    }
    return results.map((r) => r.record);
  }

  async putNode(aType: string, uid: string, data: Record<string, unknown>): Promise<void> {
    await this.writeNode(aType, uid, data, 'merge');
  }

  async putEdge(
    aType: string,
    aUid: string,
    axbType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.writeEdge(aType, aUid, axbType, bType, bUid, data, 'merge');
  }

  async replaceNode(aType: string, uid: string, data: Record<string, unknown>): Promise<void> {
    await this.writeNode(aType, uid, data, 'replace');
  }

  async replaceEdge(
    aType: string,
    aUid: string,
    axbType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.writeEdge(aType, aUid, axbType, bType, bUid, data, 'replace');
  }

  private async writeNode(
    aType: string,
    uid: string,
    data: Record<string, unknown>,
    mode: 'merge' | 'replace',
  ): Promise<void> {
    assertNoDeleteSentinels(data, mode === 'replace' ? 'replaceNode' : 'putNode');
    if (this.registry) {
      this.registry.validate(aType, NODE_RELATION, aType, data, this.scopePath);
    }
    const docId = computeNodeDocId(uid);
    const record = buildWritableNodeRecord(aType, uid, data);
    if (this.registry) {
      const entry = this.registry.lookup(aType, NODE_RELATION, aType);
      if (entry?.schemaVersion && entry.schemaVersion > 0) {
        record.v = entry.schemaVersion;
      }
    }
    await this.backend.setDoc(docId, record, mode);
  }

  private async writeEdge(
    aType: string,
    aUid: string,
    axbType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
    mode: 'merge' | 'replace',
  ): Promise<void> {
    assertNoDeleteSentinels(data, mode === 'replace' ? 'replaceEdge' : 'putEdge');
    if (this.registry) {
      this.registry.validate(aType, axbType, bType, data, this.scopePath);
    }
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    const record = buildWritableEdgeRecord(aType, aUid, axbType, bType, bUid, data);
    if (this.registry) {
      const entry = this.registry.lookup(aType, axbType, bType);
      if (entry?.schemaVersion && entry.schemaVersion > 0) {
        record.v = entry.schemaVersion;
      }
    }
    await this.backend.setDoc(docId, record, mode);
  }

  async updateNode(uid: string, data: Record<string, unknown>): Promise<void> {
    const docId = computeNodeDocId(uid);
    await this.backend.updateDoc(docId, { dataOps: flattenPatch(data) });
  }

  async updateEdge(
    aUid: string,
    axbType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    await this.backend.updateDoc(docId, { dataOps: flattenPatch(data) });
  }

  async removeNode(uid: string): Promise<void> {
    const docId = computeNodeDocId(uid);
    await this.backend.deleteDoc(docId);
  }

  async removeEdge(aUid: string, axbType: string, bUid: string): Promise<void> {
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    await this.backend.deleteDoc(docId);
  }
}
