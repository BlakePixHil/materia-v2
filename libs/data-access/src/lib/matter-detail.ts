import { z } from 'zod';

import {
  Activity,
  Deadline,
  Matter,
  MatterTemplate,
  Party,
  SoftDeleteShape,
  Task,
  type ChangeMatterStageInput,
  type ChangeMatterStageResult,
  type ChangeMatterStatusInput,
  type ChangeMatterStatusResult,
  type DeadlineStatus,
  type PartyResult,
  type RemovePartyInput,
  type TaskStatus,
  type UpsertPartyInput,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import { ConflictAlertSchema } from './conflicts';
import { MATTER_CALLABLES } from './matters';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

const matter = Matter.schema.shape;

/**
 * What the matter screen reads from `orgs/{orgId}/matters/{id}` (CORE-06): the header, key facts,
 * stage and conflict fields. Nested objects that key facts write (`deceased`, `estate`, `facts`)
 * are read whole, because an update replaces them whole. Other fields are dropped, not rejected.
 */
export const MatterDetailSchema = /* @__PURE__ */ z.object({
  number: matter.number,
  title: matter.title,
  type: matter.type,
  status: matter.status,
  stageId: matter.stageId,
  templateId: matter.templateId,
  jurisdiction: matter.jurisdiction,
  responsibleUid: matter.responsibleUid,
  teamUids: matter.teamUids,
  clientContactIds: matter.clientContactIds,
  deceased: matter.deceased,
  testator: matter.testator,
  estate: matter.estate,
  facts: matter.facts,
  privileged: matter.privileged,
  priority: matter.priority,
  labels: matter.labels,
  externalRef: matter.externalRef,
  conflictCheck: matter.conflictCheck.optional(),
  conflictAlert: ConflictAlertSchema.nullable().optional(),
  openTaskCount: matter.openTaskCount,
  closedAt: matter.closedAt,
  closeReason: matter.closeReason,
  updatedAt: matter.updatedAt.optional(),
  updatedBy: matter.updatedBy.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
  deletedBy: SoftDeleteShape.deletedBy,
});
export type MatterDetail = z.infer<typeof MatterDetailSchema>;

/**
 * The matter screen's matter (CORE-06): a live document and client-direct edits of the whitelisted
 * fields (`Matter.update`: title, people, labels, privileged, key facts). The stage and the parties
 * change through `matters-changeStage` and `matters-upsertParty`/`matters-removeParty`.
 */
export function matterDetailRepository(): Repository<MatterDetail> {
  return repo((orgId) => `orgs/${orgId}/matters`, {
    schema: MatterDetailSchema,
    version: Matter.version,
    update: Matter.update,
  });
}

/** A collection under one matter; `matterId` is read when a query or write starts. */
function matterRecords<T>(
  matterId: () => string | null,
  collection: string,
  schema: z.ZodType<T>,
  version: number,
): Repository<T> {
  return repo((orgId) => `orgs/${orgId}/matters/${matterId() ?? '-'}/${collection}`, { schema, version });
}

/** Watch a matter's records only while it has an id (`null` waits). */
export function forMatter<T>(matterId: () => string | null, spec: QuerySpec<T>): () => QuerySpec<T> | null {
  return () => (matterId() ? spec : null);
}

// ---------- parties ----------

const party = Party.schema.shape;

export const MatterPartySchema = /* @__PURE__ */ z.object({
  contactId: party.contactId,
  role: party.role,
  share: party.share,
  notes: party.notes,
  deletedAt: SoftDeleteShape.deletedAt,
});
export type MatterParty = z.infer<typeof MatterPartySchema>;

/** A matter's parties (read-only here: they change through the `matters-*Party` callables). */
export function matterPartiesRepository(matterId: () => string | null): Repository<MatterParty> {
  return matterRecords(matterId, 'parties', MatterPartySchema, Party.version);
}

/** Every live party of a matter (no ordering: the tab groups them by role). */
export const MATTER_PARTIES_QUERY: QuerySpec<MatterParty> = { pageSize: 200 };

// ---------- overview ----------

const task = Task.schema.shape;

export const MatterTaskSchema = /* @__PURE__ */ z.object({
  title: task.title,
  status: task.status,
  priority: task.priority,
  assigneeUid: task.assigneeUid,
  dueDate: task.dueDate,
  order: task.order,
  deletedAt: SoftDeleteShape.deletedAt,
});
export type MatterTask = z.infer<typeof MatterTaskSchema>;

export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'blocked'];

/** A matter's open tasks. An `in` filter alone needs no composite index; the overview sorts them. */
export const OPEN_TASKS_QUERY: QuerySpec<MatterTask> = {
  where: [['status', 'in', [...OPEN_TASK_STATUSES]]],
  pageSize: 50,
};

export function matterTasksRepository(matterId: () => string | null): Repository<MatterTask> {
  return matterRecords(matterId, 'tasks', MatterTaskSchema, Task.version);
}

const deadline = Deadline.schema.shape;

export const MatterDeadlineSchema = /* @__PURE__ */ z.object({
  title: deadline.title,
  dueDate: deadline.dueDate,
  critical: deadline.critical,
  status: deadline.status,
  override: deadline.override,
  deletedAt: SoftDeleteShape.deletedAt,
});
export type MatterDeadline = z.infer<typeof MatterDeadlineSchema>;

/** Deadlines still to meet (overdue ones are `missed` until done or waived). */
export const OPEN_DEADLINE_STATUSES: readonly DeadlineStatus[] = ['upcoming', 'blocked', 'missed'];

/** A matter's open deadlines; the overview sorts them by (overridden) due date. */
export const OPEN_DEADLINES_QUERY: QuerySpec<MatterDeadline> = {
  where: [['status', 'in', [...OPEN_DEADLINE_STATUSES]]],
  pageSize: 50,
};

export function matterDeadlinesRepository(matterId: () => string | null): Repository<MatterDeadline> {
  return matterRecords(matterId, 'deadlines', MatterDeadlineSchema, Deadline.version);
}

const activity = Activity.schema.shape;

export const MatterActivitySchema = /* @__PURE__ */ z.object({
  kind: activity.kind,
  summary: activity.summary,
  actorUid: activity.actorUid,
  at: activity.at,
});
export type MatterActivity = z.infer<typeof MatterActivitySchema>;

/** The latest entries of a matter's activity feed. */
export const RECENT_ACTIVITY_QUERY: QuerySpec<MatterActivity> = { orderBy: [['at', 'desc']], pageSize: 5 };

export function matterActivityRepository(matterId: () => string | null): Repository<MatterActivity> {
  return matterRecords(matterId, 'activity', MatterActivitySchema, Activity.version);
}

// ---------- templates ----------

const template = MatterTemplate.schema.shape;

export const MatterTemplateStagesSchema = /* @__PURE__ */ z.object({
  name: template.name,
  matterType: template.matterType,
  stages: template.stages,
});
export type MatterTemplateStages = z.infer<typeof MatterTemplateStagesSchema>;

/** Matter templates (`orgs/{orgId}/templates`, CORE-07), read for their stages. */
export function matterTemplatesRepository(): Repository<MatterTemplateStages> {
  return repo((orgId) => `orgs/${orgId}/templates`, {
    schema: MatterTemplateStagesSchema,
    version: MatterTemplate.version,
  });
}

// ---------- callables ----------

/** Callable input without the request id, which the client adds. */
type Input<T> = Omit<T, 'requestId'>;

/** The matter screen's `matters-*` callables, typed (CORE-06). Every call is idempotent. */
export interface MatterCallables {
  /** `matters-changeStatus` (matter.status). */
  changeStatus(input: Input<ChangeMatterStatusInput>): Promise<ChangeMatterStatusResult>;
  /** `matters-changeStage` (matter.edit); `MATTER_STAGE_REQUIREMENTS` lists missing key facts. */
  changeStage(input: Input<ChangeMatterStageInput>): Promise<ChangeMatterStageResult>;
  /** `matters-upsertParty` (matter.edit): add a contact in a role, or edit a party row. */
  upsertParty(input: Input<UpsertPartyInput>): Promise<PartyResult>;
  /** `matters-removeParty` (matter.edit): soft-deletes the row; `LAST_CLIENT` keeps the last client. */
  removeParty(input: Input<RemovePartyInput>): Promise<PartyResult>;
}

export function matterCallables(client: Pick<CallableClient, 'call'>): MatterCallables {
  const call =
    <I extends object, O>(name: string) =>
    (input: I) =>
      client.call<I, O>(name, input, { idempotent: true });
  return {
    changeStatus: call(MATTER_CALLABLES.changeStatus),
    changeStage: call(MATTER_CALLABLES.changeStage),
    upsertParty: call(MATTER_CALLABLES.upsertParty),
    removeParty: call(MATTER_CALLABLES.removeParty),
  };
}
