import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';

import { DomainValueError } from './errors';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const ID_LENGTH = 20;
const ID_RE = /^[0-9A-Za-z]{20}$/;

export const IdSchema = z.string().regex(ID_RE, { message: 'Expected a 20-character base62 id' });

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/** A Firestore-compatible random id: 20 base62 characters, unbiased (rejection sampling). */
export function newId(): string {
  let id = '';
  const bytes = new Uint8Array(40);
  while (id.length < ID_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      // 248 = 62 * 4: values at or above it would bias the distribution.
      if (byte < 248 && id.length < ID_LENGTH) id += ALPHABET[byte % 62];
    }
  }
  return id;
}

const BASE = 62n;
const MODULUS = BASE ** BigInt(ID_LENGTH);

/**
 * A stable id for `key` within `namespace` (sha256 → base62), so re-running the migration writes
 * the same documents. Different namespaces never collide on the same key.
 */
export function deterministicId(namespace: string, key: string): string {
  if (!namespace) throw new DomainValueError('Id', namespace, 'deterministicId needs a namespace');
  const digest = sha256(utf8ToBytes(`${namespace}\u0000${key}`));
  let n = 0n;
  for (const byte of digest) n = (n << 8n) | BigInt(byte);
  n %= MODULUS;
  let id = '';
  for (let i = 0; i < ID_LENGTH; i += 1) {
    id = ALPHABET[Number(n % BASE)] + id;
    n /= BASE;
  }
  return id;
}
