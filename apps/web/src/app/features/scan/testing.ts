import type { QueuedScan, ScanStore } from './scan-db';
import { type Quad, WHOLE_PHOTO } from './scan-image';
import type { ScannedPage, ScanProcessor } from './scan-processor';

/** Test helpers for scanning (MOB-05). Every document is fictional. */

/** A 12 × 16 colour JPEG (a light page with two dark lines), as a browser's canvas encodes it. */
export const TINY_JPEG = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQAAwDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABQQH/8QAJRAAAAMIAgIDAAAAAAAAAAAAARESAAIDBAUTFBUiMhZBBiGB/8QAFAEBAAAAAAAAAAAAAAAAAAAAAv/EABURAQEAAAAAAAAAAAAAAAAAAAAB/9oADAMBAAIRAxEAPwDaK957to+g8X1nGzm5F7qClI49jIvRM/QdpqYG/wALZ8r2Euz2FKV8upGfs2nn/jFAqM3EmqhQ6XNTMQlxo8pDffeIAADeEDH6AA/GYYWk/9k=',
  ),
  (c) => c.charCodeAt(0),
);

/** A found page's corners in the fake photos: a page lying a little skewed. */
export const FOUND: Quad = [
  { x: 0.1, y: 0.08 },
  { x: 0.88, y: 0.1 },
  { x: 0.9, y: 0.92 },
  { x: 0.08, y: 0.9 },
];

/**
 * The page a photo makes: the tiny JPEG with the photo's name after its end marker, so the PDF's
 * order can be read back (`pageOrder`). A photo named `plain…` has no edges to find.
 */
export function fakePage(name: string, quad?: Quad): ScannedPage {
  const marker = new TextEncoder().encode(`[page:${name}]`);
  const bytes = new Uint8Array(TINY_JPEG.length + marker.length);
  bytes.set(TINY_JPEG);
  bytes.set(marker, TINY_JPEG.length);
  const jpeg = new Blob([bytes], { type: 'image/jpeg' });
  const found = quad ?? (name.startsWith('plain') ? null : FOUND);
  const photo = new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });
  return {
    jpeg,
    thumb: Object.assign(new Blob([name], { type: 'image/jpeg' }), { scanName: name }),
    width: 12,
    height: 16,
    quad: found ?? WHOLE_PHOTO,
    found: !!found,
    photo,
    photoWidth: 1200,
    photoHeight: 1600,
  };
}

/** A Blob's bytes (jsdom's Blob has no `arrayBuffer`). */
export function readBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** The photo names in a PDF's bytes, in page order. */
export function pageOrder(pdf: Uint8Array): string[] {
  const text = new TextDecoder('latin1').decode(pdf);
  return [...text.matchAll(/\[page:([^\]]+)\]/g)].map((match) => match[1] as string);
}

export interface FakeProcessor extends ScanProcessor {
  calls: { name: string; quad?: Quad | undefined }[];
  greyed: number;
  /** Photos with these names can't be read. */
  unreadable: Set<string>;
}

/** Makes pages instantly from `File`s by name (see `fakePage`). */
export function fakeProcessor(): FakeProcessor {
  const processor: FakeProcessor = {
    calls: [],
    greyed: 0,
    unreadable: new Set(),
    async process(photo, options = {}) {
      const name = (photo as File).name ?? 'photo';
      processor.calls.push({ name, quad: options.quad });
      if (processor.unreadable.has(name)) {
        const { ScanError } = await import('./scan-processor');
        throw new ScanError(
          'This photo can’t be read here. Take it again with the camera, or save it as a JPEG first.',
        );
      }
      return fakePage(name, options.quad);
    },
    async grayscale(jpeg) {
      processor.greyed++;
      return jpeg;
    },
  };
  return processor;
}

/** Scans kept in memory, optionally refusing to keep them (a browser with no IndexedDB). */
export function memoryScanStore(options: { refuse?: boolean } = {}): ScanStore & { scans: Map<string, QueuedScan> } {
  const scans = new Map<string, QueuedScan>();
  return {
    scans,
    list: async () => [...scans.values()].sort((a, b) => a.savedAt - b.savedAt),
    put: async (scan) => {
      if (options.refuse) throw new Error('No IndexedDB');
      scans.set(scan.id, scan);
    },
    delete: async (id) => void scans.delete(id),
  };
}

/** `URL.createObjectURL` for jsdom (which has none): `blob:n`, remembering each URL's Blob. */
export function stubObjectUrls(): { blobs: Map<string, Blob>; restore: () => void } {
  const blobs = new Map<string, Blob>();
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  let next = 0;
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    const url = `blob:test/${++next}`;
    blobs.set(url, blob as Blob);
    return url;
  };
  URL.revokeObjectURL = (url: string) => void blobs.delete(url);
  return {
    blobs,
    restore: () => {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    },
  };
}

/**
 * Just enough IndexedDB for the scan queue (jsdom has none): databases with object stores keyed by
 * `keyPath`, getAll, put and delete, each answered on a later microtask as a browser would.
 */
export function fakeIndexedDb(): IDBFactory & { stores: Map<string, Map<string, Map<string, unknown>>> } {
  const stores = new Map<string, Map<string, Map<string, unknown>>>();
  const later = (run: () => void) => queueMicrotask(run);
  const request = <T>(result: () => T) => {
    const req = {} as IDBRequest<T> & { result: T };
    later(() => {
      Object.defineProperty(req, 'result', { value: result(), configurable: true });
    });
    return req;
  };
  const database = (name: string) => {
    const db = stores.get(name) ?? new Map<string, Map<string, unknown>>();
    return {
      onversionchange: null,
      close: () => undefined,
      createObjectStore: (store: string) => db.set(store, new Map()),
      transaction: (store: string) => {
        const records = db.get(store) ?? new Map<string, unknown>();
        const transaction = {} as IDBTransaction;
        const objectStore = {
          getAll: () => request(() => [...records.values()]),
          put: (value: { id: string }) => request(() => (records.set(value.id, { ...value }), value.id)),
          delete: (key: string) => request(() => void records.delete(key)),
        };
        Object.assign(transaction, { objectStore: () => objectStore });
        later(() => later(() => transaction.oncomplete?.({} as Event)));
        return transaction;
      },
    };
  };
  const factory = {
    stores,
    databases: async () => [...stores.keys()].map((name) => ({ name, version: 1 })),
    open: (name: string) => {
      const req = {} as IDBOpenDBRequest;
      later(() => {
        const created = !stores.has(name);
        if (created) stores.set(name, new Map());
        Object.defineProperty(req, 'result', { value: database(name), configurable: true });
        if (created) req.onupgradeneeded?.({} as IDBVersionChangeEvent);
        req.onsuccess?.({} as Event);
      });
      return req;
    },
    deleteDatabase: (name: string) => {
      const req = {} as IDBOpenDBRequest;
      later(() => {
        stores.delete(name);
        req.onsuccess?.({} as Event);
      });
      return req;
    },
  };
  return factory as unknown as IDBFactory & { stores: Map<string, Map<string, Map<string, unknown>>> };
}
