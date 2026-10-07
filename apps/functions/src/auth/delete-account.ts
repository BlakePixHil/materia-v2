import {
  DELETE_ACCOUNT_CALLABLE,
  DELETE_ACCOUNT_CONFIRMATION,
  DeleteAccountInput,
  DomainError,
  SENSITIVE_REAUTH_MINUTES,
} from '@materia/domain';

import { defineUserCallable, type UserCallableDefinition } from '../core/user-callable';
import { storageFiles, type FileStore } from '../documents/files';

/**
 * `auth-deleteAccount` (SEC-05; signed in within the last few minutes): someone who belongs to no
 * practice deletes their account: `users/{uid}` with everything under it, their stored files
 * (`users/{uid}/`, the photo) and their sign-in. They type DELETE. Anyone still in a practice
 * (active or suspended) is refused with ACCOUNT_HAS_ORGS: they leave, or the practice is deleted,
 * first. Nothing is audited in a practice (there is none); the log keeps the uid only.
 */
export function deleteAccountDefinition(files: () => FileStore = () => storageFiles()) {
  return {
    name: DELETE_ACCOUNT_CALLABLE,
    input: DeleteAccountInput,
    recentLoginMinutes: SENSITIVE_REAUTH_MINUTES,
    handler: async ({ input, uid, token, db, auth, log }): Promise<{ deleted: true }> => {
      const self = uid as string;
      if (input.confirmation.toUpperCase() !== DELETE_ACCOUNT_CONFIRMATION) {
        throw new DomainError('INVALID_ARGUMENT', 'Type DELETE to confirm', {
          fields: { confirmation: [`Type ${DELETE_ACCOUNT_CONFIRMATION} to confirm`] },
        });
      }
      const user = (await db.doc(`users/${self}`).get()).data();
      const orgIds = Array.isArray(user?.['orgIds']) ? (user['orgIds'] as string[]) : [];
      const claimed = Object.keys((token?.['orgs'] as Record<string, unknown> | undefined) ?? {});
      // The member documents are the truth: a stale `orgIds` must not hide a membership.
      const candidates = [...new Set([...orgIds, ...claimed])];
      const members = candidates.length
        ? await db.getAll(...candidates.map((orgId) => db.doc(`orgs/${orgId}/members/${self}`)))
        : [];
      const inOrgs = members.filter((member) => ['active', 'suspended'].includes(String(member.get('status'))));
      if (inOrgs.length) {
        throw new DomainError('ACCOUNT_HAS_ORGS', 'Leave every practice before deleting your account', {
          orgs: inOrgs.length,
        });
      }
      await db.recursiveDelete(db.doc(`users/${self}`));
      const removedFiles = await files().purge(`users/${self}/`);
      await auth.deleteUser(self).catch((error: unknown) => {
        if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
      });
      log.info('account deleted', { files: removedFiles });
      return { deleted: true };
    },
  } satisfies UserCallableDefinition<typeof DeleteAccountInput, { deleted: true }>;
}

export const deleteAccount = defineUserCallable(deleteAccountDefinition());
