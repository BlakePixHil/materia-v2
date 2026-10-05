import { InjectionToken } from '@angular/core';

/** What an upload reports while it runs. */
export interface UploadProgress {
  sent: number;
  total: number;
}

/** A running upload: cancel it, or await it. */
export interface UploadHandle {
  /** Resolves when the bytes are stored in the pending area; rejects on failure or cancel. */
  readonly done: Promise<void>;
  cancel(): void;
}

/** Thrown (by `done`) when the upload was cancelled. */
export class UploadCancelled extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadCancelled';
  }
}

/**
 * Puts a file's bytes in the files bucket (CORE-12): a resumable upload to the pending path with the
 * contract's content type and custom metadata. The Firebase implementation loads lazily with the
 * Documents tab; tests use a fake.
 */
export interface UploadPort {
  upload(
    path: string,
    file: Blob,
    settings: { contentType: string; customMetadata: Record<string, string> },
    progress: (progress: UploadProgress) => void,
  ): UploadHandle;
}

export const UPLOAD_PORT = new InjectionToken<UploadPort>('UPLOAD_PORT', {
  providedIn: 'root',
  factory: () => lazyUploadPort(),
});

/** Loads the Firebase Storage SDK on the first upload, keeping it out of every other chunk. */
export function lazyUploadPort(
  load: () => Promise<UploadPort> = () => import('./firebase-upload-port').then((m) => m.firebaseUploadPort()),
): UploadPort {
  let port: Promise<UploadPort> | undefined;
  return {
    upload(path, file, settings, progress) {
      let cancelled = false;
      let inner: UploadHandle | undefined;
      const done = (port ??= load()).then((loaded) => {
        if (cancelled) throw new UploadCancelled();
        inner = loaded.upload(path, file, settings, progress);
        return inner.done;
      });
      return {
        done,
        cancel: () => {
          cancelled = true;
          inner?.cancel();
        },
      };
    },
  };
}
