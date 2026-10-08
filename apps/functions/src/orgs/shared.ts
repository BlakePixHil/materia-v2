import { createHash, randomBytes } from 'node:crypto';

import type { Auth, UserRecord } from 'firebase-admin/auth';
import type { Firestore, Transaction } from 'firebase-admin/firestore';

import { DomainError, type Role } from '@materia/domain';

import { CUSTOM_DOMAINS } from '../config';
import { isEmulator } from '../core/env';

/** A 32-byte random invite token, base64url (sent in the link, never stored). */
export function newInviteToken(bytes: Buffer = randomBytes(32)): string {
  return bytes.toString('base64url');
}

/** What is stored instead of the token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The app's address for links in emails: `MATERIA_APP_URL`, the dev server locally, else Hosting. */
export function appUrl(): string {
  const configured = process.env['MATERIA_APP_URL'];
  if (configured) return configured.replace(/\/$/, '');
  if (isEmulator()) return 'http://localhost:4200';
  return `https://${process.env['GCLOUD_PROJECT'] ?? 'materia-v2-dev'}.web.app`;
}

/** The deployed app's own origins: `appUrl`, the project's web.app address and its custom domains. */
export function appOrigins(): string[] {
  const project = process.env['GCLOUD_PROJECT'] ?? 'materia-v2-dev';
  const hosts = [`${project}.web.app`, ...(CUSTOM_DOMAINS[project] ?? [])];
  return [...new Set([appUrl(), ...hosts.map((host) => `https://${host}`)])];
}

/** The accept-invite path: `/invite/{inviteId}?token=…`. */
export function invitePath(inviteId: string, token: string): string {
  return `/invite/${encodeURIComponent(inviteId)}?token=${encodeURIComponent(token)}`;
}

export const memberPath = (orgId: string, uid: string) => `orgs/${orgId}/members/${uid}`;

/** Two letters from a display name ("Priya Shah" → "PS"). */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts.at(-1)?.[0] ?? ''}` : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase() || '?';
}

const COLOURS = ['#346CFC', '#0E9F6E', '#C2410C', '#7C3AED', '#0891B2', '#BE185D', '#4D7C0F', '#B45309'];

/** A stable avatar colour for a uid. */
export function colourFor(uid: string): string {
  let hash = 0;
  for (const char of uid) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLOURS[hash % COLOURS.length] as string;
}

/** A new member document for a person joining an org. */
export function newMember(user: UserRecord, role: Role, now: Date, by: string) {
  const email = (user.email ?? '').toLowerCase();
  const displayName = user.displayName?.trim() || email.split('@')[0] || 'Member';
  return {
    role,
    status: 'active',
    ...(email ? { email } : {}),
    displayName,
    initials: initialsOf(displayName),
    title: '',
    defaultRateCents: 0,
    rates: [],
    colour: colourFor(user.uid),
    budgets: {},
    createdAt: now,
    createdBy: by,
    updatedAt: now,
    updatedBy: by,
    schemaVersion: 1,
  };
}

/** The signed-in person's Auth record, with a verified email (invites are matched on it). */
export async function verifiedUser(auth: Auth, uid: string): Promise<UserRecord & { email: string }> {
  const user = await auth.getUser(uid);
  // Federated sign-ins (Google) are verified by the provider; Identity Platform marks them verified.
  if (!user.email || !user.emailVerified) throw new DomainError('EMAIL_NOT_VERIFIED', 'Verify your email first');
  return user as UserRecord & { email: string };
}

/**
 * The last-owner invariant (FND-17): the org must keep at least one active owner. Call inside the
 * transaction that changes `uid`, before writing; it counts the active owners other than `uid`.
 */
export async function assertAnotherOwner(tx: Transaction, db: Firestore, orgId: string, uid: string): Promise<void> {
  const owners = await tx.get(
    db.collection(`orgs/${orgId}/members`).where('role', '==', 'owner').where('status', '==', 'active'),
  );
  if (!owners.docs.some((doc) => doc.id !== uid)) {
    throw new DomainError('LAST_OWNER', 'The organisation must keep at least one active owner');
  }
}
