import type { FieldPath, Firestore, Query, Transaction } from '@google-cloud/firestore';

import type { QueryFilter, QueryOptions, StoredGraphRecord } from '../types.js';

/**
 * Variadic argument tuple for Firestore's
 * `update(field, value, …moreFieldsAndValues)` overload. Built by
 * `buildFirestoreUpdateArgs` (`./firestore-update.ts`); deep-merge ops use
 * `FieldPath` segments so exotic object keys address literal keys rather
 * than being reparsed as dotted paths.
 */
export type FirestoreUpdateArgs = [string | FieldPath, unknown, ...unknown[]];

export interface FirestoreAdapter {
  collectionPath: string;
  getDoc(docId: string): Promise<StoredGraphRecord | null>;
  setDoc(
    docId: string,
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ): Promise<void>;
  updateDoc(docId: string, args: FirestoreUpdateArgs): Promise<void>;
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

    async setDoc(
      docId: string,
      data: Record<string, unknown>,
      options?: { merge?: boolean },
    ): Promise<void> {
      if (options?.merge) {
        await collectionRef.doc(docId).set(data, { merge: true });
      } else {
        await collectionRef.doc(docId).set(data);
      }
    },

    async updateDoc(docId: string, args: FirestoreUpdateArgs): Promise<void> {
      await collectionRef.doc(docId).update(...args);
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
  setDoc(docId: string, data: Record<string, unknown>, options?: { merge?: boolean }): void;
  updateDoc(docId: string, args: FirestoreUpdateArgs): void;
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

    setDoc(docId: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
      if (options?.merge) {
        tx.set(collectionRef.doc(docId), data, { merge: true });
      } else {
        tx.set(collectionRef.doc(docId), data);
      }
    },

    updateDoc(docId: string, args: FirestoreUpdateArgs): void {
      tx.update(collectionRef.doc(docId), ...args);
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
  setDoc(docId: string, data: Record<string, unknown>, options?: { merge?: boolean }): void;
  updateDoc(docId: string, args: FirestoreUpdateArgs): void;
  deleteDoc(docId: string): void;
  commit(): Promise<void>;
}

export function createBatchAdapter(db: Firestore, collectionPath: string): BatchAdapter {
  const collectionRef = db.collection(collectionPath);
  const batch = db.batch();

  return {
    setDoc(docId: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
      if (options?.merge) {
        batch.set(collectionRef.doc(docId), data, { merge: true });
      } else {
        batch.set(collectionRef.doc(docId), data);
      }
    },

    updateDoc(docId: string, args: FirestoreUpdateArgs): void {
      batch.update(collectionRef.doc(docId), ...args);
    },

    deleteDoc(docId: string): void {
      batch.delete(collectionRef.doc(docId));
    },

    async commit(): Promise<void> {
      await batch.commit();
    },
  };
}
