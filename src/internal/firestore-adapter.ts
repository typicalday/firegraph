import type { Firestore, Query, Transaction } from '@google-cloud/firestore';

import type { QueryFilter, QueryOptions, StoredGraphRecord } from '../types.js';

export interface FirestoreAdapter {
  collectionPath: string;
  getDoc(docId: string): Promise<StoredGraphRecord | null>;
  setDoc(docId: string, data: Record<string, unknown>): Promise<void>;
  updateDoc(docId: string, data: Record<string, unknown>): Promise<void>;
  deleteDoc(docId: string): Promise<void>;
  query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]>;
}

export function createFirestoreAdapter(db: Firestore, collectionPath: string): FirestoreAdapter {
  const collectionRef = db.collection(collectionPath);

  return {
    collectionPath,

    async getDoc(docId: string): Promise<StoredGraphRecord | null> {
      const snap = await collectionRef.doc(docId).get();
      if (!snap.exists) return null;
      return snap.data() as StoredGraphRecord;
    },

    async setDoc(docId: string, data: Record<string, unknown>): Promise<void> {
      await collectionRef.doc(docId).set(data);
    },

    async updateDoc(docId: string, data: Record<string, unknown>): Promise<void> {
      await collectionRef.doc(docId).update(data);
    },

    async deleteDoc(docId: string): Promise<void> {
      await collectionRef.doc(docId).delete();
    },

    async query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]> {
      let q: Query = collectionRef;
      for (const f of filters) {
        q = q.where(f.field, f.op, f.value);
      }
      if (options?.orderBy) {
        q = q.orderBy(options.orderBy.field, options.orderBy.direction ?? 'asc');
      }
      if (options?.limit !== undefined) {
        q = q.limit(options.limit);
      }
      const snap = await q.get();
      return snap.docs.map((doc) => doc.data() as StoredGraphRecord);
    },
  };
}

export interface TransactionAdapter {
  getDoc(docId: string): Promise<StoredGraphRecord | null>;
  setDoc(docId: string, data: Record<string, unknown>): void;
  updateDoc(docId: string, data: Record<string, unknown>): void;
  deleteDoc(docId: string): void;
  query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]>;
}

export function createTransactionAdapter(
  db: Firestore,
  collectionPath: string,
  tx: Transaction,
): TransactionAdapter {
  const collectionRef = db.collection(collectionPath);

  return {
    async getDoc(docId: string): Promise<StoredGraphRecord | null> {
      const snap = await tx.get(collectionRef.doc(docId));
      if (!snap.exists) return null;
      return snap.data() as StoredGraphRecord;
    },

    setDoc(docId: string, data: Record<string, unknown>): void {
      tx.set(collectionRef.doc(docId), data);
    },

    updateDoc(docId: string, data: Record<string, unknown>): void {
      tx.update(collectionRef.doc(docId), data);
    },

    deleteDoc(docId: string): void {
      tx.delete(collectionRef.doc(docId));
    },

    async query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]> {
      let q: Query = collectionRef;
      for (const f of filters) {
        q = q.where(f.field, f.op, f.value);
      }
      if (options?.orderBy) {
        q = q.orderBy(options.orderBy.field, options.orderBy.direction ?? 'asc');
      }
      if (options?.limit !== undefined) {
        q = q.limit(options.limit);
      }
      const snap = await tx.get(q);
      return snap.docs.map((doc) => doc.data() as StoredGraphRecord);
    },
  };
}

export interface BatchAdapter {
  setDoc(docId: string, data: Record<string, unknown>): void;
  updateDoc(docId: string, data: Record<string, unknown>): void;
  deleteDoc(docId: string): void;
  commit(): Promise<void>;
}

export function createBatchAdapter(db: Firestore, collectionPath: string): BatchAdapter {
  const collectionRef = db.collection(collectionPath);
  const batch = db.batch();

  return {
    setDoc(docId: string, data: Record<string, unknown>): void {
      batch.set(collectionRef.doc(docId), data);
    },

    updateDoc(docId: string, data: Record<string, unknown>): void {
      batch.update(collectionRef.doc(docId), data);
    },

    deleteDoc(docId: string): void {
      batch.delete(collectionRef.doc(docId));
    },

    async commit(): Promise<void> {
      await batch.commit();
    },
  };
}
