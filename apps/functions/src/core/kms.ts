import { applicationDefault } from 'firebase-admin/app';

import { DomainError } from '@materia/domain';

import { REGION } from '../config';
import type { KmsPort } from '../ports';
import { adminApp } from './admin';

/** The key ring Terraform creates in every environment (`modules/firebase_env/security.tf`). */
export const KMS_KEY_RING = 'materia';

export interface CloudKmsOptions {
  /** The crypto key in the `materia` ring, such as `clerk-api-keys`. */
  cryptoKey: string;
  /** The GCP project (Functions set GCLOUD_PROJECT). */
  project?: () => string | undefined;
  /** An OAuth access token for the runtime service account (`fn-runtime`, cryptoKeyEncrypterDecrypter). */
  accessToken?: () => Promise<string>;
  fetch?: typeof fetch;
}

async function defaultToken(): Promise<string> {
  const credential = adminApp().options.credential ?? applicationDefault();
  return (await credential.getAccessToken()).access_token;
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/**
 * Cloud KMS over its REST API (ADR-019, AI-02a), so Functions need no extra client library.
 * Encrypts with the key's primary version; decrypting finds the version from the ciphertext, so
 * rotation needs no re-encryption. Errors carry the HTTP status only, never the payload.
 */
export function cloudKms(options: CloudKmsOptions): KmsPort {
  const project = options.project ?? (() => process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT']);
  const accessToken = options.accessToken ?? defaultToken;
  const doFetch = options.fetch ?? fetch;

  async function call(op: 'encrypt' | 'decrypt', body: Record<string, string>): Promise<Record<string, string>> {
    const projectId = project();
    if (!projectId) throw new DomainError('UNAVAILABLE', 'No project configured for Cloud KMS');
    const name = `projects/${projectId}/locations/${REGION}/keyRings/${KMS_KEY_RING}/cryptoKeys/${options.cryptoKey}`;
    const response = await doFetch(`https://cloudkms.googleapis.com/v1/${name}:${op}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new DomainError('UNAVAILABLE', `Cloud KMS ${op} failed`, { status: response.status });
    return (await response.json()) as Record<string, string>;
  }

  return {
    async encrypt(plaintext, aad) {
      const result = await call('encrypt', { plaintext: b64(plaintext), additionalAuthenticatedData: b64(aad) });
      return { ciphertext: result['ciphertext'] ?? '', keyVersion: result['name'] ?? '' };
    },
    async decrypt(ciphertext, aad) {
      const result = await call('decrypt', { ciphertext, additionalAuthenticatedData: b64(aad) });
      return Buffer.from(result['plaintext'] ?? '', 'base64').toString('utf8');
    },
  };
}
