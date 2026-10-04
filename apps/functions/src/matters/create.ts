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
  systemTemplate,
  systemTemplateId,
  today,
  type CreateMatterResult,
  type FieldErrors,
  type PartyRole,
  type Role,
  type Template,
} from '@materia/domain';

import { contactNames, counterPath, liveContactIds, matterNumberPath, mattersPath, matterSearch } from './shared';
import { audit } from '../audit/audit';
import { conflictChecksPath } from '../conflicts/shared';
import { compact } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { isEnabled } from '../core/flags';
import { firstActiveParalegal, planTemplateTasks, readTemplate, readWith, templatesPath } from '../templates/shared';

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

/**
 * The template a new matter gets with `templates.system` on (CORE-07): the one the input names
 * (`templateId`, at `templateVersion` or its latest published version; INVALID_ARGUMENT on
 * `matter.templateId` when unknown or for another type), else the org's most recently published
 * template of the type, else the type's system template.
 */
export async function templateForNewMatter(db: Firestore, orgId: string, matter: MatterInput): Promise<Template> {
  if (matter.templateId) {
    const named = await readTemplate(db, readWith(), orgId, matter.templateId, matter.templateVersion);
    if (!named || named.matterType !== matter.type) {
      throw new DomainError('INVALID_ARGUMENT', 'Invalid matter', {
        fields: { 'matter.templateId': ['Choose a published template for this matter type'] },
      });
    }
    return named;
  }
  const org = await db.collection(templatesPath(orgId)).where('matterType', '==', matter.type).get();
  const millis = (value: unknown) => (value as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
  const latest = org.docs
    .filter((doc) => doc.get('source') === 'org' && doc.get('published') === true && Number(doc.get('version')) >= 1)
    .sort((a, b) => millis(b.get('publishedAt')) - millis(a.get('publishedAt')) || a.id.localeCompare(b.id))[0];
  const override = latest
    ? await readTemplate(db, readWith(), orgId, latest.id, Number(latest.get('version')))
    : undefined;
  return override ?? (systemTemplate(systemTemplateId(matter.type)) as Template);
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
 * party rows. With `templates.system` on (CORE-07) the matter also gets its template version
 * (`templateForNewMatter`), starts in the template's first stage (or the input's stage when the
 * template has it) and gets that stage's tasks plus later tasks whose anchor (a date of death) is
 * known, all in the same transaction; with it off, `templateId` is only stored. A migrated matter
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

    // Templates (CORE-07): resolved and planned before the transaction, written inside it.
    const template = (await isEnabled({ orgId, db, clock: ctx.clock }, 'templates.system'))
      ? await templateForNewMatter(db, orgId, matter)
      : undefined;
    const templated = template
      ? (() => {
          const stageId =
            matter.stageId && template.stages.some((stage) => stage.id === matter.stageId)
              ? matter.stageId
              : (template.stages[0]?.id as string);
          return { stageId, stageEnteredOn: today(timeZone, now) };
        })()
      : undefined;
    const templateTasks =
      template && templated
        ? planTemplateTasks(
            template,
            { matter, events: [] },
            {
              orgId,
              matterId: matterRef.id,
              stageId: templated.stageId,
              stageEnteredOn: templated.stageEnteredOn,
              knownAnchors: true,
              responsibleUid: matter.responsibleUid,
              paralegalUid: await firstActiveParalegal(db, orgId),
              uid,
              now,
              requestId,
            },
          )
        : [];

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
            ...(template && templated
              ? { templateId: template.id, templateVersion: template.version, ...templated }
              : {}),
            openTaskCount: templateTasks.length,
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
        for (const task of templateTasks) tx.create(db.doc(task.path), task.data);
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
        data: {
          number,
          status,
          type: matter.type,
          year,
          ...(template
            ? { templateId: template.id, templateVersion: template.version, tasks: templateTasks.length }
            : {}),
        },
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
