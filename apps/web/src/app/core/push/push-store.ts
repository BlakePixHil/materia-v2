/**
 * This browser's push identity (MOB-04) in IndexedDB `materia-device`, with no Angular in it: a
 * random device id made once and kept (it names `users/{uid}/devices/{deviceId}`), and the
 * registration this browser made for the signed-in person. Sign-out forgets the registration but
 * keeps the id, so the same browser is the same device next time.
 */

/** What this browser registered, and when it last told Materia it's still here. */
export interface PushRegistrationRecord {
  uid: string;
  token: string;
  /** When the device's token and `lastSeenAt` were last written (ms). */
  refreshedAt: number;
}

export interface PushStore {
  deviceId(): Promise<string>;
  read(): Promise<PushRegistrationRecord | null>;
  save(record: PushRegistrationRecord): Promise<void>;
  clear(): Promise<void>;
}

export const PUSH_DEVICE_DB = 'materia-device';
const STORE = 'kv';
const DEVICE_ID = 'deviceId';
const REGISTRATION = 'registration';

/** A random id that fits the device rules (letters and digits). */
export function newDeviceId(random: Crypto | undefined = globalThis.crypto): string {
  const id = random?.randomUUID?.().replace(/-/g, '');
  return id ?? Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/** The store in IndexedDB. Where there's none (very old or locked-down browsers), push isn't offered. */
export function indexedDbPushStore(idb: IDBFactory | undefined = globalThis.indexedDB): PushStore {
  let opened: Promise<IDBDatabase> | undefined;
  const open = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (!idb) return reject(new Error('This browser can’t keep a device id'));
      const request = idb.open(PUSH_DEVICE_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
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
  let id: Promise<string> | undefined;
  return {
    deviceId: () =>
      (id ??= (async () => {
        const stored = await run('readonly', (store) => store.get(DEVICE_ID));
        if (typeof stored === 'string' && stored) return stored;
        const fresh = newDeviceId();
        await run('readwrite', (store) => store.put(fresh, DEVICE_ID));
        return fresh;
      })().catch((error: unknown) => {
        id = undefined;
        throw error;
      })),
    read: async () => {
      const record = (await run('readonly', (store) => store.get(REGISTRATION))) as PushRegistrationRecord | undefined;
      return record && typeof record.uid === 'string' && typeof record.token === 'string' ? record : null;
    },
    save: async (record) => void (await run('readwrite', (store) => store.put(record, REGISTRATION))),
    clear: async () => void (await run('readwrite', (store) => store.delete(REGISTRATION))),
  };
}
