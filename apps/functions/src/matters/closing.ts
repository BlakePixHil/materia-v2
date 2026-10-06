import { FieldValue, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';

import {
  can,
  CloseMatterInput,
  ClosingChecklistInput,
  DomainError,
  evaluateClosing,
  isMinorOn,
  MATTER_TRANSITIONS,
  OPEN_TASK_STATUSES,
  PERMISSIONS,
  retentionFor,
  validTimeZone,
  dateOnlyAt,
  DEFAULT_RETENTION_YEARS,
  type ClosingChecklistResult,
  type ClosingCounts,
  type ClosingWarning,
  type CloseMatterResult,
  type DateOnly,
  type MatterType,
  type Role,
} from '@materia/domain';

import { matterPath, writableMatter } from './shared';
import { audit } from '../audit/audit';
import { isDeleted, stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';

/*
 * Closing a matter (CORE-19): `matters-closingChecklist` shows the checklist as it stands, and
 * `matters-close` checks it again in a transaction, cancels the open tasks if asked, stops the
 * deadline reminders and sets `destroyAfter` from the org's retention policy.
 */

type Data = Record<string, unknown>;

/** Deadlines that still need doing: closing waits until each is done, waived, missed or superseded. */
const UNRESOLVED_DEADLINE_STATUSES = ['upcoming', 'blocked'];
/** Related matters still in play: closing warns about them. */
const ACTIVE_STATUSES = new Set(['lead', 'open', 'on_hold']);

/** The org's retention settings: time zone, years and whether tombstones keep titles. */
export interface RetentionSettings {
  timeZone: string;
  retentionYears: number;
  keepsTitle: boolean;
}

export function retentionSettings(org: Data | undefined): RetentionSettings {
  const years = org?.['retentionYears'];
  return {
    timeZone: validTimeZone(typeof org?.['timezone'] === 'string' ? org['timezone'] : undefined),
    retentionYears:
      typeof years === 'number' && Number.isInteger(years) && years >= 1 ? years : DEFAULT_RETENTION_YEARS,
    keepsTitle: org?.['destructionKeepsTitle'] === true,
  };
}

export async function readRetentionSettings(db: Firestore, orgId: string): Promise<RetentionSettings> {
  return retentionSettings((await db.doc(`orgs/${orgId}`).get()).data());
}

type Reader = Pick<Transaction, 'get' | 'getAll'>;

/** Reads outside a transaction, through the same interface. */
export const directReader = (db: Firestore): Reader =>
  ({
    get: (target: { get(): Promise<unknown> }) => target.get(),
    getAll: (...refs: DocumentReference[]) => db.getAll(...refs),
  }) as unknown as Reader;

/** What closing reads under the matter: unresolved deadlines, open tasks and live parties. */
export interface ClosingReads {
  counts: ClosingCounts;
  openTasks: DocumentReference[];
  /** Deadlines with a reminder still scheduled (cleared on closing). */
  reminding: DocumentReference[];
  /** Whether a live party is under 18 on `on`. */
  hasMinor: boolean;
}

export async function readClosing(
  db: Firestore,
  reader: Reader,
  orgId: string,
  matterId: string,
  on: DateOnly,
): Promise<ClosingReads> {
  const base = matterPath(orgId, matterId);
  const [deadlines, tasks, reminding, parties] = await Promise.all([
    reader.get(db.collection(`${base}/deadlines`).where('status', 'in', UNRESOLVED_DEADLINE_STATUSES)),
    reader.get(db.collection(`${base}/tasks`).where('status', 'in', [...OPEN_TASK_STATUSES])),
    reader.get(db.collection(`${base}/deadlines`).where('nextReminderAt', '>', new Date(0))),
    reader.get(db.collection(`${base}/parties`)),
  ]);
  const live = <T extends { data(): Data | undefined }>(docs: T[]) => docs.filter((doc) => !isDeleted(doc.data()));
  const contactIds = [
    ...new Set(
      live(parties.docs)
        .filter((party) => party.data()?.['role'] !== 'deceased')
        .map((party) => party.data()?.['contactId'])
        .filter((id): id is string => typeof id === 'string' && !!id),
    ),
  ];
  const contacts = contactIds.length
    ? await reader.getAll(...contactIds.map((id) => db.doc(`orgs/${orgId}/contacts/${id}`)))
    : [];
  const hasMinor = contacts.some((contact) => {
    const dob = contact.get('dateOfBirth');
    return typeof dob === 'string' && !contact.get('dateOfDeath') && isMinorOn(dob as DateOnly, on);
  });
  const openTasks = live(tasks.docs);
  return {
    counts: { upcomingDeadlines: live(deadlines.docs).length, openTasks: openTasks.length },
    openTasks: openTasks.map((task) => task.ref),
    reminding: reminding.docs.map((doc) => doc.ref),
    hasMinor,
  };
}

/** Open related matters (a will dispute about this estate): closing goes ahead, with a warning. */
export async function relatedOpenWarnings(
  db: Firestore,
  orgId: string,
  role: Role,
  matter: Data,
): Promise<ClosingWarning[]> {
  const ids = Array.isArray(matter['relatedMatterIds']) ? (matter['relatedMatterIds'] as string[]) : [];
  if (!ids.length) return [];
  const snaps = await db.getAll(...ids.map((id) => db.doc(matterPath(orgId, id))));
  return snaps
    .filter((snap) => {
      const data = snap.data();
      return (
        !!data &&
        !isDeleted(data) &&
        ACTIVE_STATUSES.has(data['status'] as string) &&
        (data['privileged'] !== true || can(role, 'privileged.view'))
      );
    })
    .map((snap) => ({ kind: 'related_open', matterId: snap.id, number: String(snap.get('number') ?? snap.id) }));
}

const legalHoldOn = (matter: Data) => (matter['legalHold'] as { on?: unknown } | undefined)?.on === true;

/**
 * `matters-closingChecklist` (`matter.close`): the closing checklist for the answers so far, the
 * destruction date closing would set (or why there is none), and warnings. Reads only.
 */
export const closingChecklistDefinition = {
  name: 'matters-closingChecklist',
  input: ClosingChecklistInput,
  roles: PERMISSIONS['matter.close'],
  handler: async (ctx): Promise<ClosingChecklistResult> => {
    const { input, orgId, role, db } = ctx;
    const clock = await orgClock(db, orgId, ctx.clock);
    const settings = await readRetentionSettings(db, orgId);
    const matter = writableMatter(await db.doc(matterPath(orgId, input.matterId)).get(), role, input.matterId);
    const type = matter['type'] as MatterType;
    const closedOn = dateOnlyAt(clock.now(), settings.timeZone);
    const reads = await readClosing(db, directReader(db), orgId, input.matterId, closedOn);
    const evaluation = evaluateClosing(type, reads.counts, input.checklist ?? {}, {
      cancelOpenTasks: input.cancelOpenTasks ?? false,
      overrides: input.checklistOverrides ?? {},
    });
    const retention = retentionFor({
      type,
      closedOn,
      retentionYears: settings.retentionYears,
      originals: input.checklist?.originals,
      hasMinor: reads.hasMinor,
      legalHold: legalHoldOn(matter),
    });
    return {
      ...evaluation,
      ...retention,
      counts: reads.counts,
      warnings: await relatedOpenWarnings(db, orgId, role, matter),
      retentionYears: settings.retentionYears,
    };
  },
} satisfies CallableDefinition<typeof ClosingChecklistInput, ClosingChecklistResult>;

/**
 * `matters-close` (CORE-19, `matter.close`: lawyer and above, idempotent). In one transaction:
 * re-evaluates the checklist (FAILED_PRECONDITION, `details.reason: 'closing_checklist'`,
 * `details.blocking`, when an item is still to do), cancels the open tasks when asked, clears the
 * deadlines' scheduled reminders, and sets status `closed`, `closedAt`, `closeReason`, `closing`
 * and `destroyAfter` (closing day + the org's `retentionYears`, or none for a legal hold, a minor,
 * or a will or POA whose originals are in safe custody). Audited as `matter.closed`.
 */
export const closeDefinition = {
  name: 'matters-close',
  input: CloseMatterInput,
  roles: PERMISSIONS['matter.close'],
  idempotent: true,
  handler: async (ctx): Promise<CloseMatterResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const clock = await orgClock(db, orgId, ctx.clock);
    const now = clock.now();
    const settings = await readRetentionSettings(db, orgId);
    const closedOn = dateOnlyAt(now, settings.timeZone);
    const ref = db.doc(matterPath(orgId, input.matterId));
    const overrides = input.checklistOverrides ?? {};

    const outcome = await db.runTransaction(async (tx) => {
      const matter = writableMatter(await tx.get(ref), role, input.matterId);
      const from = matter['status'] as string;
      if (!(MATTER_TRANSITIONS as Record<string, readonly string[]>)[from]?.includes('closed')) {
        throw new DomainError('MATTER_INVALID_TRANSITION', `A ${from} matter can't be closed`, {
          matterId: input.matterId,
          from,
          to: 'closed',
          allowed: [...((MATTER_TRANSITIONS as Record<string, readonly string[]>)[from] ?? [])],
        });
      }
      const type = matter['type'] as MatterType;
      const reads = await readClosing(db, tx, orgId, input.matterId, closedOn);
      const evaluation = evaluateClosing(type, reads.counts, input.checklist, {
        cancelOpenTasks: !!input.cancelOpenTasks,
        overrides,
      });
      if (!evaluation.ready) {
        throw new DomainError('FAILED_PRECONDITION', 'The closing checklist isn’t complete', {
          reason: 'closing_checklist',
          matterId: input.matterId,
          blocking: evaluation.blocking,
        });
      }
      const retention = retentionFor({
        type,
        closedOn,
        retentionYears: settings.retentionYears,
        originals: input.checklist.originals,
        hasMinor: reads.hasMinor,
        legalHold: legalHoldOn(matter),
      });
      const meta = stamp(uid, now, requestId);
      if (input.cancelOpenTasks) for (const task of reads.openTasks) tx.update(task, { status: 'cancelled', ...meta });
      for (const deadline of reads.reminding) tx.update(deadline, { nextReminderAt: FieldValue.delete() });
      const usedOverrides = Object.fromEntries(
        Object.entries(overrides).filter(([id]) =>
          evaluation.items.some((item) => item.id === id && item.state === 'overridden'),
        ),
      );
      const closing = {
        ...(input.checklist.originals ? { originals: input.checklist.originals } : {}),
        closingLetterSent: input.checklist.closingLetterSent,
        finalDistributionRecorded: input.checklist.finalDistributionRecorded,
        ...(Object.keys(usedOverrides).length ? { overrides: usedOverrides } : {}),
        tasksCancelled: input.cancelOpenTasks ? reads.openTasks.length : 0,
        holds: retention.holds,
      };
      tx.update(ref, {
        status: 'closed',
        closedAt: now,
        closeReason: input.reason,
        closing,
        destroyAfter: retention.destroyAfter ?? FieldValue.delete(),
        archivedAt: FieldValue.delete(),
        ...meta,
      });
      return { from, retention, tasksCancelled: closing.tasksCancelled, overridden: Object.keys(usedOverrides) };
    });

    await audit(ctx, {
      action: 'matter.closed',
      entity: { path: ref.path },
      summary: `Matter ${input.matterId} closed`,
      data: {
        from: outcome.from,
        reason: input.reason,
        destroyAfter: outcome.retention.destroyAfter,
        holds: outcome.retention.holds,
        tasksCancelled: outcome.tasksCancelled,
        ...(input.cancelOpenTasks && outcome.tasksCancelled ? { cancelReason: input.cancelOpenTasks.reason } : {}),
        ...(outcome.overridden.length ? { overridden: outcome.overridden } : {}),
      },
    });
    log.info('matter closed', {
      matterId: input.matterId,
      tasksCancelled: outcome.tasksCancelled,
      held: outcome.retention.holds.length > 0,
    });
    return {
      matterId: input.matterId,
      status: 'closed',
      tasksCancelled: outcome.tasksCancelled,
      ...outcome.retention,
    };
  },
} satisfies CallableDefinition<typeof CloseMatterInput, CloseMatterResult>;

export const closingChecklist = defineCallable(closingChecklistDefinition);
export const close = defineCallable(closeDefinition);
