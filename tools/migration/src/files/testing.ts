import { createHash } from 'node:crypto';

import type { ObjectStore, StoredObject } from './gcs.ts';

/**
 * Cloud Storage in memory, for the copy's tests: objects with generations, MD5s and a stand-in
 * CRC32C, a rewrite that replaces metadata as GCS does (source generations checked), and a log
 * of every call so tests can see what was copied and deleted.
 */
export function memoryStore() {
  const objects = new Map<string, StoredObject & { data: Buffer }>();
  const calls: { op: string; bucket: string; name: string; from?: string }[] = [];
  let generation = 1000;
  const key = (bucket: string, name: string) => `${bucket}/${name}`;
  /** An object's facts without its bytes. */
  const facts = (object: StoredObject & { data: Buffer }): StoredObject => ({
    ...(Object.fromEntries(Object.entries(object).filter(([field]) => field !== 'data')) as unknown as StoredObject),
    metadata: { ...object.metadata },
  });

  function put(
    bucket: string,
    name: string,
    data: Buffer,
    options: { contentType?: string; metadata?: Record<string, string>; contentDisposition?: string } = {},
  ): StoredObject {
    const object = {
      bucket,
      name,
      size: data.length,
      generation: String(generation++),
      md5Hash: createHash('md5').update(data).digest('base64'),
      crc32c: createHash('sha1').update(data).digest('base64').slice(0, 8),
      ...(options.contentType ? { contentType: options.contentType } : {}),
      ...(options.contentDisposition ? { contentDisposition: options.contentDisposition } : {}),
      metadata: { ...(options.metadata ?? {}) },
      data,
    };
    objects.set(key(bucket, name), object);
    return facts(object);
  }

  const store: ObjectStore = {
    async stat(bucket, name) {
      calls.push({ op: 'stat', bucket, name });
      const object = objects.get(key(bucket, name));
      return object ? facts(object) : null;
    },
    async rewrite(from, to, resource) {
      calls.push({ op: 'rewrite', bucket: to.bucket, name: to.name, from: key(from.bucket, from.name) });
      const source = objects.get(key(from.bucket, from.name));
      if (!source || (from.generation && source.generation !== from.generation)) return null;
      return put(to.bucket, to.name, source.data, resource);
    },
    async read(bucket, name, maxBytes) {
      calls.push({ op: 'read', bucket, name });
      const object = objects.get(key(bucket, name));
      if (!object) throw new Error(`No gs://${bucket}/${name}`);
      if (object.data.length > maxBytes) throw new Error('too big');
      return object.data;
    },
    async upload(bucket, name, bytes, resource) {
      calls.push({ op: 'upload', bucket, name });
      return put(bucket, name, bytes, resource);
    },
    async patchMetadata(bucket, name, metadata) {
      calls.push({ op: 'patch', bucket, name });
      const object = objects.get(key(bucket, name));
      if (!object) throw new Error(`No gs://${bucket}/${name}`);
      object.metadata = { ...object.metadata, ...metadata };
      return facts(object);
    },
    async remove(bucket, name, gen) {
      calls.push({ op: 'remove', bucket, name });
      const object = objects.get(key(bucket, name));
      if (object && (!gen || object.generation === gen)) objects.delete(key(bucket, name));
    },
  };

  return {
    store,
    calls,
    put,
    get: (bucket: string, name: string) => objects.get(key(bucket, name)) ?? null,
    names: (bucket: string) =>
      [...objects.values()]
        .filter((object) => object.bucket === bucket)
        .map((object) => object.name)
        .sort(),
  };
}
