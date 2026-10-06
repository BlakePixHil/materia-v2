import { createHash } from 'node:crypto';

import type { RestDeps } from '../legacy/rest.ts';

/**
 * Where an export run goes (MIG-02): `gs://materia-v2-<env>-migration/runs/{runId}/`, the v2
 * migration bucket (CMEK, uniform access, versioned; infra/terraform/modules/firebase_env). Files
 * stream up in resumable chunks, so a big file never sits whole in memory. The sink refuses any
 * other bucket, so it can never write to the legacy project.
 */

export interface RunFile {
  write(text: string): Promise<void>;
  close(): Promise<void>;
}

export interface RunSink {
  /** `gs://bucket/runs/{runId}/`, for logs and the manifest. */
  readonly location: string;
  /** A new file in the run. `once` fails if the file already exists. */
  create(name: string, contentType: string, { once }?: { once?: boolean }): Promise<RunFile>;
  /** A file of the run as text, or null when it doesn't exist. */
  read(name: string): Promise<string | null>;
}

/** The only buckets the export writes to. */
export const MIGRATION_BUCKET = /^materia-v2-(dev|prod)-migration$/;

export function assertMigrationBucket(bucket: string): void {
  if (!MIGRATION_BUCKET.test(bucket)) {
    throw new Error(`Refusing to write to gs://${bucket}: the export writes only to a materia-v2 migration bucket.`);
  }
}

/** GCS wants every chunk but the last to be a multiple of 256 KiB. */
const CHUNK_GRANULE = 256 * 1024;
const DEFAULT_CHUNK = 32 * CHUNK_GRANULE;

export interface GcsSinkOptions {
  bucket: string;
  runId: string;
  /** Storage JSON API root: `https://storage.googleapis.com/storage/v1`, or the emulator's. */
  storage: string;
  /** Bytes per upload request (a multiple of 256 KiB); 8 MiB by default. */
  chunkBytes?: number;
  /** Waits between retries; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

class UploadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** The bytes a 308 says GCS holds (`Range: bytes=0-N`), or `fallback` when it holds none yet. */
function heldBytes(res: Response, fallback: number): number {
  const range = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '');
  return range ? Number(range[1]) + 1 : fallback;
}

export function gcsSink(deps: RestDeps, options: GcsSinkOptions): RunSink {
  const { bucket, runId, storage, chunkBytes = DEFAULT_CHUNK } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  assertMigrationBucket(bucket);
  if (chunkBytes <= 0 || chunkBytes % CHUNK_GRANULE) throw new Error('chunkBytes must be a multiple of 256 KiB.');
  const upload = storage.replace(/\/storage\/v1$/, '/upload/storage/v1');
  const prefix = `runs/${runId}/`;
  const objectName = (name: string) => `${prefix}${name}`;

  async function send(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await deps.token()}`);
    let res: Response;
    try {
      res = await deps.fetch(url, { ...init, headers });
    } catch (err) {
      throw new UploadError(`Storage request failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    if (res.status === 429 || res.status >= 500) {
      throw new UploadError(`Storage returned ${res.status}: ${(await res.text()).slice(0, 300)}`, true);
    }
    return res;
  }

  /** `fn`, again after 1, 2 and 4 seconds when it fails in a way that can pass. */
  async function retrying<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof UploadError) || !err.retryable || attempt >= 3) throw err;
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  async function metadata(name: string): Promise<{ size?: string; md5Hash?: string }> {
    const res = await retrying(() =>
      send(`${storage}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName(name))}`, { method: 'GET' }),
    );
    if (!res.ok) throw new Error(`Reading the metadata of ${objectName(name)}: ${res.status}`);
    return (await res.json()) as { size?: string; md5Hash?: string };
  }

  return {
    location: `gs://${bucket}/${prefix}`,

    async create(name, contentType, { once = false } = {}) {
      const query = new URLSearchParams({
        uploadType: 'resumable',
        name: objectName(name),
        ...(once ? { ifGenerationMatch: '0' } : {}),
      });
      const session = await retrying(async () => {
        const res = await send(`${upload}/b/${encodeURIComponent(bucket)}/o?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-upload-content-type': contentType },
          body: JSON.stringify({ name: objectName(name), contentType }),
        });
        if (res.status === 412) throw new UploadError(`${objectName(name)} already exists in gs://${bucket}.`, false);
        const location = res.headers.get('location');
        if (!res.ok || !location) {
          throw new UploadError(
            `Starting the upload of ${objectName(name)}: ${res.status} ${(await res.text()).slice(0, 300)}`,
            false,
          );
        }
        return location;
      });

      const md5 = createHash('md5');
      let pending = Buffer.alloc(0);
      let offset = 0;

      /** Drops what GCS already holds from the front of `pending`. */
      const advance = (held: number) => {
        if (held <= offset) return;
        pending = pending.subarray(held - offset);
        offset = held;
      };

      /** How many bytes GCS holds after a failed chunk, or 'done' when the upload finished anyway. */
      const persisted = () =>
        retrying(async (): Promise<number | 'done'> => {
          const res = await send(session, { method: 'PUT', headers: { 'content-range': 'bytes */*' } });
          if (res.ok) return 'done';
          if (res.status !== 308) throw new UploadError(`Upload status of ${name}: ${res.status}`, false);
          return heldBytes(res, 0);
        });

      const verify = (object: { size?: string; md5Hash?: string }) => {
        if (Number(object.size) !== offset + pending.length) {
          throw new Error(`${name}: Storage holds ${object.size} bytes, not ${offset + pending.length}.`);
        }
        // Storage reports no MD5 for some encrypted objects; the size check still stands then.
        if (object.md5Hash && object.md5Hash !== md5.digest('base64')) {
          throw new Error(`${name}: the MD5 Storage computed doesn't match what was sent.`);
        }
      };

      /** Sends the next chunk: whole 256 KiB granules up to `chunkBytes`, or everything left when `last`. */
      async function flush(last: boolean): Promise<void> {
        for (let attempt = 0; ; attempt++) {
          const length = last
            ? pending.length
            : Math.min(chunkBytes, pending.length - (pending.length % CHUNK_GRANULE));
          if (!last && length === 0) return;
          const total = last ? String(offset + length) : '*';
          const range = length ? `bytes ${offset}-${offset + length - 1}/${total}` : `bytes */${total}`;
          let res: Response;
          try {
            res = await send(session, {
              method: 'PUT',
              headers: { 'content-range': range },
              body: pending.subarray(0, length),
            });
          } catch (err) {
            if (!(err instanceof UploadError) || !err.retryable || attempt >= 3) throw err;
            await sleep(1000 * 2 ** attempt);
            // Ask how much arrived, then resend the rest.
            const held = await persisted();
            if (held === 'done') {
              if (!last) throw new Error(`${name}: Storage finished the upload early.`, { cause: err });
              return verify(await metadata(name));
            }
            advance(held);
            continue;
          }
          if (last) {
            if (!res.ok)
              throw new UploadError(`Finishing ${name}: ${res.status} ${(await res.text()).slice(0, 300)}`, false);
            return verify((await res.json()) as { size?: string; md5Hash?: string });
          }
          if (res.status !== 308) {
            throw new UploadError(`Uploading ${name}: ${res.status} ${(await res.text()).slice(0, 300)}`, false);
          }
          const held = heldBytes(res, offset);
          if (held <= offset) throw new UploadError(`Uploading ${name}: Storage kept none of the chunk.`, false);
          advance(held);
          return;
        }
      }

      return {
        async write(text) {
          const bytes = Buffer.from(text);
          md5.update(bytes);
          pending = Buffer.concat([pending, bytes]);
          while (pending.length >= chunkBytes) await flush(false);
        },
        async close() {
          await flush(true);
        },
      };
    },

    async read(name) {
      const res = await retrying(() =>
        send(`${storage}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName(name))}?alt=media`, {
          method: 'GET',
        }),
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Reading ${objectName(name)}: ${res.status} ${(await res.text()).slice(0, 300)}`);
      return res.text();
    },
  };
}

/** A sink in memory, for tests. */
export function memorySink(runId: string, files = new Map<string, string>()): RunSink & { files: Map<string, string> } {
  return {
    files,
    location: `memory://runs/${runId}/`,
    async create(name, _contentType, { once = false } = {}) {
      if (once && files.has(name)) throw new Error(`${name} already exists.`);
      let text = '';
      return {
        async write(chunk) {
          text += chunk;
        },
        async close() {
          files.set(name, text);
        },
      };
    },
    async read(name) {
      return files.get(name) ?? null;
    },
  };
}
