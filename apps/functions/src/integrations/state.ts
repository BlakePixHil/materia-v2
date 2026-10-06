import { createHash, randomBytes } from 'node:crypto';

/**
 * The OAuth `state` and PKCE pair for one connect attempt (INT-01, ADR-051). The state is 256
 * random bits the browser carries to the provider and back; the server keeps only its hash, with
 * who started the attempt and the PKCE verifier, so a state can't be forged, reused or completed by
 * anyone else.
 */
export function newState(): string {
  return randomBytes(32).toString('base64url');
}

/** RFC 7636: a 43-character verifier and its `S256` challenge. */
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** `orgs/{orgId}/integrationStates/{sha256(state)}`. */
export function integrationStatePath(orgId: string, state: string): string {
  return `orgs/${orgId}/integrationStates/${createHash('sha256').update(state).digest('hex')}`;
}
