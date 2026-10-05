import type { Firestore } from 'firebase-admin/firestore';

import type { KmsPort } from '../ports';

/** The org's Anthropic key document (AI-02a, ADR-019 pattern). Closed to every client by the rules. */
export const anthropicKeyPath = (orgId: string) => `orgs/${orgId}/integrations/anthropic`;

/** How long a decrypted key is reused while its ciphertext is unchanged (saves a KMS call per request). */
export const KEY_CACHE_TTL_MS = 5 * 60_000;

/**
 * The org's key for one call: none saved, saved but rejected by Anthropic (an admin must replace
 * it), or usable. `version` identifies the stored key, so marking it invalid never touches a newer
 * key saved in the meantime.
 */
export type OrgKey = { state: 'missing' } | { state: 'invalid' } | { state: 'ok'; apiKey: string; version: string };

/** Where the gateway gets each org's key (BYOK, AI-02a). */
export interface ClerkKeyring {
  resolve(orgId: string): Promise<OrgKey>;
  /** Anthropic rejected the key (401/403): mark it invalid unless it has been replaced since. */
  markInvalid(orgId: string, version: string, at: Date): Promise<void>;
}

/**
 * The keyring on Firestore and Cloud KMS. The document is read on every call (so a new key applies
 * to the next call); the plaintext is cached per org only while the ciphertext is the same, and
 * never leaves this process.
 */
export function firestoreKeyring(db: Firestore, kms: KmsPort, now: () => number = Date.now): ClerkKeyring {
  const cache = new Map<string, { version: string; apiKey: string; expiresAt: number }>();
  return {
    async resolve(orgId) {
      const snapshot = await db.doc(anthropicKeyPath(orgId)).get();
      const ciphertext = snapshot.get('encryptedApiKey') as string | undefined;
      if (!snapshot.exists || !ciphertext) return { state: 'missing' };
      if (snapshot.get('status') === 'invalid') return { state: 'invalid' };
      const at = now();
      const cached = cache.get(orgId);
      if (cached && cached.version === ciphertext && cached.expiresAt > at)
        return { state: 'ok', apiKey: cached.apiKey, version: ciphertext };
      const apiKey = await kms.decrypt(ciphertext, anthropicKeyPath(orgId));
      cache.set(orgId, { version: ciphertext, apiKey, expiresAt: at + KEY_CACHE_TTL_MS });
      return { state: 'ok', apiKey, version: ciphertext };
    },

    async markInvalid(orgId, version, at) {
      cache.delete(orgId);
      const ref = db.doc(anthropicKeyPath(orgId));
      await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists || snapshot.get('encryptedApiKey') !== version) return;
        tx.update(ref, { status: 'invalid', invalidAt: at, updatedAt: at, updatedBy: 'system' });
      });
    },
  };
}
