import { FieldValue } from '@google-cloud/firestore';
import { computeNodeDocId, computeEdgeDocId } from './docid.js';
import { buildNodeRecord, buildEdgeRecord } from './record.js';
import { NODE_RELATION } from './internal/constants.js';
import type { BatchAdapter } from './internal/firestore-adapter.js';
import type { GraphBatch, GraphRegistry } from './types.js';

export class GraphBatchImpl implements GraphBatch {
  constructor(
    private readonly adapter: BatchAdapter,
    private readonly registry?: GraphRegistry,
    private readonly scopePath: string = '',
  ) {}

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

  async commit(): Promise<void> {
    await this.adapter.commit();
  }
}
