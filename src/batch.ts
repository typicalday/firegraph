import { computeEdgeDocId, computeNodeDocId } from './docid.js';
import type { BatchBackend, WritableRecord } from './internal/backend.js';
import { NODE_RELATION } from './internal/constants.js';
import { assertNoDeleteSentinels, flattenPatch } from './internal/write-plan.js';
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
    this.writeNode(aType, uid, data, 'merge');
  }

  async putEdge(
    aType: string,
    aUid: string,
    axbType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    this.writeEdge(aType, aUid, axbType, bType, bUid, data, 'merge');
  }

  async replaceNode(aType: string, uid: string, data: Record<string, unknown>): Promise<void> {
    this.writeNode(aType, uid, data, 'replace');
  }

  async replaceEdge(
    aType: string,
    aUid: string,
    axbType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    this.writeEdge(aType, aUid, axbType, bType, bUid, data, 'replace');
  }

  private writeNode(
    aType: string,
    uid: string,
    data: Record<string, unknown>,
    mode: 'merge' | 'replace',
  ): void {
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
    this.backend.setDoc(docId, record, mode);
  }

  private writeEdge(
    aType: string,
    aUid: string,
    axbType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
    mode: 'merge' | 'replace',
  ): void {
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
    this.backend.setDoc(docId, record, mode);
  }

  async updateNode(uid: string, data: Record<string, unknown>): Promise<void> {
    const docId = computeNodeDocId(uid);
    this.backend.updateDoc(docId, { dataOps: flattenPatch(data) });
  }

  async updateEdge(
    aUid: string,
    axbType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    this.backend.updateDoc(docId, { dataOps: flattenPatch(data) });
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
