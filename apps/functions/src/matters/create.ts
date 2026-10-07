import type { Firestore } from 'firebase-admin/firestore';
import type { z } from 'zod';

import {
  can,
  CreateMatterInput,
  dateOfDeathProblem,
  DEATH_CERTIFICATE_TASK_KEY,
  DEATH_CERTIFICATE_TASK_TITLE,
  DEFAULT_MATTER_NUMBER_FORMAT,
  DEFAULT_ORG_TIMEZONE,
  DomainError,
  formatMatterNumber,
  initialCostsDisclosure,
  isDateOnly,
  initialMatterStatus,
  Matter,
  matterCounterId,
  MatterNumber,
  matterNumberKey,
  matterNumberYear,
  matterTypeCode,
  MatterEvent,
  Party,
  partyDocId,
  PERMISSIONS,
  systemTemplate,
  systemTemplateId,
  Task,
  templateTaskDocId,
  today,
  type AnchorEvent,
  type CreateMatterResult,
  type DateOnly,
  type FieldErrors,
  type MatterType,
  type PartyRole,
  type Role,
  type Template,
} from '@materia/domain';

import { thankYouTaskData, thankYouTaskPath, thankYouTaskTitle } from './referral';
import { contactNames, counterPath, liveContactIds, matterNumberPath, mattersPath, matterSearch } from './shared';
import { audit } from '../audit/audit';
import { conflictChecksPath } from '../conflicts/shared';
import { compact, isLive } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { isEnabled } from '../core/flags';
import { recomputeMatter } from '../deadlines/recompute';
import {
  firstActiveParalegal,
  planTemplateTasks,
  readTemplate,
  readWith,
  templatesPath,
  type PlannedTask,
} from '../templates/shared';

type Input = z.output<typeof CreateMatterInput>;
type MatterInput = Input['matter'];
type PartyRow = { contactId: string; role: PartyRole; share?: string | undefined; notes?: string | undefined };
type EventRow = { kind: AnchorEvent['kind']; date: DateOnly; label?: string | undefined };

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
 * Every party row a new matter gets (CORE-05): `initialParties` plus the input's `parties`, one row
 * per `partyDocId(role, contactId)`; a repeated row keeps the first `share` and `notes` given.
 * `inputIndex` is the row's index in `input.parties` (for field errors), when it came from there.
 */
export function intakeParties(
  matter: MatterInput,
  extra: readonly PartyRow[] = [],
): (PartyRow & { inputIndex?: number })[] {
  const rows = new Map<string, PartyRow & { inputIndex?: number }>();
  for (const row of initialParties(matter)) rows.set(partyDocId(row.role, row.contactId), { ...row });
  extra.forEach((row, inputIndex) => {
    const id = partyDocId(row.role, row.contactId);
    const existing = rows.get(id);
    if (!existing) {
      rows.set(id, compact({ ...row, inputIndex }));
      return;
    }
    if (existing.share === undefined && row.share !== undefined) existing.share = row.share;
    if (existing.notes === undefined && row.notes !== undefined) existing.notes = row.notes;
  });
  return [...rows.values()];
}

/**
 * The events a new matter gets: the input's (one per kind, date and label), plus the date of death
 * event from `deceased.dateOfDeath` when known and not listed. A listed date of death event must
 * match `deceased.dateOfDeath` (INVALID_ARGUMENT on `events.{i}.date`).
 */
export function intakeEvents(matter: MatterInput, events: readonly EventRow[] = []): EventRow[] {
  const dateOfDeath = matter.deceased?.dateOfDeath;
  const fields: FieldErrors = {};
  events.forEach((event, i) => {
    if (event.kind !== 'date_of_death') return;
    if (!dateOfDeath) fields[`events.${i}.date`] = ['Record the date of death on the deceased first'];
    else if (event.date !== dateOfDeath) fields[`events.${i}.date`] = ['Must match the date of death'];
  });
  if (Object.keys(fields).length) throw new DomainError('INVALID_ARGUMENT', 'Invalid matter', { fields });
  const seen = new Set<string>();
  const rows = events.filter((event) => {
    const key = `${event.kind}|${event.date}|${event.label ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (dateOfDeath && !rows.some((event) => event.kind === 'date_of_death')) {
    rows.unshift({ kind: 'date_of_death', date: dateOfDeath, label: 'Date of death' });
  }
  return rows;
}

/**
 * The fee and costs disclosure a new matter is stored with: the top-level `fee`/`costsDisclosure`
 * (CORE-05) over `matter.fee`/`matter.costsDisclosure`. The disclosure is assessed from the
 * jurisdiction's rules and the fee's estimate (BILL-06, `initialCostsDisclosure`): asked-for
 * `required` stands, a `not_required` the estimate doesn't allow is INVALID_ARGUMENT on
 * `costsDisclosure.status`, and `waived` needs its reason and a lawyer or above (PERMISSION_DENIED).
 * A legacy `matter.costsDisclosure` already sent keeps its status and date.
 */
export function intakeFeeAndDisclosure(
  input: Input,
  options: { role: Role; uid: string; now: Date; today: DateOnly },
): Pick<Matter, 'fee' | 'costsDisclosure'> {
  const fee = (input.fee ?? input.matter.fee) as Matter['fee'] | undefined;
  if (!fee) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid matter', { fields: { fee: ['Choose a fee arrangement'] } });
  }
  const legacy = input.costsDisclosure ? undefined : input.matter.costsDisclosure;
  const requested = input.costsDisclosure?.status ?? legacy?.status;
  const waiver = input.costsDisclosure?.waiver ?? legacy?.waiver;
  if (requested === 'waived') {
    if (!waiver) {
      throw new DomainError('INVALID_ARGUMENT', 'Invalid matter', {
        fields: { 'costsDisclosure.waiver.reason': ['Choose why no disclosure is needed'] },
      });
    }
    if (!can(options.role, 'matter.fee')) {
      throw new DomainError('PERMISSION_DENIED', 'Only a lawyer can record that no costs disclosure is needed', {
        reason: 'disclosure_waiver_role',
      });
    }
  }
  const assessed = initialCostsDisclosure({
    jurisdiction: input.matter.jurisdiction,
    fee,
    requested:
      requested === 'required' || requested === 'not_required' || requested === 'waived' ? requested : undefined,
    waiver: waiver ? { reason: waiver.reason, ...(waiver.note ? { note: waiver.note } : {}) } : undefined,
    uid: options.uid,
    now: options.now,
    today: options.today,
  });
  if (requested === 'not_required' && assessed.status !== 'not_required') {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid matter', {
      fields: { 'costsDisclosure.status': ['This estimate needs a costs disclosure'] },
    });
  }
  // Matters created outside intake (a migration, say) with a disclosure already given keep it.
  const costsDisclosure =
    legacy && (legacy.status === 'sent' || legacy.status === 'updated')
      ? { ...assessed, status: legacy.status, ...(legacy.sentOn ? { sentOn: legacy.sentOn } : {}) }
      : assessed;
  if (costsDisclosure.status !== 'required') delete costsDisclosure.requiredSince;
  return { fee: { ...fee, history: fee.history ?? [] }, costsDisclosure };
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
  // CORE-18: a referrer contact or a referral source, never both.
  if (matter.referrerContactId && matter.referralSource) {
    fields['matter.referralSource'] = ['Choose a referrer or a source, not both'];
  }

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
 * A known date of death must not be after the org's today, nor before the deceased contact's date
 * of birth (CORE-05). INVALID_ARGUMENT on `matter.deceased.dateOfDeath`.
 */
async function checkDateOfDeath(db: Firestore, orgId: string, matter: MatterInput, orgToday: DateOnly): Promise<void> {
  const dateOfDeath = matter.deceased?.dateOfDeath;
  if (!matter.deceased || !dateOfDeath) return;
  const contact = await db.doc(`orgs/${orgId}/contacts/${matter.deceased.contactId}`).get();
  const dob = contact.get('dateOfBirth');
  const problem = dateOfDeathProblem(dateOfDeath, { dateOfBirth: isDateOnly(dob) ? dob : undefined, today: orgToday });
  if (problem) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid matter', {
      fields: { 'matter.deceased.dateOfDeath': [problem] },
    });
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
 *
 * CORE-05 intake: the same transaction also writes the input's `parties` (deduplicated with the
 * matter's own rows), its `events` plus the date of death event, the fee and costs disclosure
 * (`intakeFeeAndDisclosure`), the conflict check link (`conflictCheckId`), a death certificate task
 * when the date of death is unknown, and the CORE-10 deadline hook's documents. Any failure in the
 * transaction (an unknown party contact, say) leaves nothing written.
 */
export const createMatterDefinition = {
  name: 'matters-createMatter',
  input: CreateMatterInput,
  roles: PERMISSIONS['matter.create'],
  idempotent: true,
  handler: async (ctx): Promise<CreateMatterResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const clock = await orgClock(db, orgId, ctx.clock);
    const now = clock.now();
    const org = (await db.doc(`orgs/${orgId}`).get()).data() ?? {};
    const timeZone = typeof org['timezone'] === 'string' && org['timezone'] ? org['timezone'] : DEFAULT_ORG_TIMEZONE;
    const orgToday = today(timeZone, now);
    const { fee, costsDisclosure } = intakeFeeAndDisclosure(input, { role, uid, now, today: orgToday });
    const resultId = input.conflictCheckId ?? input.matter.conflictCheck.resultId;
    const matter: MatterInput = {
      ...input.matter,
      fee,
      costsDisclosure,
      conflictCheck: { ...input.matter.conflictCheck, ...(resultId ? { resultId } : {}) },
    };
    await checkReferences(db, orgId, role, matter);

    const format =
      typeof org['matterNumberFormat'] === 'string' && org['matterNumberFormat']
        ? org['matterNumberFormat']
        : DEFAULT_MATTER_NUMBER_FORMAT;
    const year = matterNumberYear(now, timeZone);
    const typeCode = matterTypeCode(
      matter.type,
      org['matterTypeCodes'] && typeof org['matterTypeCodes'] === 'object'
        ? (org['matterTypeCodes'] as Partial<Record<MatterType, string>>)
        : undefined,
    );
    await checkDateOfDeath(db, orgId, matter, orgToday);
    const events = intakeEvents(matter, input.events);
    const parties = intakeParties(matter, input.parties);
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
          return { stageId, stageEnteredOn: orgToday };
        })()
      : undefined;
    const needsDeathCertificate = !!matter.deceased && !matter.deceased.dateOfDeath;
    const paralegalUid = template || needsDeathCertificate ? await firstActiveParalegal(db, orgId) : undefined;
    const tasks: PlannedTask[] =
      template && templated
        ? planTemplateTasks(
            template,
            { matter, events },
            {
              orgId,
              matterId: matterRef.id,
              stageId: templated.stageId,
              stageEnteredOn: templated.stageEnteredOn,
              knownAnchors: true,
              responsibleUid: matter.responsibleUid,
              paralegalUid,
              uid,
              now,
              requestId,
            },
          )
        : [];
    // Unknown date of death (CORE-05): exactly one death certificate task, the template's when it
    // has one (same id, `tpl-obtain_death_certificate`, so a later template apply won't add another).
    const deathCertificatePath = `${matterRef.path}/tasks/${templateTaskDocId(DEATH_CERTIFICATE_TASK_KEY)}`;
    const deathCertificateTask = needsDeathCertificate && !tasks.some((task) => task.path === deathCertificatePath);
    if (deathCertificateTask) {
      tasks.push({
        path: deathCertificatePath,
        data: Task.schema.parse({
          title: DEATH_CERTIFICATE_TASK_TITLE,
          status: 'todo',
          priority: 'high',
          assigneeUid: paralegalUid ?? matter.responsibleUid,
          group: 'Intake',
          checklist: [],
          order: 0,
          source: 'manual',
          templateTaskKey: DEATH_CERTIFICATE_TASK_KEY,
          // Counted in the matter's openTaskCount below (CORE-08: tasks-onWrite leaves it alone).
          countedOpen: true,
          orgId,
          matterId: matterRef.id,
          ...meta,
          schemaVersion: Task.version,
        }) as Record<string, unknown>,
      });
    }
    // CORE-18: a referred matter that opens now gets a "Thank referrer" task when the org asks for it.
    const thankYouTitle = status === 'open' ? await thankYouTaskTitle(db, orgId, org, matter) : undefined;
    if (thankYouTitle) {
      tasks.push({
        path: thankYouTaskPath(orgId, matterRef.id),
        data: thankYouTaskData({
          orgId,
          matterId: matterRef.id,
          title: thankYouTitle,
          assigneeUid: matter.responsibleUid,
          openedOn: orgToday,
          uid,
          now,
          requestId,
        }),
      });
    }
    // Party contacts beyond the matter's own (checked above): read in the transaction, refused there.
    const extraContactIds = [
      ...new Set(parties.filter((party) => party.inputIndex !== undefined).map((party) => party.contactId)),
    ];

    // Attempts at the numbering transaction, logged: more than one means it contended for the
    // year's counter (SEC-07; one transaction per org is fine at 5 creates a second).
    let attempts = 0;
    const number = await db.runTransaction(
      async (tx) => {
        attempts++;
        const contactSnaps = extraContactIds.length
          ? await tx.getAll(...extraContactIds.map((id) => db.doc(`orgs/${orgId}/contacts/${id}`)))
          : [];
        const liveContacts = new Set(
          contactSnaps.filter((snap) => snap.exists && isLive(snap.data())).map((snap) => snap.id),
        );
        const counter = await tx.get(counterRef);
        const stored = Number(counter.get('next'));
        let seq = Number.isInteger(stored) && stored >= 1 ? stored : 1;
        let candidate = '';
        for (let skipped = 0; ; skipped++) {
          if (skipped >= MAX_NUMBER_SKIPS) {
            throw new DomainError('CONFLICT', 'No free matter number; check the number format', { year });
          }
          candidate = formatMatterNumber(format, year, seq, typeCode);
          const [reserved, held] = await Promise.all([
            tx.get(db.doc(matterNumberPath(orgId, matterNumberKey(candidate)))),
            tx.get(db.collection(mattersPath(orgId)).where('number', '==', candidate).limit(1)),
          ]);
          if (!reserved.exists && held.empty) break;
          seq++;
        }

        // Writes are buffered until commit: anything thrown from here on leaves nothing behind (no
        // counter step, no reservation, no matter), which the rollback integration test proves.
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
            openTaskCount: tasks.length,
            wipCents: 0,
            recomputeVersion: 0,
            // Live matters carry deletedAt: null so lists can filter on it (CORE-03).
            deletedAt: null,
            ...meta,
            schemaVersion: Matter.version,
          }),
        );
        tx.create(matterRef, data);
        const badParties: FieldErrors = {};
        for (const { inputIndex, ...party } of parties) {
          if (inputIndex !== undefined && !liveContacts.has(party.contactId)) {
            badParties[`parties.${inputIndex}.contactId`] = ['Choose an existing contact'];
            continue;
          }
          tx.create(
            db.doc(`${matterRef.path}/parties/${partyDocId(party.role, party.contactId)}`),
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
        if (Object.keys(badParties).length) {
          throw new DomainError('INVALID_ARGUMENT', 'Invalid matter', { fields: badParties });
        }
        for (const event of events) {
          tx.create(
            db.collection(`${matterRef.path}/events`).doc(),
            MatterEvent.schema.parse({
              ...event,
              meta: {},
              // A copy of the matter's flag (CORE-10b).
              privileged: data.privileged,
              ...meta,
              schemaVersion: MatterEvent.version,
            }),
          );
        }
        for (const task of tasks) tx.create(db.doc(task.path), task.data);
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
          parties: parties.length,
          events: events.length,
          costsDisclosure: costsDisclosure.status,
          ...(costsDisclosure.waiver ? { disclosureWaiver: costsDisclosure.waiver.reason } : {}),
          ...(deathCertificateTask ? { deathCertificateTask: true } : {}),
          ...(thankYouTitle ? { referrerThankYouTask: true } : {}),
          ...(template
            ? {
                templateId: template.id,
                templateVersion: template.version,
                tasks: tasks.length - (deathCertificateTask ? 1 : 0) - (thankYouTitle ? 1 : 0),
              }
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
    // CORE-10: the new matter's deadlines, from its events and the latest rule set. Best effort: the
    // matter exists either way, and recording an event or running deadlines-recompute catches up.
    let deadlines = 0;
    try {
      deadlines = (
        await recomputeMatter(db, {
          orgId,
          matterId: matterRef.id,
          uid,
          role,
          requestId,
          cause: 'matter_created',
          clock,
          ports: ctx.ports,
          log,
        })
      ).created.length;
    } catch (error) {
      log.error('deadline recompute after create failed', {
        matterId: matterRef.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
    log.info('matter created', {
      attempts,
      deadlines,
      matterId: matterRef.id,
      status,
      year,
      parties: parties.length,
      events: events.length,
    });
    return { matterId: matterRef.id, number, status };
  },
} satisfies CallableDefinition<typeof CreateMatterInput, CreateMatterResult>;

export const createMatter = defineCallable(createMatterDefinition);
