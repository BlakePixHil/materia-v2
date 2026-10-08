import { randomUUID } from 'node:crypto';

import { getStorage, type Storage } from 'firebase-admin/storage';

import { adminApp } from '../core/admin';
import type { SignedUrlPort } from '../ports';

/**
 * V4 signed read URLs (CORE-12): the runtime account signs as itself (`iam.serviceAccounts.signBlob`,
 * granted by Terraform), and the response is served as an attachment with the version's type.
 * No public URLs and no Firebase download tokens.
 */
export function storageSignedUrls(storage: () => Storage = () => getStorage(adminApp())): SignedUrlPort {
  return {
    async sign({ bucket, path, expiresAt, disposition, contentType }) {
      const [url] = await storage().bucket(bucket).file(path).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: expiresAt,
        responseDisposition: disposition,
        responseType: contentType,
      });
      return url;
    },
  };
}

/** V4's `X-Goog-Date`: `YYYYMMDD'T'HHMMSS'Z'`. */
export const googDate = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/**
 * The emulator can't sign URLs (there is no service account key), so in the emulator only, the
 * object gets a download token and the URL points at the Storage emulator. It carries the same
 * `X-Goog-Date`/`X-Goog-Expires` and disposition parameters as a real V4 URL, so tests and the
 * web app see the same shape; the emulator doesn't enforce the expiry.
 *
 * Two first signings at the same moment each add a token, and the emulator keeps both as one
 * comma-separated list ("a,b"). A URL carries one of them: the emulator refuses the whole list.
 */
export function emulatorSignedUrls(now: () => Date = () => new Date()): SignedUrlPort {
  return {
    async sign({ bucket, path, expiresAt, disposition }) {
      const host = process.env['FIREBASE_STORAGE_EMULATOR_HOST'] ?? '127.0.0.1:9199';
      const file = getStorage(adminApp()).bucket(bucket).file(path);
      const [meta] = await file.getMetadata();
      const existing = (meta.metadata as Record<string, unknown> | undefined)?.['firebaseStorageDownloadTokens'];
      let token = typeof existing === 'string' ? (existing.split(',')[0] ?? '') : '';
      if (!token) {
        token = randomUUID();
        await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
      }
      const issued = now();
      const seconds = Math.max(1, Math.round((expiresAt.getTime() - issued.getTime()) / 1000));
      const query = new URLSearchParams({
        alt: 'media',
        token,
        'X-Goog-Date': googDate(issued),
        'X-Goog-Expires': String(seconds),
        'response-content-disposition': disposition,
      });
      return `http://${host}/v0/b/${bucket}/o/${encodeURIComponent(path)}?${query.toString()}`;
    },
  };
}
