import { inject } from '@angular/core';
import * as z from 'zod';

import {
  Deadline,
  DEADLINE_CALLABLES,
  DeadlineChange,
  DomainError,
  ManualDeadlineCreateInput,
  ManualDeadlineUpdateInput,
  MatterEvent,
  SoftDeleteShape,
  type AcknowledgeDeadlineInput,
  type AcknowledgeDeadlineResult,
  type CompleteDeadlineInput,
  type CompleteDeadlineResult,
  type DeleteEventInput,
  type DeleteEventResult,
  type OverrideDeadlineInput,
  type OverrideDeadlineResult,
  type ProposeRulesetUpgradeInput,
  type ProposeRulesetUpgradeResult,
  type RecomputeDeadlinesInput,
  type RecomputeSummary,
  type ResolveDeadlineChangeInput,
  type ResolveDeadlineChangeResult,
  type UpsertEventInput,
  type UpsertEventResult,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import { OrgContext } from './org-context';
import type { QuerySpec } from './query';
import { groupRepo, repo, type GroupRepository, type Repository } from './repository';

const deadline = Deadline.schema.shape;

/**
 * A deadline as the Deadlines screen and the matter's Deadlines tab read it (CORE-10): computed
 * deadlines (with `computed` provenance, a rule's trace) and manual ones alike. `dueDate` is the
 * date in force (an override applied) and is absent only while `blocked`. Rows fit
 * `DeadlineLike` (`groupDeadlines`, `deadlineMatchesFilters`, `deadlineTraceView` in libs/domain).
 * Other fields are dropped, not rejected.
 */
export const DeadlineItemSchema = /* @__PURE__ */ z.object({
  orgId: deadline.orgId.optional(),
  matterId: deadline.matterId.optional(),
  title: deadline.title,
  dueDate: deadline.dueDate,
  dueTime: deadline.dueTime,
  kind: deadline.kind,
  critical: deadline.critical,
  status: deadline.status,
  blockedReason: deadline.blockedReason,
  blockedCode: deadline.blockedCode,
  computed: deadline.computed,
  override: deadline.override,
  overrideConflict: deadline.overrideConflict,
  declined: deadline.declined,
  resolution: deadline.resolution,
  missedCheck: deadline.missedCheck,
  taskId: deadline.taskId,
  reminders: deadline.reminders,
  assigneeUid: deadline.assigneeUid,
  ackBy: deadline.ackBy,
  ackAt: deadline.ackAt,
  escalatedAt: deadline.escalatedAt,
  escalatedTo: deadline.escalatedTo,
  pastOnCreation: deadline.pastOnCreation,
  updatedAt: deadline.updatedAt.optional(),
  updatedBy: deadline.updatedBy.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type DeadlineItem = z.infer<typeof DeadlineItemSchema>;

/** What a form gives a new manual deadline; the repository adds org, matter and status. */
export type NewManualDeadlineFields = Omit<z.input<typeof ManualDeadlineCreateInput>, 'orgId' | 'matterId' | 'status'>;

/**
 * A matter's deadlines (`orgs/{orgId}/matters/{matterId}/deadlines`, CORE-10): live reads of every
 * deadline, and client-direct writes of manual ones only:
 *
 * - `create(fields)` makes a manual deadline (contractual, internal or court; task.edit), adding
 *   `orgId`, `matterId` and `status: 'upcoming'`, which the rules require;
 * - `update(id, patch)` edits an upcoming manual deadline's whitelisted fields
 *   (`ManualDeadlineUpdateInput`), or reassigns (`assigneeUid`) or acknowledges (`ackBy`, `ackAt`)
 *   a computed one; `softDelete(id)` removes a manual one.
 *
 * Overrides, decisions on proposals and closing (done, waived, missed) go through
 * `deadlineCallables`; the rules refuse them as direct writes.
 */
export function matterDeadlineRepository(matterId: () => string | null): Repository<DeadlineItem> {
  const context = inject(OrgContext);
  const base = repo((orgId) => `orgs/${orgId}/matters/${matterId() ?? '-'}/deadlines`, {
    schema: DeadlineItemSchema,
    version: Deadline.version,
    create: ManualDeadlineCreateInput,
    update: ManualDeadlineUpdateInput,
  });
  return {
    ...base,
    create: (fields, options) => {
      const id = matterId();
      if (!id)
        return Promise.reject(
          new DomainError('INVALID_ARGUMENT', 'No matter to add the deadline to', { field: 'matterId' }),
        );
      return base.create({ ...fields, orgId: context.requireOrgId(), matterId: id, status: 'upcoming' }, options);
    },
  };
}

/** Deadlines across the org's matters (the `deadlines` collection group, scoped to the active org). */
export function deadlineGroupRepository(): GroupRepository<DeadlineItem> {
  return groupRepo('deadlines', { schema: DeadlineItemSchema, version: Deadline.version });
}

/**
 * A matter's deadlines, every status (the tab groups them). No `orderBy`: a blocked deadline has no
 * `dueDate` and an ordered query would drop it; sort with `compareDeadlines`.
 */
export const MATTER_DEADLINES_QUERY: QuerySpec<DeadlineItem> = { pageSize: 200 };

/**
 * The Deadlines screen: the org's upcoming deadlines by date (indexed: orgId, status, dueDate).
 * Group them with `groupDeadlines` and filter with `deadlineMatchesFilters`.
 */
export const UPCOMING_DEADLINES_QUERY: QuerySpec<DeadlineItem> = {
  where: [['status', '==', 'upcoming']],
  orderBy: [['dueDate', 'asc']],
  pageSize: 500,
};

/** "Mine": my upcoming deadlines by date (indexed: orgId, assigneeUid, status, dueDate). */
export const myUpcomingDeadlinesQuery = (uid: string): QuerySpec<DeadlineItem> => ({
  where: [
    ['assigneeUid', '==', uid],
    ['status', '==', 'upcoming'],
  ],
  orderBy: [['dueDate', 'asc']],
  pageSize: 500,
});

/** Critical upcoming deadlines (indexed: orgId, status, critical, dueDate). */
export const CRITICAL_DEADLINES_QUERY: QuerySpec<DeadlineItem> = {
  where: [
    ['status', '==', 'upcoming'],
    ['critical', '==', true],
  ],
  orderBy: [['dueDate', 'asc']],
  pageSize: 500,
};

/** Upcoming deadlines of one kind (indexed: orgId, status, kind, dueDate). */
export const deadlinesOfKindQuery = (kind: DeadlineItem['kind']): QuerySpec<DeadlineItem> => ({
  where: [
    ['status', '==', 'upcoming'],
    ['kind', '==', kind],
  ],
  orderBy: [['dueDate', 'asc']],
  pageSize: 500,
});

/**
 * The review queue: upcoming deadlines that were already past when computed (indexed: orgId,
 * status, pastOnCreation, dueDate). A lawyer marks each done, waived or missed, or overrides it.
 */
export const REVIEW_QUEUE_QUERY: QuerySpec<DeadlineItem> = {
  where: [
    ['status', '==', 'upcoming'],
    ['pastOnCreation', '==', true],
  ],
  orderBy: [['dueDate', 'asc']],
  pageSize: 200,
};

const change = DeadlineChange.schema.shape;

/** A proposed change to a computed deadline (CORE-10), decided with `deadlineCallables.resolveChange`. */
export const DeadlineChangeItemSchema = /* @__PURE__ */ z.object({
  orgId: change.orgId,
  matterId: change.matterId,
  deadlineId: change.deadlineId,
  ruleId: change.ruleId,
  title: change.title,
  critical: change.critical,
  kind: change.kind,
  cause: change.cause,
  status: change.status,
  fromDueDate: change.fromDueDate,
  toDueDate: change.toDueDate,
  earlier: change.earlier,
  intoPast: change.intoPast,
  reason: change.reason,
  computed: change.computed,
  assigneeUid: change.assigneeUid,
  resolvedBy: change.resolvedBy,
  resolvedAt: change.resolvedAt,
  createdAt: change.createdAt.optional(),
});
export type DeadlineChangeItem = z.infer<typeof DeadlineChangeItemSchema>;

/** A matter's proposals (`deadlineChanges`), read-only for clients. */
export function matterDeadlineChangeRepository(matterId: () => string | null): Repository<DeadlineChangeItem> {
  return repo((orgId) => `orgs/${orgId}/matters/${matterId() ?? '-'}/deadlineChanges`, {
    schema: DeadlineChangeItemSchema,
    version: DeadlineChange.version,
  });
}

/** Proposals across the org's matters (the `deadlineChanges` collection group). */
export function deadlineChangeGroupRepository(): GroupRepository<DeadlineChangeItem> {
  return groupRepo('deadlineChanges', { schema: DeadlineChangeItemSchema, version: DeadlineChange.version });
}

/** A matter's pending proposals (equality only: no composite index). */
export const PENDING_CHANGES_QUERY: QuerySpec<DeadlineChangeItem> = {
  where: [['status', '==', 'pending']],
  pageSize: 100,
};

/** Pending proposals waiting on me, newest first (indexed: orgId, assigneeUid, status, createdAt). */
export const myPendingChangesQuery = (uid: string): QuerySpec<DeadlineChangeItem> => ({
  where: [
    ['assigneeUid', '==', uid],
    ['status', '==', 'pending'],
  ],
  orderBy: [['createdAt', 'desc']],
  pageSize: 100,
});

const event = MatterEvent.schema.shape;

/** A matter event (date of death, grant issued, notice published…), anchor of computed deadlines. */
export const MatterEventItemSchema = /* @__PURE__ */ z.object({
  kind: event.kind,
  date: event.date,
  time: event.time,
  label: event.label,
  meta: event.meta,
  sourceDocumentId: event.sourceDocumentId,
  updatedAt: event.updatedAt.optional(),
  updatedBy: event.updatedBy.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type MatterEventItem = z.infer<typeof MatterEventItemSchema>;

/**
 * A matter's events, read-only for clients: they are recorded, edited and deleted through
 * `deadlineCallables.upsertEvent` and `deleteEvent`, which recompute the deadlines.
 */
export function matterEventRepository(matterId: () => string | null): Repository<MatterEventItem> {
  return repo((orgId) => `orgs/${orgId}/matters/${matterId() ?? '-'}/events`, {
    schema: MatterEventItemSchema,
    version: MatterEvent.version,
  });
}

/** A matter's events by date. */
export const MATTER_EVENTS_QUERY: QuerySpec<MatterEventItem> = { orderBy: [['date', 'asc']], pageSize: 200 };

/** Callable input without the request id, which the client adds. */
type Input<T> = Omit<T, 'requestId'>;

/** The `deadlines-*` callables (CORE-10). Errors arrive as `DomainError`s (`toDomainError`). */
export interface DeadlineCallables {
  /**
   * `deadlines-upsertEvent` (matter.edit): records an event, or edits one (`eventId`), and
   * recomputes. A future date of death is INVALID_ARGUMENT on `date`.
   */
  upsertEvent(input: Input<UpsertEventInput>): Promise<UpsertEventResult>;
  /** `deadlines-deleteEvent` (matter.edit): soft-deletes an event and recomputes. */
  deleteEvent(input: Input<DeleteEventInput>): Promise<DeleteEventResult>;
  /** `deadlines-recompute` (matter.edit): recomputes a matter's deadlines (a no-op when current). */
  recompute(input: RecomputeDeadlinesInput): Promise<RecomputeSummary>;
  /**
   * `deadlines-resolveChange` (deadline.override): accepts or rejects a proposal. Accepting a
   * critical one needs `confirmation`, the matter number typed (INVALID_ARGUMENT on
   * `confirmation`); a decided one is FAILED_PRECONDITION (`change_not_pending`); a stale one comes
   * back `superseded`.
   */
  resolveChange(input: Input<ResolveDeadlineChangeInput>): Promise<ResolveDeadlineChangeResult>;
  /**
   * `deadlines-override` (deadline.override): sets a computed deadline's date with a reason, or
   * clears the override (`dueDate: null`). A manual deadline is FAILED_PRECONDITION
   * (`manual_deadline`), a closed one `deadline_not_open`.
   */
  override(input: Input<OverrideDeadlineInput>): Promise<OverrideDeadlineResult>;
  /**
   * `deadlines-complete`: done (task.edit), waived with a reason or missed (deadline.override;
   * missed only after the missed check asked, `not_past_due` otherwise). The result lists open
   * linked tasks so the UI can offer to complete them (`completeLinkedTasks`).
   */
  complete(input: Input<CompleteDeadlineInput>): Promise<CompleteDeadlineResult>;
  /** `deadlines-acknowledge` (task.edit; CORE-11): marks an upcoming deadline seen, which stops it escalating. */
  acknowledge(input: Input<AcknowledgeDeadlineInput>): Promise<AcknowledgeDeadlineResult>;
  /** `deadlines-proposeRulesetUpgrade` (org.settings): one page of the rule-set upgrade backfill. */
  proposeRulesetUpgrade(input: Input<ProposeRulesetUpgradeInput>): Promise<ProposeRulesetUpgradeResult>;
}

export function deadlineCallables(client: Pick<CallableClient, 'call'>): DeadlineCallables {
  const idempotent = { idempotent: true };
  return {
    upsertEvent: (input) => client.call(DEADLINE_CALLABLES.upsertEvent, input, idempotent),
    deleteEvent: (input) => client.call(DEADLINE_CALLABLES.deleteEvent, input, idempotent),
    recompute: (input) => client.call(DEADLINE_CALLABLES.recompute, input),
    resolveChange: (input) => client.call(DEADLINE_CALLABLES.resolveChange, input, idempotent),
    override: (input) => client.call(DEADLINE_CALLABLES.override, input, idempotent),
    complete: (input) => client.call(DEADLINE_CALLABLES.complete, input, idempotent),
    acknowledge: (input) => client.call(DEADLINE_CALLABLES.acknowledge, input, idempotent),
    proposeRulesetUpgrade: (input) => client.call(DEADLINE_CALLABLES.proposeRulesetUpgrade, input, idempotent),
  };
}
