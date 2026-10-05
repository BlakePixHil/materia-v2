import { getStorage } from 'firebase-admin/storage';

import { adminApp } from '../core/admin';

/**
 * The matter-files bucket: `{project}-files`, created by Terraform (FND-03); the emulator's is
 * `{project}.appspot.com` (the `files` target in .firebaserc). Resolved when the functions load,
 * because the upload trigger is bound to it at deploy time (firebase-tools sets GCLOUD_PROJECT).
 */
export function filesBucket(project = process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT']): string {
  if (process.env['MATERIA_FILES_BUCKET']) return process.env['MATERIA_FILES_BUCKET'];
  if (!project || project.startsWith('demo-')) return `${project ?? 'demo-materia'}.appspot.com`;
  return `${project}-files`;
}

/** One Storage object's facts (never its content). */
export interface StoredObject {
  path: string;
  size: number;
  generation: string;
  contentType?: string | undefined;
  timeCreated?: Date | undefined;
  /** Custom metadata. */
  metadata: Record<string, string>;
}

export interface WriteOptions {
  contentType: string;
  /** `Content-Disposition`, so even a direct download is an attachment. */
  disposition?: string;
  metadata?: Record<string, string>;
}

/**
 * The Storage operations the documents pipeline needs (CORE-12), so unit tests run against an
 * in-memory bucket. Writes never overwrite: a version, once stored, is immutable.
 */
export interface FileStore {
  readonly bucket: string;
  stat(path: string): Promise<StoredObject | null>;
  /** The object's bytes, or null when it (or that generation) is gone. */
  read(path: string, generation?: string): Promise<Buffer | null>;
  /** Writes only if nothing is there yet; `exists` when a retry finds its own earlier write. */
  write(path: string, data: Uint8Array, options: WriteOptions): Promise<'written' | 'exists'>;
  /**
   * Deletes the object, or one generation of it. With a generation the bytes are gone for good,
   * even in the versioned production bucket (quarantined and infected files must not linger).
   */
  remove(path: string, generation?: string): Promise<void>;
  /** Objects under `prefix` whose names match `glob` (Cloud Storage `matchGlob`). */
  list(prefix: string, glob: string): Promise<StoredObject[]>;
}

const asObject = (path: string, meta: Record<string, unknown>): StoredObject => ({
  path,
  size: Number(meta['size'] ?? 0),
  generation: String(meta['generation'] ?? ''),
  contentType: typeof meta['contentType'] === 'string' ? meta['contentType'] : undefined,
  timeCreated: typeof meta['timeCreated'] === 'string' ? new Date(meta['timeCreated']) : undefined,
  metadata: Object.fromEntries(
    Object.entries((meta['metadata'] as Record<string, unknown> | undefined) ?? {}).map(([k, v]) => [k, String(v)]),
  ),
});

const status = (error: unknown) => (error as { code?: number }).code;

/** Cloud Storage through the Admin SDK (the Storage emulator when FIREBASE_STORAGE_EMULATOR_HOST is set). */
export function storageFiles(bucketName: string = filesBucket()): FileStore {
  const bucket = () => getStorage(adminApp()).bucket(bucketName);
  return {
    bucket: bucketName,
    async stat(path) {
      try {
        const [meta] = await bucket().file(path).getMetadata();
        return asObject(path, meta as Record<string, unknown>);
      } catch (error) {
        if (status(error) === 404) return null;
        throw error;
      }
    },
    async read(path, generation) {
      try {
        const file = generation ? bucket().file(path, { generation }) : bucket().file(path);
        const [data] = await file.download();
        return data;
      } catch (error) {
        if (status(error) === 404) return null;
        throw error;
      }
    },
    async write(path, data, options) {
      try {
        await bucket()
          .file(path)
          .save(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
            resumable: false,
            contentType: options.contentType,
            metadata: {
              ...(options.disposition ? { contentDisposition: options.disposition } : {}),
              ...(options.metadata ? { metadata: options.metadata } : {}),
            },
            preconditionOpts: { ifGenerationMatch: 0 },
          });
        return 'written';
      } catch (error) {
        if (status(error) === 412) return 'exists';
        throw error;
      }
    },
    async remove(path, generation) {
      const file = generation ? bucket().file(path, { generation }) : bucket().file(path);
      await file.delete({ ignoreNotFound: true });
    },
    async list(prefix, glob) {
      const [files] = await bucket().getFiles({ prefix, matchGlob: glob, autoPaginate: true });
      return files.map((file) => asObject(file.name, file.metadata as Record<string, unknown>));
    },
  };
}
