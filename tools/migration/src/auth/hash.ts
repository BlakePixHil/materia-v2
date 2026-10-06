import { createCipheriv, scryptSync } from 'node:crypto';

import type { UserImportOptions } from 'firebase-admin/auth';
import * as z from 'zod';

/**
 * The legacy project's password hash parameters (MIG-04). Firebase hashes passwords with its own
 * scrypt variant, keyed per project; the parameters are in the legacy console under Authentication
 * › Users › ⋮ › Password hash parameters. They live only in the v2 project's Secret Manager, as
 * `LEGACY_SCRYPT_PARAMS`, in the console's own field names. Never in the repo, chat or logs.
 */
export const HASH_PARAMS_SECRET = 'LEGACY_SCRYPT_PARAMS';

const Base64 = z.string().regex(/^[A-Za-z0-9+/_-]+={0,2}$/, 'must be base64');

export const HashParamsSchema = z.object({
  base64_signer_key: Base64,
  base64_salt_separator: Base64,
  rounds: z.number().int().min(1).max(8),
  mem_cost: z.number().int().min(1).max(14),
});

export type HashParams = z.infer<typeof HashParamsSchema>;

/** Parses the secret's JSON. Errors never echo the values. */
export function parseHashParams(json: string): HashParams {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(`${HASH_PARAMS_SECRET} is not JSON.`);
  }
  const parsed = HashParamsSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))].join(', ');
    throw new Error(`${HASH_PARAMS_SECRET} is missing or has bad fields: ${fields}.`);
  }
  return parsed.data;
}

/** The Admin SDK's import options for Firebase scrypt hashes. */
export function scryptImportOptions(params: HashParams): UserImportOptions {
  return {
    hash: {
      algorithm: 'SCRYPT',
      key: Buffer.from(params.base64_signer_key, 'base64'),
      saltSeparator: Buffer.from(params.base64_salt_separator, 'base64'),
      rounds: params.rounds,
      memoryCost: params.mem_cost,
    },
  };
}

/**
 * Firebase's scrypt variant: scrypt(password, salt + separator) keys AES-256-CTR, which encrypts
 * the signer key. Only tests and rehearsals use it, to make a hash for a made-up user that a real
 * Identity Platform project can check.
 */
export function firebaseScryptHash(password: string, salt: Buffer, params: HashParams): Buffer {
  const derived = scryptSync(password, Buffer.concat([salt, Buffer.from(params.base64_salt_separator, 'base64')]), 64, {
    N: 2 ** params.mem_cost,
    r: params.rounds,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });
  const cipher = createCipheriv('aes-256-ctr', derived.subarray(0, 32), Buffer.alloc(16, 0));
  return Buffer.concat([cipher.update(Buffer.from(params.base64_signer_key, 'base64')), cipher.final()]);
}
