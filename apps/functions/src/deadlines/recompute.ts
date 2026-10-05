import { FieldValue, type DocumentSnapshot, type Firestore, type Transaction } from 'firebase-admin/firestore';

import {
  computeSafely,
  isEmptyPlan,
  linkedTaskId,
  planRecompute,
  RULE_SET_FOR_JURISDICTION,
  selectRules,
  type ExistingDeadline,
  type PendingChange,
  type RecomputePlan,
  type RuleSet,
  VIC_CALENDARS,
} from '@materia/deadlines';
import {
  compareDates,
  Deadline,
  DeadlineChange,
  DomainError,
  EVENT_KEY_FACTS,
  MatterEvent,
  MatterTypeSchema,
  matterStages,
  Notification,
  stageIndex,
  Task,
  templateTaskDue,
  today,
  type DateOnly,
  type DeadlineChangeCause,
  type DeadlineComputed,
  type EventKind,
  type FactMatter,
  type RecomputeSummary,
  type Role,
  type Template,
} from '@materia/domain';

import {
  changesPath,
  CLOSED_STATUSES,
  currentRuleSet,
  deadlinesPath,
  engineEvents,
  eventsPath,
  localityCalendar,
  matterFacts,
  statutoryEnabled,
  tasksPath,
  templateRuleIds,
  type StoredEvent,
} from './shared';
import { compact, isDeleted } from '../contacts/shared';
import { isEnabled } from '../core/flags';
import type { Log } from '../core/log';
import { liveMatter, matterPath } from '../matters/shared';
import type { Clock } from '../ports';
import { readMatterTemplateStages, readTemplate, readWith } from '../templates/shared';

type Data = Record<string, unknown>;

/** The fields of an event to record (`deadlines-upsertEvent`). */
export interface EventFields {
  kind: EventKind;
  date: DateOnly;
  time?: string | undefined;
  label?: string | undefined;
  meta?: Data | undefined;
  sourceDocumentId?: string | undefined;
}

/** An event write made in the recompute's transaction: an add or edit (`fields`), or a delete (`null`). */
export interface EventChange {
  /** The event to edit or delete; omitted to add one. */
  eventId?: string | undefined;
  fields: EventFields | null;
}

export interface RecomputeRequest {
  orgId: string;
  matterId: string;
  /** Who acts: stamped on every write (`system` for none). */
  uid: string;
  role: Role;
  requestId?: string | undefined;
  cause: DeadlineChangeCause;
  /** The org's clock (pinned in the emulator by `emulatorClock/{orgId}`). */
  clock: Clock;
  log: Log;
  event?: EventChange | undefined;
}

export interface RecomputeOutcome extends RecomputeSummary {
  eventId?: string;
  /** Template tasks whose pending due date this event filled (CORE-07b). */
  filledTaskIds: string[];
}

const LINKED_TASK_ORDER = 1_000_000;

const del = () => FieldValue.delete();

/** A stored instant (a Firestore Timestamp, or a Date in tests) as a Date. */
const asDate = (value: unknown): Date | undefined =>
  value instanceof Date ? value : (value as { toDate?: () => Date } | undefined)?.toDate?.();

function existingDeadline(id: string, data: Data): ExistingDeadline | undefined {
  const computed = data['computed'] as DeadlineComputed | undefined;
  if (!computed || typeof computed.ruleId !== 'string') return undefined;
  return {
    id,
    status: data['status'] as ExistingDeadline['status'],
    dueDate: data['dueDate'] as string | undefined,
    deleted: isDeleted(data),
    title: String(data['title'] ?? ''),
    critical: data['critical'] === true,
    kind: String(data['kind'] ?? ''),
    dueTime: data['dueTime'] as string | undefined,
    blockedReason: data['blockedReason'] as string | undefined,
    blockedCode: data['blockedCode'] as string | undefined,
    computed,
    override: data['override'] as ExistingDeadline['override'],
    overrideConflict: data['overrideConflict'] as boolean | undefined,
    declined: data['declined'] as ExistingDeadline['declined'],
    reminders: data['reminders'] as ExistingDeadline['reminders'],
  };
}

/** The key facts an event stands for, from the matter's live events after the change (CORE-10). */
function keyFactPatch(matter: Data, events: readonly StoredEvent[], kinds: readonly EventKind[]): Data {
  const patch: Data = {};
  for (const kind of kinds) {
    const fact = EVENT_KEY_FACTS[kind];
    if (!fact) continue;
    const dates = events
      .filter(({ data }) => !isDeleted(data) && data['kind'] === kind && typeof data['date'] === 'string')
      .map(({ data }) => data['date'] as DateOnly)
      .sort(compareDates);
    // The earliest, as template due dates read it.
    const date = dates[0];
    if (kind === 'date_of_death') {
      const deceased = matter['deceased'] as Data | undefined;
      if (!deceased) continue;
      if (deceased['dateOfDeath'] !== date) patch['deceased.dateOfDeath'] = date ?? del();
    } else if (kind === 'grant_issued') {
      const estate = matter['estate'] as Data | undefined;
      if (estate?.['grantDate'] !== date) patch['estate.grantDate'] = date ?? del();
    }
  }
  return patch;
}

/** The matter as it reads after the key-fact patch (for anchors and template due dates). */
function withFacts(matter: Data, patch: Data): Data {
  const next: Data = { ...matter };
  for (const [path, value] of Object.entries(patch)) {
    const [head, field] = path.split('.') as [string, string];
    const inner = Object.entries((next[head] as Data | undefined) ?? {}).filter(([key]) => key !== field);
    next[head] = Object.fromEntries(value instanceof FieldValue ? inner : [...inner, [field, value]]);
  }
  return next;
}

interface Prepared {
  ruleSet?: RuleSet;
  statutoryOn: boolean;
  timeZone: string;
  locality: string;
  templatesOn: boolean;
}

async function prepare(db: Firestore, request: RecomputeRequest): Promise<Prepared> {
  const { orgId, matterId, clock, log } = request;
  const [org, matter] = await Promise.all([db.doc(`orgs/${orgId}`).get(), db.doc(matterPath(orgId, matterId)).get()]);
  const zone = org.get('timezone');
  const jurisdiction = matter.get('jurisdiction') as keyof typeof RULE_SET_FOR_JURISDICTION | undefined;
  const ruleSetId = jurisdiction ? RULE_SET_FOR_JURISDICTION[jurisdiction] : undefined;
  const ruleSet = ruleSetId ? await currentRuleSet(db, ruleSetId, log) : undefined;
  const flags = { orgId, db, clock };
  const [statutoryOn, templatesOn] = await Promise.all([
    ruleSet ? statutoryEnabled(flags, ruleSet) : Promise.resolve(false),
    isEnabled(flags, 'templates.system'),
  ]);
  return {
    ...(ruleSet ? { ruleSet } : {}),
    statutoryOn,
    timeZone: typeof zone === 'string' && zone ? zone : 'Australia/Melbourne',
    locality: localityCalendar(org.data()),
    templatesOn,
  };
}

const emptySummary = (version: number, statutoryDisabled: boolean): RecomputeOutcome => ({
  ran: false,
  recomputeVersion: version,
  created: [],
  updated: [],
  proposed: [],
  superseded: [],
  calendarMissing: [],
  createdTaskIds: [],
  statutoryDisabled,
  filledTaskIds: [],
});

/**
 * Recomputes a matter's deadlines (CORE-10) in one transaction on the matter, optionally recording
 * an event change first. Loads the matter's live events, the latest published rule set for its
 * jurisdiction (statutory rules only with their practitioner-review flag on; with templates on,
 * only the rules the matter's template names) and the bundled calendars; computes, then plans
 * against the stored deadlines (`planRecompute`): new deadlines are created (upcoming, or blocked
 * with a reason), dates in force never move (moves and removals become `deadlineChanges`
 * proposals, with a `deadline_changed` notification to the responsible lawyer), and rule tasks are
 * created once. The transaction reads and bumps `recomputeVersion` whenever it writes, so
 * concurrent recomputes and event edits of a matter are serialised; a recompute with nothing to
 * change writes nothing (idempotent).
 */
export async function recomputeMatter(db: Firestore, request: RecomputeRequest): Promise<RecomputeOutcome> {
  const { orgId, matterId, uid, role, requestId, cause, clock, log } = request;
  const prepared = await prepare(db, request);
  const now = clock.now();
  const todayDate = today(prepared.timeZone, now);
  const matterRef = db.doc(matterPath(orgId, matterId));
  const stamp = { updatedAt: now, updatedBy: uid, ...(requestId ? { _requestId: requestId } : {}) };
  const created = { createdAt: now, createdBy: uid, ...stamp };

  const outcome = await db.runTransaction(async (tx: Transaction) => {
    const matter = liveMatter(await tx.get(matterRef), role, matterId);
    const version = typeof matter['recomputeVersion'] === 'number' ? matter['recomputeVersion'] : 0;

    // ---- reads ----
    const event = request.event;
    let eventId: string | undefined;
    let eventData: Data | undefined;
    let eventBefore: Data | undefined;
    if (event?.eventId) {
      const snap = await tx.get(db.doc(`${eventsPath(orgId, matterId)}/${event.eventId}`));
      eventBefore = snap.data();
      if (!snap.exists || !eventBefore || isDeleted(eventBefore)) {
        throw new DomainError('NOT_FOUND', 'Event not found', { matterId, eventId: event.eventId });
      }
    }
    if (event && event.fields === null && !event.eventId) throw new Error('A delete needs an event id');
    const eventSnaps = await tx.get(db.collection(eventsPath(orgId, matterId)));
    let events: StoredEvent[] = eventSnaps.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
    if (event) {
      eventId = event.eventId ?? db.collection(eventsPath(orgId, matterId)).doc().id;
      if (event.fields === null) {
        eventData = { ...eventBefore, deletedAt: now, deletedBy: uid, ...stamp };
      } else {
        eventData = MatterEvent.schema.parse(
          compact({
            kind: event.fields.kind,
            date: event.fields.date,
            time: event.fields.time,
            label: event.fields.label,
            meta: event.fields.meta ?? (eventBefore?.['meta'] as Data | undefined) ?? {},
            sourceDocumentId: event.fields.sourceDocumentId,
            ...(eventBefore
              ? { createdAt: asDate(eventBefore['createdAt']) ?? now, createdBy: eventBefore['createdBy'] }
              : { createdAt: now, createdBy: uid }),
            ...stamp,
            schemaVersion: MatterEvent.version,
          }),
        ) as Data;
      }
      events = [...events.filter((e) => e.id !== eventId), { id: eventId, data: eventData }];
    }
    const touchedKinds = [
      ...new Set(
        [eventBefore?.['kind'], eventData?.['kind']].filter((kind): kind is EventKind => typeof kind === 'string'),
      ),
    ];
    const factPatch = event ? keyFactPatch(matter, events, touchedKinds) : {};
    const current = withFacts(matter, factPatch);

    const templateId = matter['templateId'];
    const templateVersion = matter['templateVersion'];
    const template: Template | undefined =
      typeof templateId === 'string' && templateId
        ? await readTemplate(
            db,
            readWith(tx),
            orgId,
            templateId,
            typeof templateVersion === 'number' && templateVersion >= 1 ? templateVersion : undefined,
          )
        : undefined;
    const type = MatterTypeSchema.safeParse(matter['type']);
    const stages = type.success
      ? matterStages(type.data, template?.stages ?? (await readMatterTemplateStages(db, readWith(tx), orgId, matter)))
      : [];

    const closed = CLOSED_STATUSES.has(matter['status']);
    const ruleSet = prepared.ruleSet;
    let plan: RecomputePlan | undefined;
    if (ruleSet && !closed && type.success) {
      const [deadlineSnaps, pendingSnaps] = await Promise.all([
        tx.get(db.collection(deadlinesPath(orgId, matterId))),
        tx.get(db.collection(changesPath(orgId, matterId)).where('status', '==', 'pending')),
      ]);
      const selection = selectRules(ruleSet, {
        statutoryEnabled: prepared.statutoryOn,
        ruleIds: prepared.templatesOn ? templateRuleIds(template) : undefined,
      });
      const anchors = engineEvents(current, events);
      const results = computeSafely({
        matter: { type: type.data, jurisdiction: ruleSet.jurisdiction, facts: matterFacts(current, anchors) },
        events: anchors,
        ruleSet: selection.ruleSet,
        calendars: VIC_CALENDARS,
        localityCalendar: prepared.locality,
        today: todayDate,
      });
      plan = planRecompute({
        results,
        skipped: selection.skipped,
        existing: deadlineSnaps.docs.flatMap((doc) => existingDeadline(doc.id, doc.data()) ?? []),
        pending: pendingSnaps.docs.map((doc): PendingChange => ({
          id: doc.id,
          deadlineId: String(doc.get('deadlineId')),
          kind: doc.get('kind') as PendingChange['kind'],
          toDueDate: doc.get('toDueDate') as string | undefined,
        })),
        today: todayDate,
      });
    }

    // Rule tasks: created once (deterministic ids), when the matter has reached their stage.
    const currentStage = stageIndex(stages, matter['stageId'] as string | undefined);
    const wantedTasks = (plan?.tasks ?? []).filter((task) => {
      const at = task.stage ? stages.findIndex((stage) => stage.id === task.stage) : -1;
      return at < 0 || at <= currentStage;
    });
    const taskIds = [...new Set(wantedTasks.map((task) => linkedTaskId(task.dedupeKey)))];
    const taskSnaps = await Promise.all(taskIds.map((id) => tx.get(db.doc(`${tasksPath(orgId, matterId)}/${id}`))));
    const missingTasks = new Set(taskIds.filter((_, i) => !(taskSnaps[i] as DocumentSnapshot).exists));

    // Template tasks waiting on this event's date (CORE-07b): filled when it is recorded.
    const fillKind = event?.fields ? event.fields.kind : undefined;
    const waiting = fillKind
      ? (await tx.get(db.collection(tasksPath(orgId, matterId)).where('duePending', '==', fillKind))).docs
      : [];

    const proposals = plan?.proposals ?? [];
    const conflicts = plan?.overrideConflicts ?? [];
    const responsibleUid = String(matter['responsibleUid'] ?? '');
    const notify =
      (proposals.length || conflicts.length) && responsibleUid
        ? (await tx.get(db.doc(`orgs/${orgId}/members/${responsibleUid}`))).get('status') === 'active'
        : false;

    // ---- writes ----
    const writesPlan = !!plan && !isEmptyPlan(plan);
    const writes = writesPlan || !!event || missingTasks.size > 0;
    const nextVersion = writes ? version + 1 : version;
    const summary: RecomputeOutcome = {
      ...emptySummary(nextVersion, !!ruleSet && !prepared.statutoryOn),
      ran: !!plan,
      ...(ruleSet ? { ruleSet: { ruleSetId: ruleSet.ruleSetId, version: ruleSet.version } } : {}),
      ...(eventId ? { eventId } : {}),
      calendarMissing: [...new Set((plan?.calendarMissing ?? []).map((m) => m.deadlineId))],
    };
    const calendarMissing = plan?.calendarMissing ?? [];
    if (!writes) return { summary, calendarMissing };

    if (event && eventId && eventData) tx.set(db.doc(`${eventsPath(orgId, matterId)}/${eventId}`), eventData);

    // Filled template due dates.
    if (fillKind) {
      const context = { matter: current as FactMatter, events: engineEvents(current, events) };
      for (const doc of waiting) {
        const task = doc.data();
        if (isDeleted(task)) continue;
        const key = task['templateTaskKey'];
        const definition = template?.tasks.find((t) => t.key === key);
        const stageEnteredOn = (matter['stageEnteredOn'] as DateOnly | undefined) ?? todayDate;
        const due = definition ? templateTaskDue(definition, context, stageEnteredOn) : {};
        if (!due.dueDate) continue;
        tx.update(doc.ref, { dueDate: due.dueDate, duePending: del(), ...stamp });
        summary.filledTaskIds.push(doc.id);
      }
    }

    const taskFor = new Map<string, string>();
    for (const task of wantedTasks) {
      const id = linkedTaskId(task.dedupeKey);
      if (!missingTasks.has(id) || taskFor.has(task.deadlineId) || [...taskFor.values()].includes(id)) continue;
      taskFor.set(task.deadlineId, id);
    }
    const deadlineCreates = new Set(plan?.creates.map((c) => c.id) ?? []);
    const deadlineUpdates = new Set(plan?.updates.map((u) => u.id) ?? []);
    for (const c of plan?.creates ?? []) {
      const taskId = taskFor.get(c.id);
      tx.create(
        db.doc(`${deadlinesPath(orgId, matterId)}/${c.id}`),
        Deadline.schema.parse(
          compact({
            ...c.fields,
            orgId,
            matterId,
            assigneeUid: responsibleUid,
            ...(taskId ? { taskId } : {}),
            ...created,
            schemaVersion: Deadline.version,
          }),
        ),
      );
      summary.created.push(c.id);
    }
    for (const u of plan?.updates ?? []) {
      const taskId = taskFor.get(u.id);
      tx.update(db.doc(`${deadlinesPath(orgId, matterId)}/${u.id}`), {
        ...u.set,
        ...Object.fromEntries(u.remove.filter((field) => !(field in u.set)).map((field) => [field, del()])),
        ...(taskId ? { taskId } : {}),
        ...stamp,
      });
      summary.updated.push(u.id);
    }
    for (const [deadlineId, taskId] of taskFor) {
      if (deadlineCreates.has(deadlineId) || deadlineUpdates.has(deadlineId)) continue;
      tx.update(db.doc(`${deadlinesPath(orgId, matterId)}/${deadlineId}`), { taskId, ...stamp });
    }
    const planned = new Map(wantedTasks.map((task) => [task.deadlineId, task]));
    for (const [deadlineId, taskId] of taskFor) {
      const task = planned.get(deadlineId);
      if (!task) continue;
      const stage = task.stage ? stages.find((s) => s.id === task.stage) : undefined;
      tx.create(
        db.doc(`${tasksPath(orgId, matterId)}/${taskId}`),
        Task.schema.parse(
          compact({
            title: task.title,
            status: 'todo',
            priority: task.critical ? 'high' : 'medium',
            assigneeUid: responsibleUid || undefined,
            dueDate: task.dueDate,
            deadlineId,
            group: stage?.title ?? 'Deadlines',
            checklist: [],
            order: LINKED_TASK_ORDER,
            source: 'rule',
            orgId,
            matterId,
            // Counted below, so tasks-onWrite leaves the count alone (CORE-08).
            countedOpen: true,
            ...created,
            schemaVersion: Task.version,
          }),
        ),
      );
      summary.createdTaskIds.push(taskId);
    }

    for (const changeId of plan?.supersede ?? []) {
      tx.update(db.doc(`${changesPath(orgId, matterId)}/${changeId}`), { status: 'superseded', ...stamp });
      summary.superseded.push(changeId);
    }
    const number = typeof matter['number'] === 'string' ? matter['number'] : '';
    for (const proposal of proposals) {
      const changeId = `${proposal.deadlineId}-v${nextVersion}`;
      tx.create(
        db.doc(`${changesPath(orgId, matterId)}/${changeId}`),
        DeadlineChange.schema.parse(
          compact({
            ...proposal,
            orgId,
            matterId,
            cause,
            status: 'pending',
            assigneeUid: responsibleUid,
            recomputeVersion: nextVersion,
            ...created,
            schemaVersion: DeadlineChange.version,
          }),
        ),
      );
      summary.proposed.push(changeId);
      if (!notify) continue;
      const urgent = proposal.critical && proposal.intoPast;
      tx.create(
        db.doc(`orgs/${orgId}/notifications/dlchange-${matterId}-${changeId}`),
        Notification.schema.parse({
          kind: 'deadline_changed',
          deadlineId: proposal.deadlineId,
          matterId,
          changeId,
          recipientUid: responsibleUid,
          title: urgent
            ? 'A critical deadline would move into the past'
            : proposal.kind === 'moved'
              ? 'A deadline date change needs your decision'
              : 'A deadline may no longer apply',
          body:
            proposal.kind === 'moved'
              ? `${proposal.title}${number ? ` · ${number}` : ''}: ${proposal.fromDueDate} → ${proposal.toDueDate ?? ''}`
              : `${proposal.title}${number ? ` · ${number}` : ''}: ${proposal.reason ?? 'its anchor was removed'}`,
          link: `/matters/${matterId}/deadlines`,
          channel: ['inapp'],
          ...(urgent ? { priority: 'high' } : {}),
          createdAt: now,
          createdBy: 'system',
          updatedAt: now,
          updatedBy: 'system',
          schemaVersion: Notification.version,
        }),
      );
    }
    if (notify) {
      for (const deadlineId of conflicts) {
        const update = plan?.updates.find((u) => u.id === deadlineId);
        const computedDue = (update?.set['computed'] as DeadlineComputed | undefined)?.dueDate ?? '';
        tx.set(
          db.doc(`orgs/${orgId}/notifications/dlconflict-${matterId}-${deadlineId}-${computedDue}`),
          Notification.schema.parse({
            kind: 'deadline_changed',
            deadlineId,
            matterId,
            recipientUid: responsibleUid,
            title: 'The computed date is now earlier than your override',
            body: `${String(update?.set['title'] ?? 'Deadline')}${number ? ` · ${number}` : ''}: the rule now gives ${computedDue}`,
            link: `/matters/${matterId}/deadlines`,
            channel: ['inapp'],
            priority: 'high',
            createdAt: now,
            createdBy: 'system',
            updatedAt: now,
            updatedBy: 'system',
            schemaVersion: Notification.version,
          }),
        );
      }
    }

    tx.update(matterRef, {
      recomputeVersion: nextVersion,
      ...(summary.createdTaskIds.length ? { openTaskCount: FieldValue.increment(summary.createdTaskIds.length) } : {}),
      ...factPatch,
      ...(Object.keys(factPatch).length ? stamp : {}),
    });
    return { summary, calendarMissing };
  });

  const { summary, calendarMissing: missing } = outcome;
  if (missing.length) {
    // Ops alert (FND-21 will route it): a needed calendar year isn't loaded, so deadlines are blocked.
    const years = [...new Set(missing.map((m) => `${m.calendarId}-${m.year}`))];
    log.error('ops alert: deadline calendar data missing', {
      alert: 'deadline_calendar_missing',
      matterId,
      calendars: years,
      ruleIds: missing.map((m) => m.ruleId),
    });
  }
  log.info('deadlines recomputed', {
    matterId,
    cause,
    ran: summary.ran,
    recomputeVersion: summary.recomputeVersion,
    created: summary.created.length,
    updated: summary.updated.length,
    proposed: summary.proposed.length,
    superseded: summary.superseded.length,
    tasks: summary.createdTaskIds.length,
    statutoryDisabled: summary.statutoryDisabled,
    skipped: skippedCount(prepared.ruleSet, prepared.statutoryOn),
  });
  return summary;
}

function skippedCount(ruleSet: RuleSet | undefined, statutoryOn: boolean): number {
  return ruleSet && !statutoryOn ? ruleSet.rules.filter((rule) => rule.kind === 'statutory').length : 0;
}
