import { computeEdgeDocId, computeNodeDocId } from './docid.js';
import type { BatchBackend, WritableRecord } from './internal/backend.js';
import { NODE_RELATION } from './internal/constants.js';
import type { GraphBatch, GraphRegistry } from './types.js';

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

export class GraphBatchImpl implements GraphBatch {
  constructor(
    private readonly backend: BatchBackend,
    private readonly registry?: GraphRegistry,
    private readonly scopePath: string = '',
  ) {}

  async putNode(aType: string, uid: string, data: Record<string, unknown>): Promise<void> {
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
    this.backend.setDoc(docId, record);
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
    const record = buildWritableEdgeRecord(aType, aUid, axbType, bType, bUid, data);
    if (this.registry) {
      const entry = this.registry.lookup(aType, axbType, bType);
      if (entry?.schemaVersion && entry.schemaVersion > 0) {
        record.v = entry.schemaVersion;
      }
    }
    this.backend.setDoc(docId, record);
  }

  async updateNode(uid: string, data: Record<string, unknown>): Promise<void> {
    const docId = computeNodeDocId(uid);
    this.backend.updateDoc(docId, { dataFields: data });
  }

  async removeNode(uid: string): Promise<void> {
    const docId = computeNodeDocId(uid);
    this.backend.deleteDoc(docId);
  }

  async removeEdge(aUid: string, axbType: string, bUid: string): Promise<void> {
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    this.backend.deleteDoc(docId);
  }

  async commit(): Promise<void> {
    await this.backend.commit();
  }
}
