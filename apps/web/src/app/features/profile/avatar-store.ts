import { InjectionToken } from '@angular/core';
import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage';

import { filesStorage } from '../documents/firebase-upload-port';

/** Where a person's photo goes: `users/{uid}/avatar.png` (storage.rules: theirs, images, 2 MB). */
export interface AvatarStore {
  /** Uploads the cropped PNG; resolves to its download URL. */
  upload(uid: string, png: Blob): Promise<string>;
  remove(uid: string): Promise<void>;
}

const avatarPath = (uid: string) => `users/${uid}/avatar.png`;

export const AVATAR_STORE = new InjectionToken<AvatarStore>('AVATAR_STORE', {
  factory: () => ({
    async upload(uid, png) {
      const target = ref(filesStorage(), avatarPath(uid));
      await uploadBytes(target, png, { contentType: 'image/png', cacheControl: 'private, max-age=300' });
      return getDownloadURL(target);
    },
    async remove(uid) {
      await deleteObject(ref(filesStorage(), avatarPath(uid))).catch((error: { code?: string }) => {
        if (error?.code !== 'storage/object-not-found') throw error;
      });
    },
  }),
});
