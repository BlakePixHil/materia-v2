import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { ConnectorGrantKind } from '@materia/domain';

/**
 * The Claude connector's tokens (INT-07, ADR-064): opaque, `{kind}.{org}.{secret}` with 256 random
 * bits of secret. The org (base64url) says where the grant is stored; only the token's SHA-256 is
 * stored, as the grant's id, so a database read gives nothing usable.
 */
const PREFIX: Readonly<Record<ConnectorGrantKind, string>> = { code: 'mtc', access: 'mta', refresh: 'mtr' };
const KIND_OF = new Map(Object.entries(PREFIX).map(([kind, prefix]) => [prefix, kind as ConnectorGrantKind]));
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL = /^[A-Za-z0-9_-]{1,300}$/;

export function newConnectorToken(kind: ConnectorGrantKind, orgId: string): string {
  return `${PREFIX[kind]}.${Buffer.from(orgId, 'utf8').toString('base64url')}.${randomBytes(32).toString('base64url')}`;
}

export interface ParsedConnectorToken {
  kind: ConnectorGrantKind;
  orgId: string;
  /** The grant's id: the token's SHA-256, hex. */
  hash: string;
}

/** The kind, org and hash of a well-formed token (of `kind`, when given); null for anything else. */
export function parseConnectorToken(token: unknown, kind?: ConnectorGrantKind): ParsedConnectorToken | null {
  if (typeof token !== 'string' || token.length > 400) return null;
  const [prefix, org, secret, ...rest] = token.split('.');
  const found = prefix ? KIND_OF.get(prefix) : undefined;
  if (!found || rest.length || (kind && found !== kind)) return null;
  if (!org || !BASE64URL.test(org) || !secret || !SECRET.test(secret)) return null;
  const orgId = Buffer.from(org, 'base64url').toString('utf8');
  // Only the canonical encoding of a plausible id: no path separators, nothing that re-encodes differently.
  if (!orgId || orgId.includes('/') || Buffer.from(orgId, 'utf8').toString('base64url') !== org) return null;
  return { kind: found, orgId, hash: sha256Hex(token) };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** RFC 7636: the verifier's S256 challenge equals the one the code was issued for. */
export function pkceMatches(verifier: unknown, challenge: string | undefined): boolean {
  if (typeof verifier !== 'string' || !challenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const connectionsPath = (orgId: string) => `orgs/${orgId}/connectorConnections`;
export const connectionPath = (orgId: string, connectionId: string) => `${connectionsPath(orgId)}/${connectionId}`;
export const grantsPath = (orgId: string) => `orgs/${orgId}/connectorGrants`;
export const grantPath = (orgId: string, hash: string) => `${grantsPath(orgId)}/${hash}`;
