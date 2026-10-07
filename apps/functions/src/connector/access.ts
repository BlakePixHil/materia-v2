import type { Firestore, Timestamp } from 'firebase-admin/firestore';

import {
  DEFAULT_ORG_TIMEZONE,
  mfaEnforced,
  resolveConnectorSettings,
  resolveSecurity,
  ROLES,
  sessionExpired,
  sessionRevoked,
  type ConnectorScope,
  type Role,
} from '@materia/domain';

import { connectionPath } from './tokens';
import { isEnabled } from '../core/flags';
import { readSecurity } from '../core/sessions';
import type { Clock } from '../ports';

/** Who a connector request acts for, re-read on every call: nothing is cached across calls. */
export interface ConnectorPrincipal {
  orgId: string;
  uid: string;
  role: Role;
  /** The member's name, for suggestions' "Suggested in Claude by …". */
  name: string;
  connectionId: string;
  clientName: string;
  scopes: readonly ConnectorScope[];
  /** The practice lets Claude suggest changes. */
  allowProposals: boolean;
  /** The practice is scheduled for deletion (SEC-05): reads only. */
  readOnly: boolean;
  timeZone: string;
}

/**
 * Why a connection may not be used now. Each also ends the person's Materia sessions or access,
 * so Claude asks them to connect again once they can: a disconnected connection, a member who
 * was suspended or removed, a sign-in that was signed out everywhere or is older than the
 * practice's session length (SEC-04), a practice that now needs a second factor the sign-in didn't
 * use, the practice's switch, or Materia's own flag.
 */
export type ConnectorDenial =
  | 'connection_revoked'
  | 'member_inactive'
  | 'signed_out'
  | 'session_expired'
  | 'mfa_required'
  | 'practice_off'
  | 'feature_off';

export const DENIAL_DESCRIPTIONS: Readonly<Record<ConnectorDenial, string>> = {
  connection_revoked: 'This connection was disconnected. Connect Claude to Materia again.',
  member_inactive: 'Your access to this practice in Materia has ended or is paused.',
  signed_out: 'You were signed out of Materia everywhere. Connect Claude to Materia again.',
  session_expired: 'Your practice asks you to sign in to Materia again. Connect Claude to Materia again.',
  mfa_required: 'Your practice now requires two-step sign-in. Set it up in Materia, then connect Claude again.',
  practice_off: 'Your practice has turned off the Claude connector.',
  feature_off: 'The Claude connector isn’t available to your practice.',
};

export const toDate = (value: unknown): Date | undefined =>
  value instanceof Date ? value : value ? (value as Timestamp).toDate?.() : undefined;

const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value);

/**
 * Checks a connection against everything that could have ended it since it was made, and returns
 * who it acts for: one read of the connection, member and org (plus the cached flag).
 */
export async function resolvePrincipal(
  deps: { db: Firestore; clock: Clock },
  orgId: string,
  connectionId: string,
): Promise<{ ok: true; principal: ConnectorPrincipal } | { ok: false; reason: ConnectorDenial }> {
  const { db, clock } = deps;
  const connectionRef = db.doc(connectionPath(orgId, connectionId));
  const [connection] = await db.getAll(connectionRef);
  const uid = connection?.get('uid') as string | undefined;
  if (!connection?.exists || connection.get('status') !== 'active' || !uid) {
    return { ok: false, reason: 'connection_revoked' };
  }
  const [member, org] = await db.getAll(db.doc(`orgs/${orgId}/members/${uid}`), db.doc(`orgs/${orgId}`));
  const role = member?.get('role');
  if (!member?.exists || member.get('status') !== 'active' || !isRole(role)) {
    return { ok: false, reason: 'member_inactive' };
  }
  const now = clock.now().getTime();
  const authTimeMs = toDate(connection.get('authTime'))?.getTime() ?? 0;
  const policy = resolveSecurity(readSecurity(org?.get('security')));
  if (sessionRevoked(authTimeMs, toDate(member.get('sessionsValidAfter')) ?? null)) {
    return { ok: false, reason: 'signed_out' };
  }
  if (sessionExpired(authTimeMs, policy, now)) return { ok: false, reason: 'session_expired' };
  if (mfaEnforced(policy, now) && connection.get('secondFactor') !== true) return { ok: false, reason: 'mfa_required' };
  const settings = resolveConnectorSettings(org?.get('settings')?.connector);
  if (!settings.enabled) return { ok: false, reason: 'practice_off' };
  if (!(await isEnabled({ orgId, db, clock }, 'integrations.claudeConnector'))) {
    return { ok: false, reason: 'feature_off' };
  }
  return {
    ok: true,
    principal: {
      orgId,
      uid,
      role,
      name: String(member.get('displayName') ?? 'A member'),
      connectionId,
      clientName: String(connection.get('clientName') ?? 'Claude'),
      scopes: (connection.get('scopes') as ConnectorScope[] | undefined) ?? [],
      allowProposals: settings.allowProposals,
      readOnly: !!toDate(org?.get('deletionScheduledAt')),
      timeZone: String(org?.get('timezone') ?? DEFAULT_ORG_TIMEZONE),
    },
  };
}
