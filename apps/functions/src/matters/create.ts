import type { Firestore } from 'firebase-admin/firestore';
import type { z } from 'zod';

import {
  can,
  CreateMatterInput,
  DEFAULT_MATTER_NUMBER_FORMAT,
  DEFAULT_ORG_TIMEZONE,
  DomainError,
  formatMatterNumber,
  initialMatterStatus,
  Matter,
  matterCounterId,
  MatterNumber,
  matterNumberKey,
  matterNumberYear,
  Party,
  PERMISSIONS,
  type CreateMatterResult,
  type FieldErrors,
  type PartyRole,
  type Role,
} from '@materia/domain';

import { contactNames, counterPath, liveContactIds, matterNumberPath, mattersPath, matterSearch } from './shared';
import { audit } from '../audit/audit';
import { conflictChecksPath } from '../conflicts/shared';
import { compact } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';

type MatterInput = z.output<typeof CreateMatterInput>['matter'];

/** Numbers skipped past (already taken) before giving up: only a pathological format change gets near it. */
export const MAX_NUMBER_SKIPS = 100;
/** Parallel creates contend on the year's counter; the transaction retries this many times. */
export const CREATE_MAX_ATTEMPTS = 50;

/** Party rows a new matter gets: its clients, plus the deceased and the testator when given. */
export function initialParties(matter: MatterInput): { contactId: string; role: PartyRole }[] {
  const rows = [
    ...matter.clientContactIds.map((contactId) => ({ contactId, role: 'client' as const })),
    ...(matter.deceased ? [{ contactId: matter.deceased.contactId, role: 'deceased' as const }] : []),
    ...(matter.testator ? [{ contactId: matter.testator.contactId, role: 'testator' as const }] : []),
  ];
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.role}|${row.contactId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Checks what the matter references: live contacts (clients, deceased, testator, referrer) and
 * active members (responsible and team). Throws INVALID_ARGUMENT with field paths.
 */
async function checkReferences(db: Firestore, orgId: string, role: Role, matter: MatterInput): Promise<void> {
  const fields: FieldErrors = {};
  const contactRefs: [path: string, id: string][] = [
    ...matter.clientContactIds.map((id, i): [string, string] => [`matter.clientContactIds.${i}`, id]),
    ...(matter.deceased ? [['matter.deceased.contactId', matter.deceased.contactId] as [string, string]] : []),
    ...(matter.testator ? [['matter.testator.contactId', matter.testator.contactId] as [string, string]] : []),
    ...(matter.referrerContactId ? [['matter.referrerContactId', matter.referrerContactId] as [string, string]] : []),
  ];
  const live = await liveContactIds(
    db,
    orgId,
    contactRefs.map(([, id]) => id),
  );
  for (const [path, id] of contactRefs) if (!live.has(id)) fields[path] = ['Choose an existing contact'];

  const uids = [...new Set([matter.responsibleUid, ...matter.teamUids])];
  const members = await db.getAll(...uids.map((uid) => db.doc(`orgs/${orgId}/members/${uid}`)));
  const active = new Set(members.filter((m) => m.exists && m.get('status') === 'active').map((m) => m.id));
  if (!active.has(matter.responsibleUid)) fields['matter.responsibleUid'] = ['Choose an active team member'];
  matter.teamUids.forEach((uid, i) => {
    if (!active.has(uid)) fields[`matter.teamUids.${i}`] = ['Choose an active team member'];
  });
  if (Object.keys(fields).length) throw new DomainError('INVALID_ARGUMENT', 'Invalid matter', { fields });
  // Whoever creates a privileged matter must be able to see it.
  if (matter.privileged && !can(role, 'privileged.view')) {
    throw new DomainError('PERMISSION_DENIED', 'Your role cannot create privileged matters');
  }
}

type ConflictCheckInput = MatterInput['conflictCheck'];

/**
 * The conflict check a new matter is stored with (CORE-02). `pending` keeps only `resultId`. Any
 * other status is a determination made at intake: it needs `conflict.determine`
 * (PERMISSION_DENIED, `details.reason: 'conflict_determine_required'`), a reason for `potential`
 * and `conflict`, and a `resultId` (when given) naming a check run for a new matter. The server
 * stamps `checkedAt` and `checkedBy`; whatever the client sent for them is ignored.
 */
export async function intakeConflictCheck(
  db: Firestore,
  orgId: string,
  uid: string,
  role: Role,
  input: ConflictCheckInput,
  now: Date,
): Promise<{ conflictCheck: ConflictCheckInput; determined: boolean }> {
  const resultId = input.resultId;
  if (resultId) {
    const check = await db.doc(`${conflictChecksPath(orgId)}/${resultId}`).get();
    if (!check.exists || check.get('excludeMatterId')) {
      throw new DomainError('INVALID_ARGUMENT', 'Invalid conflict check', {
        fields: { 'matter.conflictCheck.resultId': ['Run the conflict check for this matter again'] },
      });
    }
  }
  if (input.status === 'pending')
    return { conflictCheck: { status: 'pending', ...(resultId ? { resultId } : {}) }, determined: false };
  if (!can(role, 'conflict.determine')) {
    throw new DomainError('PERMISSION_DENIED', 'Your role cannot record a conflict determination', {
      reason: 'conflict_determine_required',
    });
  }
  const reason = input.reason?.trim() || undefined;
  if (input.status !== 'clear' && !reason) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid matter', {
      fields: { 'matter.conflictCheck.reason': ['Give a reason for a potential conflict or a conflict'] },
    });
  }
  return {
    conflictCheck: {
      status: input.status,
      checkedAt: now,
      checkedBy: uid,
      ...(resultId ? { resultId } : {}),
      ...(reason ? { reason } : {}),
    },
    determined: true,
  };
}

/**
 * `matters-createMatter` (CORE-03, `matter.create`). In one transaction: takes the next number from
 * `orgs/{orgId}/counters/matter-{YYYY}` (the year in the org's time zone), skips any number already
 * reserved in `matterNumbers` or held by an existing matter (a format change mid-year, or a migrated
 * matter, can't cause a duplicate), and writes the counter, the reservation, the matter (status
 * `lead`, or `open` when the conflict check is already clear or potential, see intakeConflictCheck) and its client, deceased and testator
 * party rows. `templateId` is stored but not applied yet (templates are CORE-07). A migrated matter
 * keeps its `externalRef` and still gets a new number. Idempotent on `requestId`.
 */
export const createMatterDefinition = {
  name: 'matters-createMatter',
  input: CreateMatterInput,
  roles: PERMISSIONS['matter.create'],
  idempotent: true,
  handler: async (ctx): Promise<CreateMatterResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const matter = input.matter;
    await checkReferences(db, orgId, role, matter);

    const clock = await orgClock(db, orgId, ctx.clock);
    const now = clock.now();
    const org = (await db.doc(`orgs/${orgId}`).get()).data() ?? {};
    const timeZone = typeof org['timezone'] === 'string' && org['timezone'] ? org['timezone'] : DEFAULT_ORG_TIMEZONE;
    const format =
      typeof org['matterNumberFormat'] === 'string' && org['matterNumberFormat']
        ? org['matterNumberFormat']
        : DEFAULT_MATTER_NUMBER_FORMAT;
    const year = matterNumberYear(now, timeZone);
    const intake = await intakeConflictCheck(db, orgId, uid, role, matter.conflictCheck, now);
    const status = initialMatterStatus(intake.conflictCheck.status);
    const names = await contactNames(db, orgId, [
      ...matter.clientContactIds,
      ...(matter.deceased ? [matter.deceased.contactId] : []),
    ]);
    const counterMeta = { createdAt: now, createdBy: uid, updatedAt: now, updatedBy: uid };
    const meta = { ...counterMeta, _requestId: requestId };
    const matterRef = db.collection(mattersPath(orgId)).doc();
    const counterRef = db.doc(counterPath(orgId, matterCounterId(year)));

    const number = await db.runTransaction(
      async (tx) => {
        const counter = await tx.get(counterRef);
        const stored = Number(counter.get('next'));
        let seq = Number.isInteger(stored) && stored >= 1 ? stored : 1;
        let candidate = '';
        for (let skipped = 0; ; skipped++) {
          if (skipped >= MAX_NUMBER_SKIPS) {
            throw new DomainError('CONFLICT', 'No free matter number; check the number format', { year });
          }
          candidate = formatMatterNumber(format, year, seq);
          const [reserved, held] = await Promise.all([
            tx.get(db.doc(matterNumberPath(orgId, matterNumberKey(candidate)))),
            tx.get(db.collection(mattersPath(orgId)).where('number', '==', candidate).limit(1)),
          ]);
          if (!reserved.exists && held.empty) break;
          seq++;
        }

        if (counter.exists) tx.update(counterRef, { next: seq + 1, updatedAt: now, updatedBy: uid });
        else tx.create(counterRef, { next: seq + 1, ...counterMeta, schemaVersion: 1 });
        tx.create(
          db.doc(matterNumberPath(orgId, matterNumberKey(candidate))),
          MatterNumber.schema.parse({
            number: candidate,
            matterId: matterRef.id,
            year,
            ...counterMeta,
            schemaVersion: 1,
          }),
        );
        const data = Matter.schema.parse(
          compact({
            ...matter,
            conflictCheck: intake.conflictCheck,
            number: candidate,
            status,
            search: matterSearch({ ...matter, number: candidate }, names),
            lastActivityAt: now,
            openTaskCount: 0,
            wipCents: 0,
            recomputeVersion: 0,
            // Live matters carry deletedAt: null so lists can filter on it (CORE-03).
            deletedAt: null,
            ...meta,
            schemaVersion: Matter.version,
          }),
        );
        tx.create(matterRef, data);
        for (const party of initialParties(matter)) {
          tx.create(
            db.doc(`${matterRef.path}/parties/${party.role}-${party.contactId}`),
            Party.schema.parse({
              ...party,
              addedFrom: 'manual',
              orgId,
              matterId: matterRef.id,
              ...meta,
              schemaVersion: Party.version,
            }),
          );
        }
        return candidate;
      },
      { maxAttempts: CREATE_MAX_ATTEMPTS },
    );

    await audit(
      { uid, orgId, requestId, db, clock },
      {
        action: 'matter.created',
        entity: { path: matterRef.path },
        summary: `Matter ${matterRef.id} created as ${status}`,
        data: { number, status, type: matter.type, year },
      },
    );
    if (intake.determined) {
      const reason = intake.conflictCheck.reason;
      await audit(
        { uid, orgId, requestId, db, clock },
        {
          action: 'matter.conflict_determined',
          entity: { path: matterRef.path },
          summary: `Conflict check determined ${intake.conflictCheck.status} at intake of matter ${matterRef.id}`,
          data: {
            status: intake.conflictCheck.status,
            previousStatus: 'pending',
            atIntake: true,
            ...(intake.conflictCheck.resultId ? { checkId: intake.conflictCheck.resultId } : {}),
            ...(reason ? { reason } : {}),
          },
        },
      );
    }
    log.info('matter created', { matterId: matterRef.id, status, year });
    return { matterId: matterRef.id, number, status };
  },
} satisfies CallableDefinition<typeof CreateMatterInput, CreateMatterResult>;

export const createMatter = defineCallable(createMatterDefinition);
