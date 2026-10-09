import type { DocumentCategory } from '../documents/documents-view';

/**
 * The phone's queue of finished scans (MOB-05) in IndexedDB, with no Angular in it, so sign-out
 * (and its warning) can delete or count waiting scans without loading the Scan screen.
 */

/** A finished scan waiting on this device to reach Materia (MOB-05). */
export interface QueuedScan {
  id: string;
  /** Whose scan it is: only they upload it, in that org. */
  orgId: string;
  uid: string;
  matterId: string;
  /** The matter's number and title when it was saved, for the waiting list. */
  matterLabel: string;
  /** The document's name, ending .pdf. */
  fileName: string;
  category?: DocumentCategory;
  privileged?: boolean;
  pages: number;
  /**
   * The PDF's bytes, as an ArrayBuffer: WebKit won't store a Blob in IndexedDB in a private
   * session (Playwright's WebKit runs one). Scans saved by earlier versions hold a Blob.
   */
  pdf: ArrayBuffer | Blob;
  /** When it was saved (ms). */
  savedAt: number;
}

/** Where scans wait. IndexedDB in the browser; tests keep them in memory. */
export interface ScanStore {
  list(): Promise<QueuedScan[]>;
  put(scan: QueuedScan): Promise<void>;
  delete(id: string): Promise<void>;
}

/** The IndexedDB database the queue lives in; sign-out deletes it. */
export const SCAN_QUEUE_DB = 'materia-scans';
const STORE = 'scans';

/** The queue in IndexedDB, so a scan saved offline survives closing the app. */
export function indexedDbScanStore(idb: IDBFactory | undefined = globalThis.indexedDB): ScanStore {
  let opened: Promise<IDBDatabase> | undefined;
  const open = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (!idb) return reject(new Error('This browser can’t keep scans offline'));
      const request = idb.open(SCAN_QUEUE_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
      request.onsuccess = () => {
        const db = request.result;
        // Sign-out deletes the database: let it.
        db.onversionchange = () => {
          db.close();
          opened = undefined;
        };
        resolve(db);
      };
      request.onerror = () => {
        opened = undefined;
        reject(request.error);
      };
    }));
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  };
  return {
    list: async () =>
      ((await run('readonly', (store) => store.getAll())) as QueuedScan[]).sort((a, b) => a.savedAt - b.savedAt),
    put: async (scan) => void (await run('readwrite', (store) => store.put(scan))),
    delete: async (id) => void (await run('readwrite', (store) => store.delete(id))),
  };
}

/**
 * Whether any scan waits on this device, without creating the database when there is none (for
 * starting the queue after a reload).
 */
export async function anyScansWaiting(idb: IDBFactory | undefined = globalThis.indexedDB): Promise<boolean> {
  if (!idb) return false;
  try {
    if (typeof idb.databases === 'function') {
      const names = (await idb.databases()).map((db) => db.name);
      if (!names.includes(SCAN_QUEUE_DB)) return false;
    }
    return (await indexedDbScanStore(idb).list()).length > 0;
  } catch {
    return false;
  }
}

/** How many scans wait for this person, without loading the queue (for the sign-out warning). */
export async function waitingScans(uid: string, idb: IDBFactory | undefined = globalThis.indexedDB): Promise<number> {
  try {
    if (!(await anyScansWaiting(idb))) return 0;
    return (await indexedDbScanStore(idb).list()).filter((scan) => scan.uid === uid).length;
  } catch {
    return 0;
  }
}

/** Deletes every waiting scan on this device (sign-out). */
export function deleteScanQueue(idb: IDBFactory | undefined = globalThis.indexedDB): Promise<void> {
  return new Promise((resolve) => {
    if (!idb) return resolve();
    const request = idb.deleteDatabase(SCAN_QUEUE_DB);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}
