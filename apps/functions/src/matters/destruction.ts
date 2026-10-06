import { createHash } from 'node:crypto';

import { FieldValue, type CollectionReference, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as z from 'zod';

import {
  ApproveDestructionInput,
  dateOnlyAt,
  DESTRUCTION_REAUTH_MINUTES,
  DestructionCertificate,
  destructionCertificateId,
  DestructionCertificateUrlInput,
  DestructionRequest,
  DomainError,
  dueForDestruction,
  PERMISSIONS,
  today as todayIn,
  type ApproveDestructionResult,
  type DateOnly,
  type DestructionCertificateUrlResult,
  type DestructionCounts,
  type DestructionStage,
  type MatterType,
} from '@materia/domain';

import { readRetentionSettings, type RetentionSettings } from './closing';
import { destructionRequestPath } from './reopen';
import { matterPath, mattersPath } from './shared';
import { audit } from '../audit/audit';
import { REGION } from '../config';
import { isDeleted } from '../contacts/shared';
import { adminDb } from '../core/admin';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { isEnabled, requireFlag } from '../core/flags';
import { createLog, functionsSink, type Log } from '../core/log';
import { defineQueue } from '../core/tasks';
import { filesBucket, storageFiles, type FileStore } from '../documents/files';
import type { Clock } from '../ports';
import { systemClock } from '../ports/container';
import { matterTrustDoc } from '../trust/shared';

/*
 * Retention destruction (CORE-19), behind the `matters.destruction` flag until a practitioner signs
 * the retention rules off (CORE-19a):
 *
 * 1. `matters-queueDestruction` (monthly) lists each org's matters past `destroyAfter` into
 *    `orgs/{orgId}/destructionQueue/{matterId}` as `pending`.
 * 2. An owner or admin approves one with `matters-approveDestruction`: a recent sign-in and the
 *    matter number typed. That enqueues `matters-destroy`.
 * 3. `matters-destroy` deletes the matter's Storage objects (every generation), replaces the matter
 *    with a tombstone (so triggers leave it alone), deletes every record under it (documents,
 *    chunks, notes, tasks…), its Clerk threads and notifications, then issues the certificate PDF.
 *    Each step records itself on the queue entry, so a retry resumes where it stopped; the
 *    certificate is issued only once everything else is done. Audit entries are kept.
 */

type Data = Record<string, unknown>;

const QUEUE = 'matters-destroy';
const DestroyPayload = z.object({ orgId: z.string().min(1), matterId: z.string().min(1) });

/** Firestore batches hold at most 500 writes; one is the counter update. */
const DELETE_BATCH = 400;

const toDate = (value: unknown): Date | undefined =>
  value && typeof (value as { toDate?: unknown }).toDate === 'function'
    ? (value as { toDate: () => Date }).toDate()
    : value instanceof Date
      ? value
      : undefined;

/** The matter types as the certificate names them (the design system's MatterTag labels). */
const TYPE_NAMES: Readonly<Record<MatterType, string>> = {
  will: 'Will',
  poa: 'Power of attorney',
  probate: 'Probate',
  loa: 'Letters of administration',
  admin: 'Estate administration',
  fp: 'Family provision',
  contest: 'Will dispute',
  trust: 'Testamentary trust',
};

export const certificatePath = (orgId: string, certificateId: string) =>
  `orgs/${orgId}/certificates/${certificateId}.pdf`;

// ---------- 1. the monthly queue ----------

/**
 * Lists one org's matters due for destruction (when its `matters.destruction` flag is on). A
 * matter already queued keeps its entry; one cancelled earlier and due again is queued afresh.
 * Returns the ids queued.
 */
export async function queueOrg(db: Firestore, orgId: string, baseClock: Clock, log: Log): Promise<string[]> {
  const clock = await orgClock(db, orgId, baseClock);
  if (!(await isEnabled({ db, orgId, clock }, 'matters.destruction'))) return [];
  const now = clock.now();
  const settings = await readRetentionSettings(db, orgId);
  const today = todayIn(settings.timeZone, now);
  const candidates = await db.collection(mattersPath(orgId)).where('destroyAfter', '<', today).get();
  const queued: string[] = [];
  for (const matter of candidates.docs) {
    const data = matter.data();
    if (isDeleted(data) || !dueForDestruction(data, today)) continue;
    const ref = db.doc(destructionRequestPath(orgId, matter.id));
    const existing = (await ref.get()).get('status');
    if (existing && existing !== 'cancelled') continue;
    await ref.set(
      DestructionRequest.schema.parse({
        matterId: matter.id,
        number: data['number'],
        ...(typeof data['title'] === 'string' ? { title: data['title'] } : {}),
        type: data['type'],
        ...(toDate(data['closedAt']) ? { closedAt: toDate(data['closedAt']) } : {}),
        destroyAfter: data['destroyAfter'],
        status: 'pending',
        queuedAt: now,
        createdAt: now,
        createdBy: 'system',
        updatedAt: now,
        updatedBy: 'system',
        schemaVersion: DestructionRequest.version,
      }),
    );
    queued.push(matter.id);
  }
  if (queued.length) log.info('matters queued for destruction', { orgId, count: queued.length });
  return queued;
}

export async function queueAllOrgs(db: Firestore, clock: Clock, log: Log) {
  const orgs = await db.collection('orgs').get();
  let queued = 0;
  let failed = 0;
  for (const org of orgs.docs) {
    if (isDeleted(org.data())) continue;
    try {
      queued += (await queueOrg(db, org.id, clock, log)).length;
    } catch (error) {
      failed += 1;
      log.error('destruction queue failed', {
        orgId: org.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return { queued, failed };
}

/** `matters-queueDestruction` (CORE-19): 03:30 Melbourne time on the first of each month. */
export const queueDestruction = onSchedule(
  { schedule: '30 3 1 * *', timeZone: 'Australia/Melbourne', region: REGION, retryCount: 1 },
  async () => {
    const log = createLog({ fn: 'matters-queueDestruction' }, functionsSink);
    log.info('ok', await queueAllOrgs(adminDb(), systemClock, log));
  },
);

// ---------- 2. approval ----------

/**
 * `matters-approveDestruction` (CORE-19, `matter.destroy`: owner and admin, idempotent; the
 * `matters.destruction` flag). Needs a sign-in within DESTRUCTION_REAUTH_MINUTES (REAUTH_REQUIRED)
 * and `confirmation` equal to the matter number (INVALID_ARGUMENT otherwise). The entry must be
 * pending and the matter still due: a matter reopened, held or no longer due is cancelled
 * (FAILED_PRECONDITION, `details.reason: 'not_due'`). Audited as `matter.destruction_approved`.
 */
export const approveDestructionDefinition = {
  name: 'matters-approveDestruction',
  input: ApproveDestructionInput,
  roles: PERMISSIONS['matter.destroy'],
  idempotent: true,
  consumeAppCheckToken: true,
  recentLoginMinutes: DESTRUCTION_REAUTH_MINUTES,
  handler: async (ctx): Promise<ApproveDestructionResult> => {
    const { input, orgId, uid, db, ports, log } = ctx;
    const clock = await orgClock(db, orgId, ctx.clock);
    await requireFlag({ db, orgId, clock }, 'matters.destruction');
    const now = clock.now();
    const settings = await readRetentionSettings(db, orgId);
    const today = todayIn(settings.timeZone, now);
    const requestRef = db.doc(destructionRequestPath(orgId, input.matterId));
    const matterRef = db.doc(matterPath(orgId, input.matterId));

    const number = await db.runTransaction(async (tx) => {
      const [request, matter] = await tx.getAll(requestRef, matterRef);
      if (!request?.exists || !matter?.exists) {
        throw new DomainError('NOT_FOUND', 'That matter isn’t in the destruction queue', { matterId: input.matterId });
      }
      const status = request.get('status');
      if (status !== 'pending') {
        throw new DomainError('FAILED_PRECONDITION', `The destruction is already ${status}`, {
          reason: 'not_pending',
          status,
        });
      }
      const data = matter.data() as Data;
      if (isDeleted(data) || !dueForDestruction(data, today)) {
        tx.update(requestRef, { status: 'cancelled', cancelledReason: 'not_due', updatedAt: now, updatedBy: uid });
        return null;
      }
      const matterNumber = String(data['number'] ?? '');
      if (input.confirmation.trim().toLowerCase() !== matterNumber.toLowerCase()) {
        throw new DomainError('INVALID_ARGUMENT', 'Type the matter number to confirm', {
          fields: { confirmation: [`Type ${matterNumber} to confirm`] },
        });
      }
      tx.update(requestRef, { status: 'approved', approvedBy: uid, approvedAt: now, updatedAt: now, updatedBy: uid });
      return matterNumber;
    });
    if (number === null) {
      throw new DomainError('FAILED_PRECONDITION', 'The matter is no longer due for destruction', {
        reason: 'not_due',
        matterId: input.matterId,
      });
    }

    await ports.tasks.enqueue(
      QUEUE,
      { orgId, matterId: input.matterId },
      { dedupeKey: `destroy:${orgId}:${input.matterId}` },
    );
    await audit(ctx, {
      action: 'matter.destruction_approved',
      entity: { path: matterRef.path },
      summary: `Destruction of matter ${input.matterId} approved`,
      data: { number },
    });
    log.info('destruction approved', { matterId: input.matterId });
    return { matterId: input.matterId, status: 'approved' };
  },
} satisfies CallableDefinition<typeof ApproveDestructionInput, ApproveDestructionResult>;

// ---------- 3. destruction ----------

export interface DestroyDeps {
  db: Firestore;
  files: FileStore;
  clock: Clock;
  log: Log;
}

const STAGES: readonly DestructionStage[] = ['files', 'tombstone', 'records', 'references', 'certificate'];
const after = (stage: DestructionStage | undefined, step: DestructionStage) =>
  stage !== undefined && STAGES.indexOf(stage) >= STAGES.indexOf(step);

/** Deletes a collection and everything under it, adding each deletion to `counts.records` as it commits. */
async function deleteTree(db: Firestore, collection: CollectionReference, counter: DocumentReference): Promise<void> {
  for (;;) {
    const page = await collection.limit(DELETE_BATCH).get();
    if (page.empty) return;
    for (const doc of page.docs) {
      for (const sub of await doc.ref.listCollections()) await deleteTree(db, sub, counter);
    }
    const batch = db.batch();
    for (const doc of page.docs) batch.delete(doc.ref);
    batch.update(counter, { 'counts.records': FieldValue.increment(page.size) });
    await batch.commit();
    if (page.size < DELETE_BATCH) return;
  }
}

/** Keeps the PDF to WinAnsi (the standard fonts): accents dropped, anything else as `?`. */
const pdfText = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?');

export interface CertificateFacts {
  certificateId: string;
  practice: string;
  number: string;
  title?: string | undefined;
  type: MatterType;
  closedOn?: DateOnly | undefined;
  destroyAfter: DateOnly;
  approvedBy: string;
  approvedAt: Date;
  destroyedAt: Date;
  counts: DestructionCounts;
  timeZone: string;
}

/** The destruction certificate: one A4 page, deterministic for the same facts. */
export async function certificatePdf(facts: CertificateFacts): Promise<Uint8Array> {
  // Loaded here, not at module load, so it doesn't slow every function's cold start.
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const at = facts.destroyedAt;
  pdf.setTitle(`Certificate of destruction ${facts.number}`);
  pdf.setProducer('Materia');
  pdf.setCreator('Materia');
  pdf.setCreationDate(at);
  pdf.setModificationDate(at);
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
    page.drawText(pdfText(value), { x: 210, y, size: 11, font: regular, color: rgb(0.1, 0.1, 0.12) });
    y -= 20;
  };
  line('Certificate of destruction', { size: 20, font: bold, gap: 30 });
  line(facts.practice, { size: 12, gap: 32 });
  row('Certificate', facts.certificateId);
  row('Matter number', facts.number);
  if (facts.title) row('Matter title', facts.title);
  row('Matter type', TYPE_NAMES[facts.type] ?? facts.type);
  if (facts.closedOn) row('Closed on', facts.closedOn);
  row('Kept until', facts.destroyAfter);
  row('Approved by', facts.approvedBy);
  row('Approved at', when(facts.approvedAt));
  row('Destroyed at', when(facts.destroyedAt));
  row('Documents', String(facts.counts.documents));
  row('Stored files', String(facts.counts.files));
  row('Records', String(facts.counts.records));
  y -= 12;
  for (const text of [
    "The matter's records, documents and stored files were permanently deleted from Materia after",
    'its retention period, with the approval above. A tombstone with the matter number (and the',
    'title, if the practice keeps titles) and the audit trail are kept.',
    'Backups taken before the destruction may hold copies until they expire: daily backups after',
    '35 days and monthly copies after one year (Security, privacy & compliance: backups).',
  ]) {
    line(text, { size: 10, gap: 15 });
  }
  return pdf.save({ useObjectStreams: false });
}

/**
 * Runs (or resumes) one approved destruction. Every step is safe to repeat; the queue entry's
 * `stage` records the last one finished. Returns the stage reached, or null when there was
 * nothing to do (not approved, or cancelled meanwhile).
 */
export async function destroyMatter(
  deps: DestroyDeps,
  orgId: string,
  matterId: string,
): Promise<DestructionStage | null> {
  const { db, files, log } = deps;
  const requestRef = db.doc(destructionRequestPath(orgId, matterId));
  const matterRef = db.doc(matterPath(orgId, matterId));
  const request = (await requestRef.get()).data() as Data | undefined;
  const status = request?.['status'];
  if (status === 'destroyed') return 'certificate';
  if (status !== 'approved' && status !== 'destroying') {
    log.info('destruction skipped', { matterId, status: typeof status === 'string' ? status : null });
    return null;
  }
  const approvedBy = String(request?.['approvedBy'] ?? 'system');
  const approvedAt = toDate(request?.['approvedAt']) ?? deps.clock.now();
  let stage = request?.['stage'] as DestructionStage | undefined;
  const settings: RetentionSettings = await readRetentionSettings(db, orgId);
  const mark = async (next: DestructionStage, extra: Data = {}) => {
    await requestRef.update({ stage: next, ...extra, updatedAt: deps.clock.now(), updatedBy: 'system' });
    stage = next;
  };

  const matter = (await matterRef.get()).data() as Data | undefined;
  if (!matter) throw new Error('The matter is missing');
  if (!matter['destroyedAt']) {
    // A hold placed after the approval wins (matters-setLegalHold cancels the entry, too).
    if ((matter['legalHold'] as { on?: unknown } | undefined)?.on === true) {
      await requestRef.update({
        status: 'cancelled',
        cancelledReason: 'legal_hold',
        updatedAt: deps.clock.now(),
        updatedBy: 'system',
      });
      return null;
    }
  }
  if (status === 'approved') {
    const documents = (await db.collection(`${matterRef.path}/documents`).count().get()).data().count;
    await requestRef.update({
      status: 'destroying',
      counts: { files: 0, documents, records: 0 },
      error: FieldValue.delete(),
      updatedAt: deps.clock.now(),
      updatedBy: 'system',
    });
  }

  const destroyedAt = toDate(matter['destroyedAt']) ?? deps.clock.now();
  const certificateId = destructionCertificateId(matterId);

  if (!after(stage, 'files')) {
    const purged = await files.purge(`${matterRef.path}/`);
    await mark('files', { 'counts.files': FieldValue.increment(purged) });
  }
  if (!after(stage, 'tombstone')) {
    if (!matter['destroyedAt']) {
      await matterRef.set({
        number: matter['number'],
        ...(settings.keepsTitle && typeof matter['title'] === 'string' ? { title: matter['title'] } : {}),
        type: matter['type'],
        status: matter['status'],
        privileged: matter['privileged'] === true,
        ...(matter['closedAt'] ? { closedAt: matter['closedAt'] } : {}),
        destroyAfter: matter['destroyAfter'],
        destroyedAt,
        destroyedBy: approvedBy,
        certificateId,
        deletedAt: destroyedAt,
        deletedBy: approvedBy,
        ...(matter['createdAt'] ? { createdAt: matter['createdAt'] } : {}),
        ...(matter['createdBy'] ? { createdBy: matter['createdBy'] } : {}),
        updatedAt: destroyedAt,
        updatedBy: 'system',
        schemaVersion: matter['schemaVersion'] ?? 1,
      });
    }
    await mark('tombstone');
  }
  if (!after(stage, 'records')) {
    for (const collection of await matterRef.listCollections()) await deleteTree(db, collection, requestRef);
    await mark('records');
  }
  if (!after(stage, 'references')) {
    // Outside the matter: its Clerk threads (and their messages), its notifications and its trust
    // record (BILL-11).
    const [threads, notifications, trust] = await Promise.all([
      db.collection(`orgs/${orgId}/clerkThreads`).where('matterId', '==', matterId).get(),
      db.collection(`orgs/${orgId}/notifications`).where('matterId', '==', matterId).get(),
      matterTrustDoc(db, orgId, matterId).get(),
    ]);
    for (const thread of threads.docs) {
      for (const sub of await thread.ref.listCollections()) await deleteTree(db, sub, requestRef);
    }
    const refs = [...threads.docs, ...notifications.docs, ...(trust.exists ? [trust] : [])].map((doc) => doc.ref);
    for (let start = 0; start < refs.length; start += DELETE_BATCH) {
      const batch = db.batch();
      const chunk = refs.slice(start, start + DELETE_BATCH);
      for (const ref of chunk) batch.delete(ref);
      batch.update(requestRef, { 'counts.records': FieldValue.increment(chunk.length) });
      await batch.commit();
    }
    await mark('references');
  }

  // The certificate, only now that everything else is gone.
  const current = (await requestRef.get()).data() as Data;
  const counts = current['counts'] as DestructionCounts;
  const [org, approver] = await db.getAll(db.doc(`orgs/${orgId}`), db.doc(`orgs/${orgId}/members/${approvedBy}`));
  const closedAt = toDate(matter['closedAt']);
  const title = settings.keepsTitle && typeof matter['title'] === 'string' ? matter['title'] : undefined;
  const bytes = await certificatePdf({
    certificateId,
    practice: String(org?.get('name') ?? orgId),
    number: String(matter['number']),
    title,
    type: matter['type'] as MatterType,
    closedOn: closedAt ? dateOnlyAt(closedAt, settings.timeZone) : undefined,
    destroyAfter: matter['destroyAfter'] as DateOnly,
    approvedBy: String(approver?.get('displayName') ?? approvedBy),
    approvedAt,
    destroyedAt,
    counts,
    timeZone: settings.timeZone,
  });
  const storagePath = certificatePath(orgId, certificateId);
  const written = await files.write(storagePath, bytes, {
    contentType: 'application/pdf',
    disposition: `attachment; filename="certificate-of-destruction-${certificateId}.pdf"`,
  });
  // A retry finds its own earlier PDF: hash what is stored.
  const stored = written === 'exists' ? ((await files.read(storagePath)) ?? Buffer.from(bytes)) : Buffer.from(bytes);
  const sha256 = createHash('sha256').update(stored).digest('hex');
  const now = deps.clock.now();
  const batch = db.batch();
  batch.set(
    db.doc(`orgs/${orgId}/destructionCertificates/${certificateId}`),
    DestructionCertificate.schema.parse({
      matterId,
      number: matter['number'],
      ...(title ? { title } : {}),
      type: matter['type'],
      ...(closedAt ? { closedAt } : {}),
      destroyAfter: matter['destroyAfter'],
      approvedBy,
      approvedAt,
      destroyedAt,
      counts,
      storagePath,
      sha256,
      createdAt: now,
      createdBy: 'system',
      updatedAt: now,
      updatedBy: 'system',
      schemaVersion: DestructionCertificate.version,
    }),
  );
  batch.update(requestRef, {
    status: 'destroyed',
    stage: 'certificate',
    certificateId,
    destroyedAt,
    ...(title ? {} : { title: FieldValue.delete() }),
    updatedAt: now,
    updatedBy: 'system',
  });
  await batch.commit();

  await audit(
    { uid: approvedBy, orgId, requestId: `destroy-${matterId}`, db, clock: deps.clock },
    {
      action: 'matter.destroyed',
      entity: { path: matterRef.path },
      summary: `Matter ${matterId} destroyed; certificate ${certificateId}`,
      data: { certificateId, ...counts },
    },
  );
  log.info('matter destroyed', { matterId, certificateId, ...counts });
  return 'certificate';
}

/** `matters-destroy` (CORE-19): the Cloud Tasks queue `matters-approveDestruction` feeds. */
export const destroy = defineQueue({
  name: QUEUE,
  input: DestroyPayload,
  retry: { maxAttempts: 5, minBackoffSeconds: 30, maxBackoffSeconds: 600 },
  rateLimits: { maxConcurrentDispatches: 2 },
  timeoutSeconds: 540,
  memory: '512MiB',
  handler: async (input, { db, log }) => {
    try {
      await destroyMatter({ db, files: storageFiles(), clock: systemClock, log }, input.orgId, input.matterId);
    } catch (error) {
      await db
        .doc(destructionRequestPath(input.orgId, input.matterId))
        .update({ error: error instanceof Error ? error.name.slice(0, 200) : 'Error' })
        .catch(() => undefined);
      throw error;
    }
  },
});

// ---------- certificates ----------

/** How long a certificate download link lasts. */
export const CERTIFICATE_URL_TTL_SECONDS = 300;

/**
 * `matters-destructionCertificateUrl` (CORE-19, `matter.destroy`): a 5-minute signed link to a
 * destruction certificate's PDF.
 */
export function destructionCertificateUrlDefinition(bucket: () => string = filesBucket) {
  return {
    name: 'matters-destructionCertificateUrl',
    input: DestructionCertificateUrlInput,
    roles: PERMISSIONS['matter.destroy'],
    handler: async ({ input, orgId, db, clock, ports }) => {
      const certificate = await db.doc(`orgs/${orgId}/destructionCertificates/${input.certificateId}`).get();
      const storagePath = certificate.get('storagePath');
      if (!certificate.exists || typeof storagePath !== 'string') {
        throw new DomainError('NOT_FOUND', 'Certificate not found', { certificateId: input.certificateId });
      }
      const expiresAt = new Date(clock.now().getTime() + CERTIFICATE_URL_TTL_SECONDS * 1000);
      const url = await ports.signedUrls.sign({
        bucket: bucket(),
        path: storagePath,
        expiresAt,
        disposition: `attachment; filename="certificate-of-destruction-${input.certificateId}.pdf"`,
        contentType: 'application/pdf',
      });
      return { url, expiresAt: expiresAt.toISOString() };
    },
  } satisfies CallableDefinition<typeof DestructionCertificateUrlInput, DestructionCertificateUrlResult>;
}

export const approveDestruction = defineCallable(approveDestructionDefinition);
export const destructionCertificateUrl = defineCallable(destructionCertificateUrlDefinition());
