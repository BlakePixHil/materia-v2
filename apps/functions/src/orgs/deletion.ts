import { FieldValue, type Firestore } from 'firebase-admin/firestore';

import {
  CancelOrgDeletionInput,
  confirmsOrgName,
  dateOnlyAt,
  DomainError,
  exportStillRunning,
  longDate,
  ORG_DELETION_CALLABLES,
  ORG_DELETION_GRACE_DAYS,
  orgDeletionDate,
  RequestOrgDeletionInput,
  SENSITIVE_REAUTH_MINUTES,
  validTimeZone,
  type OrgDeletionBlocker,
  type RequestOrgDeletionResult,
} from '@materia/domain';

import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';
import type { Log } from '../core/log';
import { notify } from '../notifications/notify';
import type { Clock, Ports } from '../ports';

/**
 * Deleting a practice (SEC-05, ADR-058). An owner asks (`orgs-requestDeletion`, with a fresh
 * sign-in and the practice's name typed); the practice becomes read-only and is deleted after
 * ORG_DELETION_GRACE_DAYS by the `orgs-purge` job (orgs/purge.ts). Until the job starts, any owner
 * can cancel (`orgs-cancelDeletion`). A legal hold (on the practice or any matter) or an export
 * still being written stops a request; a hold placed during the grace period stops the deletion.
 */

type Data = Record<string, unknown>;

const toDate = (value: unknown): Date | null =>
  value instanceof Date ? value : ((value as { toDate?: () => Date } | null | undefined)?.toDate?.() ?? null);

/** Audit entries about the deletion are filed here (the org document's own path isn't under it). */
export const deletionAuditPath = (orgId: string) => `orgs/${orgId}/settings/deletion`;
export const deletedOrgPath = (orgId: string) => `deletedOrgs/${orgId}`;

/** What stops the practice being deleted now, with the record that does, or null. */
export async function deletionBlocker(
  db: Firestore,
  orgId: string,
  now: Date,
): Promise<{ code: OrgDeletionBlocker; matterId?: string; jobId?: string } | null> {
  const org = (await db.doc(`orgs/${orgId}`).get()).data();
  if ((org?.['legalHold'] as { on?: unknown } | undefined)?.on === true) return { code: 'LEGAL_HOLD' };
  const held = await db.collection(`orgs/${orgId}/matters`).where('legalHold.on', '==', true).limit(1).get();
  if (!held.empty) return { code: 'LEGAL_HOLD', matterId: held.docs[0]?.id as string };
  const jobs = await db.collection(`orgs/${orgId}/jobs`).where('status', 'in', ['queued', 'running']).get();
  const running = jobs.docs.find(
    (job) =>
      (job.get('target') as { kind?: string } | undefined)?.kind === 'export' &&
      exportStillRunning(
        {
          status: job.get('status'),
          heartbeatAt: toDate(job.get('heartbeatAt')),
          updatedAt: toDate(job.get('updatedAt')),
        },
        now,
      ),
  );
  if (running) return { code: 'EXPORT_RUNNING', jobId: running.id };
  return null;
}

/** Throws the blocker as a DomainError (with copy in the web app). */
export function blockerError(blocker: NonNullable<Awaited<ReturnType<typeof deletionBlocker>>>): DomainError {
  if (blocker.code === 'LEGAL_HOLD') {
    return new DomainError('LEGAL_HOLD', 'A legal hold is on, so the practice can’t be deleted', {
      ...(blocker.matterId ? { matterId: blocker.matterId } : { scope: 'org' }),
    });
  }
  return new DomainError('EXPORT_RUNNING', 'An export is still being written; try again when it’s finished', {
    jobId: blocker.jobId ?? null,
  });
}

/** Active members, to tell everyone. */
export async function activeMemberUids(db: Firestore, orgId: string, role?: 'owner'): Promise<string[]> {
  let query = db.collection(`orgs/${orgId}/members`).where('status', '==', 'active');
  if (role) query = query.where('role', '==', role);
  return (await query.get()).docs.map((doc) => doc.id);
}

/** The deletion date as people read it ("6 November 2026"), in the practice's time zone. */
export const deletionDay = (at: Date, org: Data | undefined) =>
  longDate(dateOnlyAt(at, validTimeZone(org?.['timezone'] as string | undefined)));

interface DeletionNotice {
  db: Firestore;
  orgId: string;
  clock: Clock;
  log: Log;
  ports: Pick<Ports, 'tasks'>;
}

/** Tells the members about the deletion (in-app and email: `org_deletion`). */
export async function noticeToMembers(
  ctx: DeletionNotice,
  recipients: string[],
  notice: { title: string; body: string; key: string; actor?: string },
): Promise<number> {
  if (!recipients.length) return 0;
  const sent = await notify(ctx, {
    kind: 'org_deletion',
    recipients,
    title: notice.title,
    body: notice.body,
    link: '/settings/data',
    key: notice.key,
    ...(notice.actor ? { actor: notice.actor } : {}),
  });
  return sent.ids.length;
}

/**
 * `orgs-requestDeletion` (SEC-05; owners, signed in within the last few minutes): schedules the
 * practice's deletion ORG_DELETION_GRACE_DAYS from now. The owner types the practice's name
 * (`confirmation`). Refused while a legal hold is on (LEGAL_HOLD) or an export is still being
 * written (EXPORT_RUNNING). Asking again while one is scheduled answers the date already set.
 * Every active member is told; audited as `org.deletion_requested`.
 */
export const requestDeletionDefinition = {
  name: ORG_DELETION_CALLABLES.request,
  input: RequestOrgDeletionInput,
  roles: ['owner'],
  idempotent: true,
  recentLoginMinutes: SENSITIVE_REAUTH_MINUTES,
  handler: async (ctx): Promise<RequestOrgDeletionResult> => {
    const { input, orgId, uid, db, clock, log, ports } = ctx;
    const orgRef = db.doc(`orgs/${orgId}`);
    const org = (await orgRef.get()).data();
    if (!org) throw new DomainError('NOT_FOUND', 'Organisation not found');
    if (!confirmsOrgName(input.confirmation, String(org['name'] ?? ''))) {
      throw new DomainError('INVALID_ARGUMENT', 'Type the practice’s name to confirm', {
        fields: { confirmation: ['Type the practice’s name exactly as it appears'] },
      });
    }
    const already = toDate(org['deletionScheduledAt']);
    if (already) return { deletionScheduledAt: already.toISOString() };
    const now = clock.now();
    const blocker = await deletionBlocker(db, orgId, now);
    if (blocker) throw blockerError(blocker);

    const at = orgDeletionDate(now);
    await db.runTransaction(async (tx) => {
      const [current, tombstone] = await tx.getAll(orgRef, db.doc(deletedOrgPath(orgId)));
      if (tombstone?.exists)
        throw new DomainError('FAILED_PRECONDITION', 'The practice is being deleted', { reason: 'deletion_started' });
      if (toDate(current?.get('deletionScheduledAt'))) return;
      tx.update(orgRef, {
        deletionScheduledAt: at,
        deletionRequestedBy: uid,
        deletionRequestedAt: now,
        updatedAt: now,
        updatedBy: uid,
        _requestId: ctx.requestId,
      });
    });
    const day = deletionDay(at, org);
    const told = await noticeToMembers({ db, orgId, clock, log, ports }, await activeMemberUids(db, orgId), {
      title: `${String(org['name'])} will be deleted on ${day}`,
      body: `An owner asked for the practice to be deleted. Until then it is read-only. An owner can cancel the deletion, or export the practice’s data, in Settings → Data and deletion.`,
      key: `org-deletion-${at.getTime()}`,
      actor: uid,
    });
    await audit(ctx, {
      action: 'org.deletion_requested',
      entity: { path: deletionAuditPath(orgId) },
      summary: `Practice deletion requested, for ${day}`,
      data: { deletionScheduledAt: at.toISOString(), graceDays: ORG_DELETION_GRACE_DAYS },
    });
    log.info('org deletion requested', { deletionScheduledAt: at.toISOString(), told });
    return { deletionScheduledAt: at.toISOString() };
  },
} satisfies CallableDefinition<typeof RequestOrgDeletionInput, RequestOrgDeletionResult>;

/**
 * Clears a scheduled deletion, unless the deletion job has started (FAILED_PRECONDITION
 * `deletion_started`). Shared by `orgs-cancelDeletion` and the job, which cancels a deletion that
 * a legal hold now stops.
 */
export async function clearDeletion(db: Firestore, orgId: string, by: { uid: string; now: Date; requestId?: string }) {
  const orgRef = db.doc(`orgs/${orgId}`);
  return db.runTransaction(async (tx) => {
    const [org, tombstone] = await tx.getAll(orgRef, db.doc(deletedOrgPath(orgId)));
    if (tombstone?.exists) {
      throw new DomainError('FAILED_PRECONDITION', 'The deletion has already started', { reason: 'deletion_started' });
    }
    const scheduled = toDate(org?.get('deletionScheduledAt'));
    if (!org?.exists || !scheduled) return null;
    tx.update(orgRef, {
      deletionScheduledAt: FieldValue.delete(),
      deletionRequestedBy: FieldValue.delete(),
      deletionRequestedAt: FieldValue.delete(),
      updatedAt: by.now,
      updatedBy: by.uid,
      ...(by.requestId ? { _requestId: by.requestId } : {}),
    });
    return { scheduled, org: org.data() as Data };
  });
}

/**
 * `orgs-cancelDeletion` (SEC-05; owners): cancels the scheduled deletion while the grace period
 * lasts, and tells every member. Nothing scheduled answers `cancelled: false`. Audited as
 * `org.deletion_cancelled`.
 */
export const cancelDeletionDefinition = {
  name: ORG_DELETION_CALLABLES.cancel,
  input: CancelOrgDeletionInput,
  roles: ['owner'],
  idempotent: true,
  handler: async (ctx): Promise<{ cancelled: boolean }> => {
    const { orgId, uid, db, clock, log, ports } = ctx;
    const cleared = await clearDeletion(db, orgId, { uid, now: clock.now(), requestId: ctx.requestId });
    if (!cleared) return { cancelled: false };
    await noticeToMembers({ db, orgId, clock, log, ports }, await activeMemberUids(db, orgId), {
      title: `${String(cleared.org['name'])} won’t be deleted`,
      body: 'An owner cancelled the deletion. The practice is back to normal.',
      key: `org-deletion-${cleared.scheduled.getTime()}`,
      actor: uid,
    });
    await audit(ctx, {
      action: 'org.deletion_cancelled',
      entity: { path: deletionAuditPath(orgId) },
      summary: 'Practice deletion cancelled',
      data: { deletionScheduledAt: cleared.scheduled.toISOString() },
    });
    log.info('org deletion cancelled');
    return { cancelled: true };
  },
} satisfies CallableDefinition<typeof CancelOrgDeletionInput, { cancelled: boolean }>;

export const requestDeletion = defineCallable(requestDeletionDefinition);
export const cancelDeletion = defineCallable(cancelDeletionDefinition);
