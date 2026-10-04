import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

import { decideClaim } from './claim';
import type { JobFiles, JobStore } from './types';

/** Firestore Timestamps back to Dates, so the domain schema can validate the document. */
function toDates(value: unknown): unknown {
  if (value && typeof value === 'object') {
    if ('toDate' in value && typeof value.toDate === 'function') return (value.toDate as () => Date)();
    if (Array.isArray(value)) return value.map(toDates);
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, toDates(inner)]));
  }
  return value;
}

export function firestoreJobStore(db: Firestore, orgId: string, jobId: string): JobStore {
  const ref = db.doc(`orgs/${orgId}/jobs/${jobId}`);
  return {
    async claim(now) {
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) throw new Error(`Job ${jobId} does not exist`);
        const result = decideClaim(toDates(snapshot.data()), now);
        if (result.kind === 'claimed') {
          tx.update(ref, {
            status: 'running',
            attempts: result.job.attempts,
            startedAt: now,
            heartbeatAt: now,
            error: FieldValue.delete(),
            updatedAt: now,
            updatedBy: 'system:jobs',
          });
        }
        return result;
      });
    },
    async progress(progress, now) {
      await ref.update({ progress, heartbeatAt: now, updatedAt: now, updatedBy: 'system:jobs' });
    },
    async succeed(output, warnings, now) {
      await ref.update({
        status: 'succeeded',
        output,
        warnings,
        finishedAt: now,
        heartbeatAt: now,
        updatedAt: now,
        updatedBy: 'system:jobs',
      });
    },
    async fail(error, warnings, now) {
      await ref.update({
        status: 'failed',
        error,
        warnings,
        finishedAt: now,
        heartbeatAt: now,
        updatedAt: now,
        updatedBy: 'system:jobs',
      });
    },
    async createDocument(path, data) {
      await db.doc(path).set(data);
    },
  };
}

export function storageFiles(bucketName: string): JobFiles {
  const bucket = getStorage().bucket(bucketName);
  return {
    async download(storagePath, localPath, signal) {
      await pipeline(
        bucket.file(storagePath).createReadStream({ validation: 'crc32c' }),
        createWriteStream(localPath),
        { signal },
      );
    },
    async upload(localPath, storagePath, contentType) {
      await bucket.upload(localPath, { destination: storagePath, contentType, resumable: false, validation: 'crc32c' });
    },
  };
}

export function firebaseDeps(orgId: string, jobId: string) {
  if (getApps().length === 0) initializeApp();
  const project = process.env['GOOGLE_CLOUD_PROJECT'] ?? process.env['GCLOUD_PROJECT'];
  const bucket = process.env['STORAGE_BUCKET'] ?? (project ? `${project}-files` : undefined);
  if (!bucket) throw new Error('Set STORAGE_BUCKET (or GOOGLE_CLOUD_PROJECT)');
  return { store: firestoreJobStore(getFirestore(), orgId, jobId), files: storageFiles(bucket) };
}
