import { createHash } from 'node:crypto';

/**
 * Seals a value as the emulator's fake KMS does (`FakeKms` in the functions' fakes): XOR with a
 * pad from the additional authenticated data, so only the matching `aad` opens it. Deterministic and
 * for the emulators only; it protects nothing.
 */
export function fakeKmsSeal(plaintext: string, aad: string): string {
  const pad = createHash('sha256').update(`materia-fake-kms:${aad}`).digest();
  const body = Buffer.from(`ok:${plaintext}`).map((byte, i) => byte ^ (pad[i % pad.length] as number) ^ 0x5a);
  return `fakekms.${Buffer.from(body).toString('base64')}`;
}
