import { connectStorageEmulator, getStorage, ref, uploadBytesResumable, type FirebaseStorage } from 'firebase/storage';

import { UploadCancelled, type UploadPort } from './upload-port';
import { environment } from '../../../environments/environment';
import { firebaseApp } from '../../core/firebase-app';

let storage: FirebaseStorage | undefined;

/** The files bucket (the web config's `storageBucket`), on the emulator in local and e2e builds. */
function filesStorage(): FirebaseStorage {
  if (storage) return storage;
  storage = getStorage(firebaseApp());
  if (environment.useEmulators) connectStorageEmulator(storage, '127.0.0.1', 9199);
  return storage;
}

/**
 * Firebase Storage uploads (`uploadBytesResumable`): chunked and resumable, so a dropped connection
 * on a large file retries the chunk rather than the whole file. Signed in with the app's Auth user.
 */
export function firebaseUploadPort(): UploadPort {
  return {
    upload(path, file, settings, progress) {
      const task = uploadBytesResumable(ref(filesStorage(), path), file, settings);
      const done = new Promise<void>((resolve, reject) => {
        task.on(
          'state_changed',
          (snapshot) => progress({ sent: snapshot.bytesTransferred, total: snapshot.totalBytes }),
          (error) => reject((error as { code?: string }).code === 'storage/canceled' ? new UploadCancelled() : error),
          () => resolve(),
        );
      });
      return { done, cancel: () => void task.cancel() };
    },
  };
}
