import { createHash } from 'node:crypto';

import type { RestDeps } from '../legacy/rest.ts';

/**
 * The few Cloud Storage JSON API calls the attachment copy (MIG-05) makes: object metadata, a
 * server-side `rewrite` (bucket to bucket, across projects, so the bytes never pass through the
 * machine running the tool), an upload of bytes the transform extracted, a media read of a copy
 * for its sha256 and scan, a metadata patch and a delete. 429s, 5xx and dropped connections are retried with backoff.
 */

export interface StoredObject {
  bucket: string;
  name: string;
  size: number;
  generation: string;
  contentType?: string;
  contentDisposition?: string;
  /** Base64, as Storage reports them. Composite objects have no MD5. */
  md5Hash?: string;
  crc32c?: string;
  metadata: Record<string, string>;
}

export interface ObjectRef {
  bucket: string;
  name: string;
  /** For a source: copy exactly this generation (the one the export listed). */
  generation?: string;
}

/** The destination's metadata on a copy. It replaces the source's, download tokens included. */
export interface ObjectResource {
  contentType: string;
  contentDisposition?: string;
  metadata: Record<string, string>;
}

export interface ObjectStore {
  /** The object's metadata, or null when it doesn't exist. */
  stat(bucket: string, name: string): Promise<StoredObject | null>;
  /** Every object whose name starts with `prefix`, metadata included (the rollback's, MIG-06). */
  list(bucket: string, prefix: string): Promise<StoredObject[]>;
  /** Copies `from` to `to` on the server; null when the source (or its generation) is gone. */
  rewrite(from: ObjectRef, to: Omit<ObjectRef, 'generation'>, resource: ObjectResource): Promise<StoredObject | null>;
  /** The object's bytes; throws if it holds more than `maxBytes`. */
  read(bucket: string, name: string, maxBytes: number): Promise<Buffer>;
  /** Stores `bytes` as a new object (bytes the transform extracted, MIG-03). */
  upload(bucket: string, name: string, bytes: Buffer, resource: ObjectResource): Promise<StoredObject>;
  /** Merges `metadata` into the object's custom metadata. */
  patchMetadata(bucket: string, name: string, metadata: Record<string, string>): Promise<StoredObject>;
  /** Deletes the object (only that generation, when given). Gone already is fine. */
  remove(bucket: string, name: string, generation?: string): Promise<void>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

interface GcsObjectJson {
  bucket?: string;
  name?: string;
  size?: string;
  generation?: string;
  contentType?: string;
  contentDisposition?: string;
  md5Hash?: string;
  crc32c?: string;
  metadata?: Record<string, string>;
}

function toStored(json: GcsObjectJson, fallback: { bucket: string; name: string }): StoredObject {
  return {
    bucket: json.bucket ?? fallback.bucket,
    name: json.name ?? fallback.name,
    size: Number(json.size ?? 0),
    generation: String(json.generation ?? ''),
    ...(json.contentType ? { contentType: json.contentType } : {}),
    ...(json.contentDisposition ? { contentDisposition: json.contentDisposition } : {}),
    ...(json.md5Hash ? { md5Hash: json.md5Hash } : {}),
    ...(json.crc32c ? { crc32c: json.crc32c } : {}),
    metadata: { ...(json.metadata ?? {}) },
  };
}

export interface GcsStoreOptions {
  /** Storage JSON API root: `https://storage.googleapis.com/storage/v1`, or the emulator's. */
  storage: string;
  /** Waits between retries; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

export function gcsStore(deps: RestDeps, options: GcsStoreOptions): ObjectStore {
  const { storage } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  // Uploads have their own root (`/upload/storage/v1`), on the emulator too.
  const upload = `${storage.replace(/\/storage\/v1$/, '')}/upload/storage/v1`;
  const objectUrl = (bucket: string, name: string) =>
    `${storage}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`;

  async function send(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await deps.token()}`);
    let res: Response;
    try {
      res = await deps.fetch(url, { ...init, headers });
    } catch (err) {
      throw new StorageError(`Storage request failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    if (res.status === 429 || res.status >= 500) {
      throw new StorageError(`Storage returned ${res.status}: ${(await res.text()).slice(0, 300)}`, true);
    }
    return res;
  }

  /** `fn`, again after 1, 2, 4 and 8 seconds when it fails in a way that can pass. */
  async function retrying<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof StorageError) || !err.retryable || attempt >= 4) throw err;
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  const failed = async (what: string, res: Response) =>
    new StorageError(`${what}: ${res.status} ${(await res.text()).slice(0, 300)}`, false);

  return {
    async stat(bucket, name) {
      return retrying(async () => {
        const res = await send(objectUrl(bucket, name), { method: 'GET' });
        if (res.status === 404) return null;
        if (!res.ok) throw await failed(`Reading the metadata of gs://${bucket}/${name}`, res);
        return toStored((await res.json()) as GcsObjectJson, { bucket, name });
      });
    },

    async list(bucket, prefix) {
      const found: StoredObject[] = [];
      let pageToken: string | undefined;
      do {
        const query = new URLSearchParams({ prefix, ...(pageToken ? { pageToken } : {}) });
        const body = await retrying(async () => {
          const res = await send(`${storage}/b/${encodeURIComponent(bucket)}/o?${query}`, { method: 'GET' });
          if (!res.ok) throw await failed(`Listing gs://${bucket}/${prefix}`, res);
          return (await res.json()) as { items?: GcsObjectJson[]; nextPageToken?: string };
        });
        found.push(...(body.items ?? []).map((item) => toStored(item, { bucket, name: item.name ?? '' })));
        pageToken = body.nextPageToken;
      } while (pageToken);
      return found;
    },

    async rewrite(from, to, resource) {
      let token: string | undefined;
      // A big object, or one moving between locations or storage classes, takes several calls.
      for (;;) {
        const query = new URLSearchParams({
          ...(from.generation ? { sourceGeneration: from.generation } : {}),
          ...(token ? { rewriteToken: token } : {}),
        });
        const url = `${objectUrl(from.bucket, from.name)}/rewriteTo/b/${encodeURIComponent(to.bucket)}/o/${encodeURIComponent(to.name)}${query.size ? `?${query}` : ''}`;
        const body = await retrying(async () => {
          const res = await send(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(resource),
          });
          if (res.status === 404) return null;
          if (!res.ok) throw await failed(`Copying to gs://${to.bucket}/${to.name}`, res);
          return (await res.json()) as { done?: boolean; rewriteToken?: string; resource?: GcsObjectJson };
        });
        if (!body) return null;
        if (body.done && body.resource) return toStored(body.resource, to);
        if (!body.rewriteToken) throw new StorageError(`Copying to gs://${to.bucket}/${to.name}: no progress.`, false);
        token = body.rewriteToken;
      }
    },

    async read(bucket, name, maxBytes) {
      return retrying(async () => {
        const res = await send(`${objectUrl(bucket, name)}?alt=media`, { method: 'GET' });
        if (!res.ok) throw await failed(`Reading gs://${bucket}/${name}`, res);
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > maxBytes) throw new StorageError(`gs://${bucket}/${name} is over ${maxBytes} bytes.`, false);
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length > maxBytes) throw new StorageError(`gs://${bucket}/${name} is over ${maxBytes} bytes.`, false);
        return bytes;
      });
    },

    async upload(bucket, name, bytes, resource) {
      // A multipart upload: the object's resource, then its bytes, in one request.
      const boundary = `materia-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`;
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, ...resource })}\r\n` +
            `--${boundary}\r\ncontent-type: ${resource.contentType}\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      return retrying(async () => {
        const res = await send(`${upload}/b/${encodeURIComponent(bucket)}/o?uploadType=multipart`, {
          method: 'POST',
          headers: { 'content-type': `multipart/related; boundary=${boundary}` },
          body,
        });
        if (!res.ok) throw await failed(`Uploading gs://${bucket}/${name}`, res);
        return toStored((await res.json()) as GcsObjectJson, { bucket, name });
      });
    },

    async patchMetadata(bucket, name, metadata) {
      return retrying(async () => {
        const res = await send(objectUrl(bucket, name), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ metadata }),
        });
        if (!res.ok) throw await failed(`Updating the metadata of gs://${bucket}/${name}`, res);
        return toStored((await res.json()) as GcsObjectJson, { bucket, name });
      });
    },

    async remove(bucket, name, generation) {
      await retrying(async () => {
        const query = generation ? `?ifGenerationMatch=${encodeURIComponent(generation)}` : '';
        const res = await send(`${objectUrl(bucket, name)}${query}`, { method: 'DELETE' });
        if (res.ok || res.status === 404) return;
        throw await failed(`Deleting gs://${bucket}/${name}`, res);
      });
    },
  };
}
