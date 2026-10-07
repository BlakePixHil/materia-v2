import { createHash, randomUUID } from 'node:crypto';

import type { Auth } from 'firebase-admin/auth';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as z from 'zod';

import {
  dateOnlyAt,
  DeletedOrg,
  DocIdSchema,
  OAUTH_PROVIDER_INFO,
  OAUTH_PROVIDERS,
  ORG_DELETION_GRACE_DAYS,
  ORG_PURGE_QUEUE,
  ORG_PURGE_STAGES,
  orgDeletionCertificateId,
  orgDeletionCertificatePath,
  validTimeZone,
  type OAuthProvider,
  type OrgPurgeCounts,
  type OrgPurgeStage,
} from '@materia/domain';

import { syncClaims } from './claims';
import {
  activeMemberUids,
  clearDeletion,
  deletedOrgPath,
  deletionAuditPath,
  deletionBlocker,
  noticeToMembers,
} from './deletion';
import { appUrl } from './shared';
import { audit } from '../audit/audit';
import { REGION } from '../config';
import { adminApp, adminDb } from '../core/admin';
import { createLog, errorReportFields, type Log } from '../core/log';
import { defineQueue } from '../core/tasks';
import { storageFiles, type FileStore } from '../documents/files';
import { OAUTH_SECRETS } from '../integrations/providers';
import { removeConnection } from '../integrations/vault';
import type { Clock, Ports } from '../ports';
import { ports, systemClock } from '../ports/container';

/**
 * Deleting a practice once its grace period is over (SEC-05, ADR-058): `orgs-purgeDeletedOrgs`
 * runs daily and queues each practice whose `deletionScheduledAt` has passed on `orgs-purge`,
 * which takes it apart a step per task (ORG_PURGE_STAGES), each safe to repeat:
 *
 * 1. `marked`: checks again (a legal hold placed meanwhile cancels the deletion and tells the
 *    owners; an export still being written postpones it an hour), then writes the server-only
 *    tombstone `deletedOrgs/{orgId}` (status `purging`). From then on nothing can cancel it, and
 *    triggers and queued tasks for the practice are skipped (core/purge-guard.ts). The next step
 *    waits two minutes, so every instance has seen the tombstone.
 * 2. `integrations`: every connection's token revoked at its provider (INT-01) and deleted.
 * 3. `storage`: every stored file under `orgs/{orgId}/`, every generation.
 * 4. `firestore`: the org document and everything under it (records, chunks, audit, jobs).
 * 5. `users`: each member's saved views, recent matters, drafts and timer for the practice, and
 *    their claims recomputed (other practices' memberships stay). Ten minutes before the next step,
 *    for anything in flight to land.
 * 6. `verified`: deletes anything that arrived since (and counts it), then checks nothing is left.
 * 7. `certificate`: the deletion certificate (PDF, `deletedOrgs/{orgId}/{certificateId}.pdf`),
 *    emailed to the owners; the tombstone keeps the practice's id, name, deletion time and
 *    certificate id.
 */

type Data = Record<string, unknown>;

/** User-level collections that hold records of one practice (`orgId`), removed with it. */
export const USER_ORG_COLLECTIONS = ['timer', 'recent', 'views', 'drafts'] as const;

const MARKED_DELAY_MS = 2 * 60_000;
const SETTLE_DELAY_MS = 10 * 60_000;
const POSTPONE_MS = 60 * 60_000;

const toDate = (value: unknown): Date | null =>
  value instanceof Date ? value : ((value as { toDate?: () => Date } | null | undefined)?.toDate?.() ?? null);

export interface PurgeDeps {
  db: Firestore;
  files: FileStore;
  clock: Clock;
  log: Log;
  ports: Pick<Ports, 'tasks' | 'mail' | 'oauth' | 'oauthKms'>;
  auth: () => Auth;
  /** Deletes a document or collection and everything under it; returns how many documents went. */
  deleteTree?: (path: string) => Promise<number>;
}

/** What a step did, and when the next should run. */
export interface PurgeStep {
  /** The step done, or why nothing was. */
  outcome: OrgPurgeStage | 'not_due' | 'gone' | 'blocked' | 'postponed' | 'deleted';
  /** Run again after this long (null: finished, or nothing to do). */
  nextInMs: number | null;
}

/** Firestore's recursive delete, counting documents. */
export function firestoreDeleteTree(db: Firestore) {
  return async (path: string): Promise<number> => {
    const writer = db.bulkWriter();
    let deleted = 0;
    writer.onWriteResult(() => {
      deleted++;
    });
    const ref = path.split('/').length % 2 === 0 ? db.doc(path) : db.collection(path);
    await db.recursiveDelete(ref, writer);
    await writer.close();
    return deleted;
  };
}

const nextStage = (stage: OrgPurgeStage): OrgPurgeStage | null =>
  ORG_PURGE_STAGES[ORG_PURGE_STAGES.indexOf(stage) + 1] ?? null;

/** Marks the practice for deletion (the tombstone), after checking again. */
async function mark(deps: PurgeDeps, orgId: string): Promise<PurgeStep> {
  const { db, clock, log } = deps;
  const orgRef = db.doc(`orgs/${orgId}`);
  const org = (await orgRef.get()).data();
  if (!org) return { outcome: 'gone', nextInMs: null };
  const scheduledFor = toDate(org['deletionScheduledAt']);
  const now = clock.now();
  if (!scheduledFor || scheduledFor.getTime() > now.getTime()) return { outcome: 'not_due', nextInMs: null };

  const blocker = await deletionBlocker(db, orgId, now);
  if (blocker?.code === 'EXPORT_RUNNING') {
    log.info('org deletion postponed: an export is being written', { jobId: blocker.jobId ?? null });
    return { outcome: 'postponed', nextInMs: POSTPONE_MS };
  }
  if (blocker?.code === 'LEGAL_HOLD') {
    // A hold placed during the grace period stops the deletion; the owners decide what next.
    const cleared = await clearDeletion(db, orgId, { uid: 'system', now });
    if (cleared) {
      await noticeToMembers({ db, orgId, clock, log, ports: deps.ports }, await activeMemberUids(db, orgId, 'owner'), {
        title: `${String(org['name'])} wasn’t deleted: a legal hold is on`,
        body: 'The deletion was cancelled because a legal hold was placed. Release the hold and ask again to delete the practice.',
        key: `org-deletion-${scheduledFor.getTime()}`,
      });
      await audit(
        { uid: 'system', orgId, requestId: `org-purge-${orgId}`, db, clock },
        {
          action: 'org.deletion_blocked',
          entity: { path: deletionAuditPath(orgId) },
          summary: 'Practice deletion cancelled: a legal hold is on',
          data: { reason: 'legal_hold', ...(blocker.matterId ? { matterId: blocker.matterId } : {}) },
        },
      );
    }
    log.warn('org deletion blocked by a legal hold');
    return { outcome: 'blocked', nextInMs: null };
  }

  const members = await db.collection(`orgs/${orgId}/members`).get();
  const ownerUids = members.docs
    .filter((doc) => doc.get('role') === 'owner' && doc.get('status') === 'active')
    .map((doc) => doc.id);
  const requestedBy = String(org['deletionRequestedBy'] ?? ownerUids[0] ?? 'system');
  const requester = members.docs.find((doc) => doc.id === requestedBy);
  const certificateId = orgDeletionCertificateId(
    createHash('sha256').update(`${orgId}:${now.toISOString()}:${randomUUID()}`).digest('hex'),
  );
  const tombstone = DeletedOrg.schema.parse({
    orgId,
    name: String(org['name'] ?? orgId),
    status: 'purging',
    stage: 'marked',
    requestedBy,
    ...(requester?.get('displayName') ? { requestedByName: String(requester.get('displayName')).slice(0, 200) } : {}),
    requestedAt: toDate(org['deletionRequestedAt']) ?? scheduledFor,
    scheduledFor,
    purgeStartedAt: now,
    certificateId,
    timeZone: validTimeZone(org['timezone'] as string | undefined),
    ownerUids,
    memberUids: members.docs.map((doc) => doc.id),
    counts: { records: 0, files: 0, integrations: 0, members: 0 },
    createdAt: now,
    createdBy: 'system',
    updatedAt: now,
    updatedBy: 'system',
    schemaVersion: DeletedOrg.version,
  });
  const marked = await db.runTransaction(async (tx) => {
    const [current, existing] = await tx.getAll(orgRef, db.doc(deletedOrgPath(orgId)));
    if (existing?.exists) return true;
    // Cancelled between the checks and now: nothing to do.
    if (!toDate(current?.get('deletionScheduledAt'))) return false;
    tx.create(db.doc(deletedOrgPath(orgId)), tombstone);
    return true;
  });
  if (!marked) return { outcome: 'not_due', nextInMs: null };
  log.info('org deletion started', { members: tombstone.memberUids?.length ?? 0 });
  return { outcome: 'marked', nextInMs: MARKED_DELAY_MS };
}

/** Revokes and deletes every connection of the practice (INT-01). Best effort per connection. */
async function revokeIntegrations(deps: PurgeDeps, orgId: string): Promise<number> {
  const snapshot = await deps.db.collection(`orgs/${orgId}/integrations`).get();
  let revoked = 0;
  for (const doc of snapshot.docs) {
    const provider = doc.get('provider') as OAuthProvider;
    if (!(OAUTH_PROVIDERS as readonly string[]).includes(provider)) continue;
    const level = OAUTH_PROVIDER_INFO[provider].level;
    const uid = level === 'user' ? (doc.get('uid') as string | null) : null;
    try {
      const result = await removeConnection(
        { orgId, db: deps.db, clock: deps.clock, log: deps.log, ports: deps.ports },
        { provider, uid },
        { actor: 'system', reason: 'disconnected' },
      );
      if (result.removed) revoked++;
    } catch (error) {
      deps.log.warn('org purge: connection not revoked', { provider, ...errorReportFields(error) });
    }
  }
  return revoked;
}

/** Removes the practice from one person: its records in their own collections, and their claims. */
async function releaseMember(deps: PurgeDeps, orgId: string, uid: string): Promise<void> {
  const { db, clock, log } = deps;
  for (const collection of USER_ORG_COLLECTIONS) {
    const snap = await db.collection(`users/${uid}/${collection}`).where('orgId', '==', orgId).get();
    if (snap.empty) continue;
    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
  }
  try {
    await syncClaims({ db, auth: deps.auth(), now: clock.now() }, uid, { alsoOrgIds: [orgId] });
  } catch (error) {
    // No Auth account any more: just drop the practice from their profile, if there is one.
    log.warn('org purge: claims not synced', errorReportFields(error));
    const user = db.doc(`users/${uid}`);
    if ((await user.get()).exists) {
      await user.update({
        orgIds: FieldValue.arrayRemove(orgId),
        [`memberships.${orgId}`]: FieldValue.delete(),
        ...((await user.get()).get('activeOrgId') === orgId ? { activeOrgId: null } : {}),
      });
    }
  }
}

const pdfText = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e]/g, '?');

export interface DeletionCertificateFacts {
  certificateId: string;
  orgId: string;
  name: string;
  requestedBy: string;
  requestedAt: Date;
  scheduledFor: Date;
  purgeStartedAt: Date;
  deletedAt: Date;
  counts: OrgPurgeCounts;
  timeZone: string;
}

/** The certificate of deletion (one A4 page, standard fonts). */
export async function deletionCertificatePdf(facts: DeletionCertificateFacts): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Certificate of deletion ${facts.certificateId}`);
  pdf.setProducer('Materia');
  pdf.setCreator('Materia');
  pdf.setCreationDate(facts.deletedAt);
  pdf.setModificationDate(facts.deletedAt);
  const page = pdf.addPage([595.28, 841.89]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const when = (date: Date) =>
    `${dateOnlyAt(date, facts.timeZone)} ${new Intl.DateTimeFormat('en-AU', {
      timeZone: facts.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date)} (${facts.timeZone})`;
  let y = 780;
  const line = (text: string, options: { size?: number; font?: typeof regular; gap?: number } = {}) => {
    const size = options.size ?? 11;
    page.drawText(pdfText(text), { x: 56, y, size, font: options.font ?? regular, color: rgb(0.1, 0.1, 0.12) });
    y -= options.gap ?? size + 8;
  };
  const row = (label: string, value: string) => {
    page.drawText(pdfText(label), { x: 56, y, size: 10, font: bold, color: rgb(0.35, 0.35, 0.4) });
    page.drawText(pdfText(value), { x: 230, y, size: 11, font: regular, color: rgb(0.1, 0.1, 0.12) });
    y -= 20;
  };
  line('Certificate of deletion', { size: 20, font: bold, gap: 30 });
  line(facts.name, { size: 12, gap: 32 });
  row('Certificate', facts.certificateId);
  row('Practice id', facts.orgId);
  row('Deletion requested by', facts.requestedBy);
  row('Requested at', when(facts.requestedAt));
  row('Grace period ended', when(facts.scheduledFor));
  row('Deletion started', when(facts.purgeStartedAt));
  row('Deletion completed', when(facts.deletedAt));
  row('Records deleted', String(facts.counts.records));
  row('Stored files deleted', String(facts.counts.files));
  row('Connections revoked', String(facts.counts.integrations));
  row('Memberships removed', String(facts.counts.members));
  y -= 12;
  for (const text of [
    `An owner asked for this practice to be deleted, and after a ${ORG_DELETION_GRACE_DAYS}-day grace period Materia permanently`,
    'deleted its records, documents and every version of its stored files, its audit trail, its search',
    'index and its connections (tokens revoked with Microsoft, Google and Xero). Every member lost access',
    'and their sign-in claims for the practice were removed; memberships of other practices are unchanged.',
    "Materia keeps only a tombstone: the practice's id, its name, when it was deleted and this certificate.",
    '',
    'Backups taken before the deletion are not edited: their copies expire on the schedule in the retention',
    'policy (SEC-03): point-in-time recovery after 7 days, daily backups after 7 days, daily exports and the',
    'nightly file copy after 35 days, weekly backups after 14 weeks, monthly exports after 400 days (about',
    '13 months), deleted files after 30 days and replaced file versions after 90 days. Every copy has gone',
    'within about 13 months. Backups are never restored into the live service for a deleted practice.',
  ]) {
    line(text, { size: 10, gap: 15 });
  }
  return pdf.save({ useObjectStreams: false });
}

/** The certificate's email to each owner, with the PDF attached (the `notification` template). */
async function emailCertificate(deps: PurgeDeps, tomb: DeletedOrg, bytes: Uint8Array): Promise<number> {
  const { db, log } = deps;
  let sent = 0;
  for (const uid of tomb.ownerUids) {
    const user = await db.doc(`users/${uid}`).get();
    let email = user.get('email') as string | undefined;
    if (!email)
      email = (
        await deps
          .auth()
          .getUser(uid)
          .catch(() => undefined)
      )?.email;
    if (!email || user.get('emailDeliverability.status') === 'undeliverable') continue;
    try {
      await deps.ports.mail.send({
        to: email,
        template: 'notification',
        model: {
          title: `${tomb.name} has been deleted`,
          body: `The practice and everything in it were deleted from Materia. The certificate of deletion (${tomb.certificateId}) is attached; keep it with your records.`,
          link: appUrl(),
          settingsLink: `${appUrl()}/settings`,
          kindLabel: 'practice deletion notices',
          critical: false,
        },
        attachments: [
          { name: `Certificate of deletion ${tomb.certificateId}.pdf`, contentType: 'application/pdf', content: bytes },
        ],
        idempotencyKey: `org-deleted-${tomb.orgId}-${uid}`,
      });
      sent++;
    } catch (error) {
      if ((error as { failure?: string }).failure === 'not_configured') {
        log.warn('org purge: mail not configured; certificate kept in storage');
        continue;
      }
      throw error;
    }
  }
  return sent;
}

/**
 * Runs the next step of a practice's deletion (or starts it). Returns what it did and when to run
 * the next step.
 */
export async function purgeOrg(deps: PurgeDeps, orgId: string): Promise<PurgeStep> {
  const { db, files, clock, log } = deps;
  const tombRef = db.doc(deletedOrgPath(orgId));
  const snap = await tombRef.get();
  if (!snap.exists) return mark(deps, orgId);
  const tomb = DeletedOrg.schema.parse(fromStored(snap.data() as Data));
  if (tomb.status === 'deleted') return { outcome: 'deleted', nextInMs: null };
  const stage = nextStage(tomb.stage);
  if (!stage) return { outcome: 'deleted', nextInMs: null };
  const deleteTree = deps.deleteTree ?? firestoreDeleteTree(db);
  const done = async (extra: Data = {}) =>
    tombRef.update({ stage, ...extra, updatedAt: clock.now(), updatedBy: 'system' });

  switch (stage) {
    case 'integrations': {
      const revoked = await revokeIntegrations(deps, orgId);
      await done({ 'counts.integrations': revoked });
      log.info('org purge: connections revoked', { revoked });
      return { outcome: stage, nextInMs: 0 };
    }
    case 'storage': {
      const removed = await files.purge(`orgs/${orgId}/`);
      await done({ 'counts.files': removed });
      log.info('org purge: files deleted', { files: removed });
      return { outcome: stage, nextInMs: 0 };
    }
    case 'firestore': {
      // A collection at a time, counting as it goes, so a retry after a timeout keeps its count.
      for (const collection of await db.doc(`orgs/${orgId}`).listCollections()) {
        const deleted = await deleteTree(collection.path);
        await tombRef.update({ 'counts.records': FieldValue.increment(deleted), updatedAt: clock.now() });
      }
      const rest = await deleteTree(`orgs/${orgId}`);
      await done({ 'counts.records': FieldValue.increment(rest) });
      log.info('org purge: records deleted');
      return { outcome: stage, nextInMs: 0 };
    }
    case 'users': {
      const uids = tomb.memberUids ?? [];
      for (const uid of uids) await releaseMember(deps, orgId, uid);
      await done({ 'counts.members': uids.length });
      log.info('org purge: members released', { members: uids.length });
      return { outcome: stage, nextInMs: SETTLE_DELAY_MS };
    }
    case 'verified': {
      const records = await deleteTree(`orgs/${orgId}`);
      const removed = await files.purge(`orgs/${orgId}/`);
      if (records || removed) log.warn('org purge: deleted late arrivals', { records, files: removed });
      const left =
        (await db.doc(`orgs/${orgId}`).listCollections()).length +
        (await files.list(`orgs/${orgId}/`, `orgs/${orgId}/**`)).length;
      if (left) throw new Error('Records or files remain after the deletion');
      await done({
        'counts.records': FieldValue.increment(records),
        'counts.files': FieldValue.increment(removed),
      });
      return { outcome: stage, nextInMs: 0 };
    }
    case 'certificate': {
      const deletedAt = clock.now();
      const facts: DeletionCertificateFacts = {
        certificateId: tomb.certificateId,
        orgId,
        name: tomb.name,
        requestedBy: tomb.requestedByName ?? tomb.requestedBy,
        requestedAt: tomb.requestedAt,
        scheduledFor: tomb.scheduledFor,
        purgeStartedAt: tomb.purgeStartedAt,
        deletedAt,
        counts: tomb.counts,
        timeZone: validTimeZone(tomb.timeZone),
      };
      const storagePath = orgDeletionCertificatePath(orgId, tomb.certificateId);
      const bytes = await deletionCertificatePdf(facts);
      const written = await files.write(storagePath, bytes, {
        contentType: 'application/pdf',
        disposition: `attachment; filename="certificate-of-deletion-${tomb.certificateId}.pdf"`,
      });
      // A retry finds its own earlier PDF: send and hash what is stored.
      const stored =
        written === 'exists' ? ((await files.read(storagePath)) ?? Buffer.from(bytes)) : Buffer.from(bytes);
      const sha256 = createHash('sha256').update(stored).digest('hex');
      const emailed = await emailCertificate(deps, tomb, stored);
      await done({
        status: 'deleted',
        deletedAt: written === 'exists' ? (tomb.deletedAt ?? deletedAt) : deletedAt,
        certificate: { storagePath, sha256 },
        memberUids: FieldValue.delete(),
      });
      log.info('org deleted', { certificateId: tomb.certificateId, emailed, ...tomb.counts });
      return { outcome: stage, nextInMs: null };
    }
    default:
      return { outcome: stage, nextInMs: null };
  }
}

/** Firestore Timestamps back to Dates (the tombstone is parsed with its schema). */
function fromStored(value: unknown): unknown {
  const date = toDate(value);
  if (date && !(value instanceof Date)) return date;
  if (Array.isArray(value)) return value.map(fromStored);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromStored(v)]));
  }
  return value;
}

export const PurgeTask = z.object({ orgId: DocIdSchema });

/** `orgs-purge` (SEC-05): one step of a practice's deletion per task, then the next one queued. */
export const purge = defineQueue({
  name: ORG_PURGE_QUEUE,
  input: PurgeTask,
  retry: { maxAttempts: 10, minBackoffSeconds: 60, maxBackoffSeconds: 3600 },
  rateLimits: { maxConcurrentDispatches: 2 },
  secrets: OAUTH_SECRETS,
  timeoutSeconds: 1800,
  memory: '1GiB',
  handler: async ({ orgId }, ctx) => {
    const clock = ctx.ports.clock;
    const step = await purgeOrg(
      { db: ctx.db, files: storageFiles(), clock, log: ctx.log, ports: ctx.ports, auth: () => getAuth(adminApp()) },
      orgId,
    );
    if (step.nextInMs === null) return;
    const at = clock.now().getTime() + step.nextInMs;
    await ctx.ports.tasks.enqueue(
      ORG_PURGE_QUEUE,
      { orgId },
      {
        dedupeKey: `purge-${orgId}-${step.outcome}${step.outcome === 'postponed' ? `-${Math.floor(at / POSTPONE_MS)}` : ''}`,
        ...(step.nextInMs > 0 ? { scheduleTime: new Date(at) } : {}),
      },
    );
  },
});

export interface PurgeSweepDeps {
  db: Firestore;
  clock: Clock;
  log: Log;
  ports: Pick<Ports, 'tasks'>;
}

/**
 * Queues the deletion of every practice whose grace period has ended, and resumes any deletion
 * that stopped part way (a tombstone still `purging`). Returns how many were queued.
 */
export async function queueDueDeletions(deps: PurgeSweepDeps): Promise<{ due: number; resumed: number }> {
  const { db, clock, ports: p } = deps;
  const now = clock.now();
  const day = dateOnlyAt(now, 'UTC');
  const due = await db.collection('orgs').where('deletionScheduledAt', '<=', now).get();
  for (const org of due.docs) {
    await p.tasks.enqueue(ORG_PURGE_QUEUE, { orgId: org.id }, { dedupeKey: `purge-${org.id}-start-${day}` });
  }
  const stuck = await db.collection('deletedOrgs').where('status', '==', 'purging').get();
  for (const tomb of stuck.docs) {
    await p.tasks.enqueue(ORG_PURGE_QUEUE, { orgId: tomb.id }, { dedupeKey: `purge-${tomb.id}-resume-${day}` });
  }
  return { due: due.size, resumed: stuck.size };
}

/** `orgs-purgeDeletedOrgs` (SEC-05): daily at 02:30 Melbourne time. */
export const purgeDeletedOrgs = onSchedule(
  { schedule: '30 2 * * *', timeZone: 'Australia/Melbourne', region: REGION, retryCount: 1 },
  async () => {
    const log = createLog({ fn: 'orgs-purgeDeletedOrgs' });
    log.info('ok', { ...(await queueDueDeletions({ db: adminDb(), clock: systemClock, log, ports: ports() })) });
  },
);
