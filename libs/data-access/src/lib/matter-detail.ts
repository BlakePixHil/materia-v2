import { inject, Injector, runInInjectionContext } from '@angular/core';
import * as z from 'zod';

import {
  Activity,
  Deadline,
  Matter,
  MatterTemplate,
  MatterTemplateVersion,
  Party,
  StageEntryRequiresSchema,
  systemTemplate,
  SoftDeleteShape,
  Task,
  type ChangeMatterStageInput,
  type ChangeMatterStageResult,
  type ChangeMatterStatusInput,
  type ChangeMatterStatusResult,
  type CloseMatterInput,
  type CloseMatterResult,
  type ClosingChecklistInput,
  type ClosingChecklistResult,
  type DeadlineStatus,
  type PartyResult,
  type RemovePartyInput,
  type RenumberMatterInput,
  type RenumberMatterResult,
  type ReopenMatterInput,
  type ReopenMatterResult,
  type SetLegalHoldInput,
  type SetLegalHoldResult,
  type TaskStatus,
  type TemplateStageLike,
  type UpgradeMatterTemplateInput,
  type UpgradeMatterTemplateResult,
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
  templateVersion: matter.templateVersion,
  jurisdiction: matter.jurisdiction,
  responsibleUid: matter.responsibleUid,
  teamUids: matter.teamUids,
  clientContactIds: matter.clientContactIds,
  deceased: matter.deceased,
  testator: matter.testator,
  /** The referral (CORE-18): a referrer contact or a source. */
  referrerContactId: matter.referrerContactId,
  referralSource: matter.referralSource,
  estate: matter.estate,
  facts: matter.facts,
  privileged: matter.privileged,
  /** The fee arrangement (BILL-01: a rate override, and fixed-fee time isn't billable by default). */
  fee: matter.fee.optional(),
  /** The budget against the fee (BILL-05), kept by the fees triggers. */
  budget: matter.budget,
  /** What its issued invoices still owe (BILL-08), kept by `billing-outstandingOnInvoice`. */
  outstandingCents: matter.outstandingCents,
  priority: matter.priority,
  labels: matter.labels,
  externalRef: matter.externalRef,
  /** Read as any string: the UI links it only when `isMatterLink` (a bad value never hides the matter). */
  externalUrl: z.string().optional(),
  conflictCheck: matter.conflictCheck.optional(),
  conflictAlert: ConflictAlertSchema.nullable().optional(),
  openTaskCount: matter.openTaskCount,
  /** The estate register's totals (CORE-16), kept by `estate-onWrite`. */
  estateRegister: matter.estateRegister,
  closedAt: matter.closedAt,
  closeReason: matter.closeReason,
  /** Retention (CORE-19): the earliest destruction date, the closing record, archiving and holds. */
  destroyAfter: matter.destroyAfter,
  closing: matter.closing,
  archivedAt: matter.archivedAt,
  legalHold: matter.legalHold,
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
  /** The event a template task's due date waits for (CORE-07), while it has no due date. */
  duePending: task.duePending,
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

/**
 * A deadline as the overview lists it: `dueDate` is the date in force (an override applied) and is
 * absent while `blocked` (CORE-10), with the rule's provenance for the trace.
 */
export const MatterDeadlineSchema = /* @__PURE__ */ z.object({
  title: deadline.title,
  dueDate: deadline.dueDate,
  dueTime: deadline.dueTime,
  kind: deadline.kind,
  critical: deadline.critical,
  status: deadline.status,
  blockedReason: deadline.blockedReason,
  computed: deadline.computed,
  override: deadline.override,
  overrideConflict: deadline.overrideConflict,
  pastOnCreation: deadline.pastOnCreation,
  deletedAt: SoftDeleteShape.deletedAt,
});
export type MatterDeadline = z.infer<typeof MatterDeadlineSchema>;

/**
 * Deadlines still to meet: upcoming (overdue ones stay upcoming until done, waived or confirmed
 * missed) and blocked ones waiting on an event (CORE-10). Missed is closed.
 */
export const OPEN_DEADLINE_STATUSES: readonly DeadlineStatus[] = ['upcoming', 'blocked'];

/** A matter's open deadlines; the overview sorts them with `compareDeadlines`. */
export const OPEN_DEADLINES_QUERY: QuerySpec<MatterDeadline> = {
  where: [['status', 'in', [...OPEN_DEADLINE_STATUSES]]],
  pageSize: 50,
};

export function matterDeadlinesRepository(matterId: () => string | null): Repository<MatterDeadline> {
  return matterRecords(matterId, 'deadlines', MatterDeadlineSchema, Deadline.version);
}

const activity = Activity.schema.shape;

/**
 * A matter activity item (written by server triggers): an actor-less `summary` ("Added a note"),
 * who did it and when, and `refs` to what it's about (`{ noteId }`, `{ taskId }`; CORE-13).
 */
export const MatterActivitySchema = /* @__PURE__ */ z.object({
  kind: activity.kind,
  summary: activity.summary,
  actorUid: activity.actorUid,
  at: activity.at,
  refs: activity.refs,
});
export type MatterActivity = z.infer<typeof MatterActivitySchema>;

/** The latest entries of a matter's activity feed, for the Overview (CORE-13: three). */
export const RECENT_ACTIVITY_QUERY: QuerySpec<MatterActivity> = { orderBy: [['at', 'desc']], pageSize: 3 };

/** The Activity tab (CORE-13): the whole feed, newest first, 25 a page ("Load more"). Single-field order. */
export const MATTER_ACTIVITY_QUERY: QuerySpec<MatterActivity> = { orderBy: [['at', 'desc']], pageSize: 25 };

export function matterActivityRepository(matterId: () => string | null): Repository<MatterActivity> {
  return matterRecords(matterId, 'activity', MatterActivitySchema, Activity.version);
}

// ---------- templates ----------

const template = MatterTemplate.schema.shape;

/**
 * A template stage as the stepper reads it: CORE-07 stages (`name`, `criteria`, `entryRequires`,
 * `terminal`) and CORE-06 ones (`title`) both parse; other fields are dropped.
 */
export const MatterTemplateStageSchema = /* @__PURE__ */ z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  title: z.string().optional(),
  criteria: z.string().optional(),
  entryRequires: StageEntryRequiresSchema.optional(),
  terminal: z.boolean().optional(),
});

/** A template task as the matter screen names it (requirement notes): its key and title. */
export const MatterTemplateTaskNameSchema = /* @__PURE__ */ z.object({ key: z.string().min(1), title: z.string() });
export type MatterTemplateTaskName = z.infer<typeof MatterTemplateTaskNameSchema>;

export const MatterTemplateStagesSchema = /* @__PURE__ */ z.object({
  name: template.name,
  matterType: template.matterType,
  /** The latest published version (a draft document) or this version's number (a version document). */
  version: z.number().int().min(0).optional(),
  stages: z.array(MatterTemplateStageSchema),
  tasks: z.array(MatterTemplateTaskNameSchema).optional(),
});
export type MatterTemplateStages = z.infer<typeof MatterTemplateStagesSchema>;

/** Matter templates (`orgs/{orgId}/templates`, CORE-07): the org's drafts, read for their stages. */
export function matterTemplatesRepository(): Repository<MatterTemplateStages> {
  return repo((orgId) => `orgs/${orgId}/templates`, {
    schema: MatterTemplateStagesSchema,
    version: MatterTemplate.version,
  });
}

/** A template's published versions (`orgs/{orgId}/templates/{id}/versions/{n}`, CORE-07), immutable. */
export function matterTemplateVersionsRepository(templateId: string): Repository<MatterTemplateStages> {
  return repo((orgId) => `orgs/${orgId}/templates/${templateId}/versions`, {
    schema: MatterTemplateStagesSchema,
    version: MatterTemplateVersion.version,
  });
}

/** What the matter screen reads of a matter's template version: its stages and its tasks' names. */
export interface MatterTemplateOutline {
  stages: TemplateStageLike[];
  tasks: MatterTemplateTaskName[];
}

/**
 * Reads a matter's template (CORE-07), as `matters-changeStage` does: the bundled system template
 * (`system-{type}`), the matter's published version, else the template document; null when there
 * is none (the type's default stages apply). Create it in an injection context.
 */
export function matterTemplateLoader(): (
  templateId: string,
  version?: number | null,
) => Promise<MatterTemplateOutline | null> {
  const injector = inject(Injector);
  const drafts = matterTemplatesRepository();
  const outline = (found: MatterTemplateStages): MatterTemplateOutline => ({
    stages: found.stages,
    tasks: (found.tasks ?? []).map(({ key, title }) => ({ key, title })),
  });
  return async (templateId, version) => {
    const system = systemTemplate(templateId);
    if (system) return { stages: system.stages, tasks: system.tasks.map(({ key, title }) => ({ key, title })) };
    if (version) {
      const versions = runInInjectionContext(injector, () => matterTemplateVersionsRepository(templateId));
      const found = await versions.get(String(version));
      if (found?.stages.length) return outline(found);
    }
    const draft = await drafts.get(templateId);
    return draft?.stages.length ? outline(draft) : null;
  };
}

/** A matter's template stages only (see `matterTemplateLoader`). Create it in an injection context. */
export function matterTemplateStagesLoader(): (
  templateId: string,
  version?: number | null,
) => Promise<TemplateStageLike[] | null> {
  const load = matterTemplateLoader();
  return async (templateId, version) => (await load(templateId, version))?.stages ?? null;
}

// ---------- callables ----------

/** Callable input without the request id, which the client adds. */
type Input<T> = Omit<T, 'requestId'>;

/** The matter screen's `matters-*` callables, typed (CORE-06). Every call is idempotent. */
export interface MatterCallables {
  /** `matters-changeStatus` (matter.status). */
  changeStatus(input: Input<ChangeMatterStatusInput>): Promise<ChangeMatterStatusResult>;
  /** `matters-changeStage` (matter.edit); `MATTER_STAGE_REQUIREMENTS` lists missing key facts (and, CORE-07, events and tasks). */
  changeStage(input: Input<ChangeMatterStageInput>): Promise<ChangeMatterStageResult>;
  /** `matters-upsertParty` (matter.edit): add a contact in a role, or edit a party row. */
  upsertParty(input: Input<UpsertPartyInput>): Promise<PartyResult>;
  /** `matters-removeParty` (matter.edit): soft-deletes the row; `LAST_CLIENT` keeps the last client. */
  removeParty(input: Input<RemovePartyInput>): Promise<PartyResult>;
  /** `matters-upgradeTemplate` (matter.edit, CORE-07): a later version of the matter's template; adds missing tasks only. */
  upgradeTemplate(input: Input<UpgradeMatterTemplateInput>): Promise<UpgradeMatterTemplateResult>;
  /** `matters-renumber` (matter.renumber, CORE-21a): a typed number, unique per org (`ALREADY_EXISTS` otherwise). */
  renumber(input: Input<RenumberMatterInput>): Promise<RenumberMatterResult>;
  /** `matters-closingChecklist` (matter.close, CORE-19): the checklist as it stands, with the retention date closing would set. */
  closingChecklist(input: ClosingChecklistInput): Promise<ClosingChecklistResult>;
  /** `matters-close` (matter.close, CORE-19): `closing_checklist` lists what's still to do. */
  close(input: Input<CloseMatterInput>): Promise<CloseMatterResult>;
  /** `matters-reopen` (matter.status, CORE-19): a closed or archived matter back to open, with a reason. */
  reopen(input: Input<ReopenMatterInput>): Promise<ReopenMatterResult>;
  /** `matters-setLegalHold` (matter.legalHold, CORE-19): a hold keeps the matter from destruction. */
  setLegalHold(input: Input<SetLegalHoldInput>): Promise<SetLegalHoldResult>;
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
    upgradeTemplate: call(MATTER_CALLABLES.upgradeTemplate),
    renumber: call(MATTER_CALLABLES.renumber),
    closingChecklist: (input) =>
      client.call<ClosingChecklistInput, ClosingChecklistResult>(MATTER_CALLABLES.closingChecklist, input),
    close: call(MATTER_CALLABLES.close),
    reopen: call(MATTER_CALLABLES.reopen),
    setLegalHold: call(MATTER_CALLABLES.setLegalHold),
  };
}
