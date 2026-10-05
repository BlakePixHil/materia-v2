import { z } from 'zod';

import { CentsSchema, DateOnlySchema, DocIdSchema, InstantSchema, NonEmptyString, withMeta } from './common';
import {
  DeadlineKindSchema,
  DeadlineStatusSchema,
  DocumentCategorySchema,
  DocumentSourceSchema,
  EventKindSchema,
  GstTreatmentSchema,
  PartyRoleSchema,
  PrioritySchema,
  TaskStatusSchema,
  TimeEntryStatusSchema,
} from './enums';
import { MinutesSchema } from '../values/minutes';

const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Expected HH:MM (24h)' });
const MATTER = 'orgs/{orgId}/matters/{matterId}';

/** Collection-group-queried docs carry orgId and matterId (Domain doc, Indexes rule). */
const GroupKeys = { orgId: DocIdSchema, matterId: DocIdSchema };

export const Party = withMeta(
  {
    contactId: DocIdSchema,
    role: PartyRoleSchema,
    share: z.string().optional(),
    notes: z.string().optional(),
    addedFrom: z.enum(['manual', 'clerk', 'migration']).default('manual'),
    // Queried across matters by contact ("the matters this contact is on", CORE-01).
    ...GroupKeys,
  },
  {
    path: `${MATTER}/parties`,
    softDelete: true,
    serverOwned: ['orgId', 'matterId'],
    // The row id is `partyDocId(role, contactId)` and the matter's `clientContactIds` follows the
    // client rows, so contact, role and removal go through `matters-upsertParty`/`removeParty` (CORE-06).
    updatable: ['share', 'notes'],
  },
);

/** Limits the rules enforce on client-written tasks (CORE-08). */
export const TASK_TITLE_MAX = 500;
export const TASK_GROUP_MAX = 120;
export const TASK_CHECKLIST_MAX = 100;

/** A checklist item inside a task (CORE-08), ticked inline. */
export const ChecklistItemSchema = z.object({ id: z.string().min(1), text: z.string().max(500), done: z.boolean() });
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

const taskShape = {
  title: NonEmptyString.max(TASK_TITLE_MAX),
  descriptionMd: z.string().optional(),
  status: TaskStatusSchema,
  priority: PrioritySchema.default('none'),
  assigneeUid: DocIdSchema.optional(),
  dueDate: DateOnlySchema.optional(),
  deadlineId: DocIdSchema.optional(),
  group: z.string().max(TASK_GROUP_MAX).optional(),
  checklist: z.array(ChecklistItemSchema).max(TASK_CHECKLIST_MAX).default([]),
  /** Fractional sort key (CORE-08): a move writes the midpoint of its neighbours (`orderBetween`). */
  order: z.number(),
  /** `rule`: created by a deadline rule's `createsTask` (CORE-10), linked by `deadlineId`. */
  source: z.enum(['manual', 'template', 'clerk', 'migration', 'rule']).default('manual'),
  /** Set by `tasks-onWrite` when the status becomes `done`, removed when the task is reopened. */
  completedAt: InstantSchema.optional(),
};

/**
 * The fields clients change directly (CORE-08): title, status, priority, assignee, due date,
 * checklist, order and group, plus soft delete. The description, deadline link and source are set
 * when the task is created.
 */
const TASK_UPDATABLE = [
  'title',
  'status',
  'priority',
  'assigneeUid',
  'dueDate',
  'checklist',
  'order',
  'group',
] as const;

/**
 * `matters/{matterId}/tasks/{taskId}`. Template tasks (CORE-07) have the id `tpl-{templateTaskKey}`
 * (one per matter and template task) and, while their anchor event is unknown, no `dueDate` and
 * `duePending` naming the event ("due date pending: date of death unknown"). `countedOpen` records
 * whether the task is counted in the matter's `openTaskCount` (server-owned, CORE-08): `tasks-onWrite`
 * reconciles it, and a server writer that counts a task itself sets it to `true`.
 */
export const Task = withMeta(
  {
    ...taskShape,
    ...GroupKeys,
    templateTaskKey: z.string().optional(),
    duePending: EventKindSchema.optional(),
    countedOpen: z.boolean().optional(),
  },
  {
    path: `${MATTER}/tasks`,
    softDelete: true,
    serverOwned: ['orgId', 'matterId', 'completedAt', 'templateTaskKey', 'duePending', 'countedOpen'],
    updatable: TASK_UPDATABLE,
  },
);

/**
 * `orgs/{orgId}/members/{uid}/tasks/{taskId}`: personal tasks, private to their member (even admins
 * can't read them). Same shape as matter tasks with `matterId: null` (the `tasks` collection group
 * holds both) and `assigneeUid` always the owner, so "assigned to me" finds them too.
 */
export const PersonalTask = withMeta(
  { ...taskShape, orgId: DocIdSchema, matterId: z.null().default(null) },
  {
    path: 'orgs/{orgId}/members/{uid}/tasks',
    softDelete: true,
    serverOwned: ['orgId', 'matterId', 'completedAt'],
    updatable: TASK_UPDATABLE,
  },
);

/**
 * `matters/{matterId}/events/{eventId}`: key facts that drive deadlines. Written only through the
 * `deadlines-upsertEvent` and `deadlines-deleteEvent` callables (CORE-10), which recompute the
 * matter's deadlines in the same transaction; clients read them.
 */
export const MatterEvent = withMeta(
  {
    kind: EventKindSchema,
    date: DateOnlySchema,
    time: TimeOfDay.optional(),
    label: z.string().max(200).optional(),
    meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
    sourceDocumentId: DocIdSchema.optional(),
  },
  { path: `${MATTER}/events`, softDelete: true, updatable: [] },
);

/** Why a deadline has no date yet (CORE-10): its anchor event, calendar data, or a bad input. */
export const DeadlineBlockedCodeSchema = z.enum(['anchor_missing', 'calendar_missing', 'invalid_input']);
export type DeadlineBlockedCode = z.infer<typeof DeadlineBlockedCodeSchema>;

/**
 * A computed deadline's provenance (ADR-009): the rule, its rule-set version and citation, the
 * anchor event, the inputs and the rendered trace. `dueDate` is the engine's latest date, which
 * differs from the deadline's `dueDate` while an override stands.
 */
export const ComputedSchema = z.object({
  ruleId: NonEmptyString,
  ruleSetId: NonEmptyString,
  ruleSetVersion: z.number().int().min(1),
  /** Absent for composite rules and for a rule blocked on a missing anchor. */
  anchorEventId: DocIdSchema.optional(),
  inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  trace: z.array(z.string()),
  citation: z.string().optional(),
  /** The rule's plain-language explanation. */
  explain: z.string().optional(),
  dueDate: DateOnlySchema.optional(),
  /** Computed from an approximate anchor (the earliest possible date). */
  approximate: z.boolean().optional(),
  /** The rule is marked `verify` in its rule set: it needs particular practitioner attention. */
  verify: z.boolean().optional(),
});
export type DeadlineComputed = z.infer<typeof ComputedSchema>;

/** Limits on client-entered (manual) deadlines (CORE-10); the rules enforce them too. */
export const DEADLINE_TITLE_MAX = 300;
export const DEADLINE_REMINDERS_MAX = 10;
export const DEADLINE_REASON_MAX = 1000;

/**
 * `matters/{matterId}/deadlines/{deadlineId}`. Every computed deadline records its rule (ADR-009).
 *
 * Computed deadlines (`computed` set, id `rule-{ruleId}`) are written by the recompute (CORE-10);
 * clients change only their assignee and acknowledgement. Manual ones (no `computed`; kind
 * contractual, internal or court) are created and edited by clients directly. Status changes go
 * through `deadlines-complete` (done, waived, missed), `deadlines-override` and
 * `deadlines-resolveChange`. `dueDate` is the date in force (the override when there is one) and
 * is absent only while `status` is `blocked`.
 */
export const Deadline = withMeta(
  {
    ...GroupKeys,
    title: NonEmptyString.max(DEADLINE_TITLE_MAX),
    dueDate: DateOnlySchema.optional(),
    dueTime: TimeOfDay.optional(),
    kind: DeadlineKindSchema,
    critical: z.boolean(),
    status: DeadlineStatusSchema,
    blockedReason: z.string().optional(),
    blockedCode: DeadlineBlockedCodeSchema.optional(),
    computed: ComputedSchema.optional(),
    override: z
      .object({ dueDate: DateOnlySchema, reason: NonEmptyString, by: DocIdSchema, at: InstantSchema })
      .optional(),
    /** The engine's date is now earlier than the override (CORE-10): the deadline is flagged. */
    overrideConflict: z.boolean().optional(),
    /** The proposal the responsible lawyer last rejected: the same proposal isn't made again. */
    declined: z
      .object({
        kind: z.enum(['moved', 'removed']),
        dueDate: DateOnlySchema.optional(),
        by: DocIdSchema,
        at: InstantSchema,
      })
      .optional(),
    /** How a done, waived or missed deadline was closed (`deadlines-complete`). */
    resolution: z
      .object({
        on: DateOnlySchema,
        by: z.string().min(1),
        at: InstantSchema,
        reason: z.string().max(DEADLINE_REASON_MAX).optional(),
      })
      .optional(),
    /** Set by the daily missed check: past its date, waiting for a person to confirm it missed. */
    missedCheck: z.object({ since: DateOnlySchema, at: InstantSchema }).optional(),
    /** The task its rule created (`createsTask`), which links back with `deadlineId`. */
    taskId: DocIdSchema.optional(),
    reminders: z
      .array(z.object({ offsetDays: z.number().int(), sentAt: InstantSchema.optional() }))
      .max(DEADLINE_REMINDERS_MAX)
      .default([]),
    assigneeUid: DocIdSchema,
    calendar: z
      .record(
        z.string(),
        z.object({ provider: z.enum(['microsoft', 'google']), eventId: z.string(), etag: z.string() }),
      )
      .optional(),
    nextReminderAt: InstantSchema.optional(),
    ackBy: DocIdSchema.optional(),
    ackAt: InstantSchema.optional(),
    /** Already past when computed: in the review queue, never marked missed automatically. */
    pastOnCreation: z.boolean().default(false),
  },
  {
    path: `${MATTER}/deadlines`,
    softDelete: true,
    serverOwned: [
      'orgId',
      'matterId',
      'status',
      'blockedReason',
      'blockedCode',
      'computed',
      'override',
      'overrideConflict',
      'declined',
      'resolution',
      'missedCheck',
      'taskId',
      'calendar',
      'nextReminderAt',
      'pastOnCreation',
    ],
    // Manual deadlines change these; computed ones only assigneeUid, ackBy and ackAt (the rules).
    updatable: ['title', 'dueDate', 'dueTime', 'kind', 'critical', 'assigneeUid', 'reminders', 'ackBy', 'ackAt'],
  },
);

export const DeadlineChangeStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'superseded']);
export type DeadlineChangeStatus = z.infer<typeof DeadlineChangeStatusSchema>;
export const DeadlineChangeKindSchema = z.enum(['moved', 'removed']);
export type DeadlineChangeKind = z.infer<typeof DeadlineChangeKindSchema>;
/** What made the recompute that proposed a change. */
export const DeadlineChangeCauseSchema = z.enum(['event', 'stage', 'recompute', 'ruleset_upgrade', 'matter_created']);
export type DeadlineChangeCause = z.infer<typeof DeadlineChangeCauseSchema>;

/**
 * `matters/{matterId}/deadlineChanges/{changeId}` (CORE-10): a recompute's proposal for an upcoming
 * computed deadline, never a silent change. `moved` proposes `toDueDate` (with its provenance in
 * `computed`); `removed` proposes marking the deadline superseded (its anchor was deleted or its
 * rule no longer applies). Decided through `deadlines-resolveChange`; a later recompute supersedes
 * a pending proposal that no longer holds. Written by functions only; members read them.
 */
export const DeadlineChange = withMeta(
  {
    ...GroupKeys,
    deadlineId: DocIdSchema,
    ruleId: NonEmptyString,
    title: NonEmptyString,
    critical: z.boolean(),
    kind: DeadlineChangeKindSchema,
    cause: DeadlineChangeCauseSchema,
    status: DeadlineChangeStatusSchema,
    fromDueDate: DateOnlySchema,
    toDueDate: DateOnlySchema.optional(),
    /** The new date is earlier than the current one. */
    earlier: z.boolean(),
    /** The new date has already passed (critical: high-priority notification and a red banner). */
    intoPast: z.boolean(),
    /** Why a `removed` proposal: the engine's reason ("No grant yet"). */
    reason: z.string().optional(),
    computed: ComputedSchema.optional(),
    /** Who decides: the matter's responsible lawyer when it was proposed. */
    assigneeUid: DocIdSchema,
    recomputeVersion: z.number().int().min(0),
    resolvedBy: DocIdSchema.optional(),
    resolvedAt: InstantSchema.optional(),
  },
  {
    path: `${MATTER}/deadlineChanges`,
    migratable: false,
    serverOwned: [
      'orgId',
      'matterId',
      'deadlineId',
      'ruleId',
      'title',
      'critical',
      'kind',
      'cause',
      'status',
      'fromDueDate',
      'toDueDate',
      'earlier',
      'intoPast',
      'reason',
      'computed',
      'assigneeUid',
      'recomputeVersion',
      'resolvedBy',
      'resolvedAt',
    ],
    updatable: [],
  },
);

/** `matters/{matterId}/documents/{docId}`. */
export const MatterDocument = withMeta(
  {
    ...GroupKeys,
    name: NonEmptyString,
    storagePath: z.string().regex(/^orgs\/[^/]+\/matters\/[^/]+\/documents\/[^/]+\/v\d+$/),
    mime: z.string().min(3),
    sizeBytes: z.number().int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    version: z.number().int().min(1),
    category: DocumentCategorySchema,
    privileged: z.boolean().default(false),
    scan: z.object({ status: z.enum(['pending', 'clean', 'infected', 'error']) }),
    ingest: z.object({
      status: z.enum(['pending', 'done', 'failed', 'skipped']),
      pages: z.number().int().optional(),
      ocr: z.boolean().optional(),
      error: z.string().optional(),
    }),
    source: DocumentSourceSchema,
    pageCount: z.number().int().optional(),
    encrypted: z.boolean().default(false),
    accessRestricted: z.boolean().default(false),
    renditions: z.object({ previewPdf: z.string().optional() }).optional(),
  },
  {
    path: `${MATTER}/documents`,
    softDelete: true,
    serverOwned: [
      'orgId',
      'matterId',
      'storagePath',
      'sha256',
      'sizeBytes',
      'version',
      'scan',
      'ingest',
      'renditions',
      'pageCount',
    ],
    updatable: ['name', 'category', 'privileged', 'accessRestricted'],
  },
);

/** `documents/{docId}/chunks/{n}`. Written by functions only. */
export const Chunk = withMeta(
  {
    ...GroupKeys,
    text: z.string(),
    page: z.number().int().min(1),
    // Vector(768) in Firestore; a number array in the domain model (ADR-012).
    embedding: z.array(z.number()).length(768),
  },
  { path: `${MATTER}/documents/{docId}/chunks`, migratable: false },
);

/** `matters/{matterId}/notes/{noteId}`. Mentions are `@[uid]` and `#[matterId]` tokens. */
export const Note = withMeta(
  {
    bodyMd: z.string().max(100_000),
    mentions: z.object({ uids: z.array(DocIdSchema), matterIds: z.array(DocIdSchema) }),
    pinned: z.boolean().default(false),
    privileged: z.boolean().default(false),
    source: z.enum(['manual', 'clerk', 'migration', 'voice']).default('manual'),
  },
  { path: `${MATTER}/notes`, softDelete: true, serverOwned: ['mentions'] },
);

/** `matters/{matterId}/activity/{id}`: the feed's read model, written by triggers. */
export const Activity = withMeta(
  {
    kind: NonEmptyString,
    summary: z.string(),
    actorUid: z.string(),
    at: InstantSchema,
    refs: z.record(z.string(), z.string()).default({}),
  },
  { path: `${MATTER}/activity`, migratable: false },
);

/** `matters/{matterId}/timeEntries/{id}`. */
export const TimeEntry = withMeta(
  {
    ...GroupKeys,
    uid: DocIdSchema,
    date: DateOnlySchema,
    minutes: MinutesSchema,
    units: z.number().int().min(0),
    rateCents: CentsSchema,
    amountCents: CentsSchema,
    narrative: z.string(),
    billable: z.boolean(),
    status: TimeEntryStatusSchema,
    invoiceId: DocIdSchema.optional(),
    source: z.enum(['manual', 'timer', 'voice', 'clerk', 'migration']).default('manual'),
    taskId: DocIdSchema.optional(),
    writeDown: z
      .object({
        originalUnits: z.number().int(),
        originalAmountCents: CentsSchema,
        by: DocIdSchema,
        reason: z.string(),
      })
      .optional(),
  },
  {
    path: `${MATTER}/timeEntries`,
    softDelete: true,
    serverOwned: ['orgId', 'matterId', 'units', 'amountCents', 'invoiceId', 'writeDown'],
  },
);

/** `matters/{matterId}/disbursements/{id}`. */
export const Disbursement = withMeta(
  {
    date: DateOnlySchema,
    description: NonEmptyString,
    amountExGstCents: CentsSchema,
    gstCents: CentsSchema,
    gstTreatment: GstTreatmentSchema,
    payee: z.string(),
    receiptDocumentId: DocIdSchema.optional(),
    status: z.enum(['draft', 'final', 'billed', 'written_off']),
    invoiceId: DocIdSchema.optional(),
  },
  { path: `${MATTER}/disbursements`, softDelete: true, serverOwned: ['gstCents', 'invoiceId'] },
);

/** `matters/{matterId}/assets/{id}`: the estate register. */
export const Asset = withMeta(
  {
    class: z.enum([
      'real_property',
      'bank',
      'shares',
      'superannuation',
      'insurance',
      'vehicle',
      'personal',
      'business',
      'debt_owed_to_estate',
      'other',
    ]),
    description: NonEmptyString,
    valueAtDeathCents: CentsSchema,
    valuationSource: z.string(),
    jointlyHeld: z.boolean(),
    passesOutsideEstate: z.boolean(),
    status: z.enum(['identified', 'valued', 'realised', 'transferred']),
    realisedCents: CentsSchema.optional(),
  },
  { path: `${MATTER}/assets`, softDelete: true },
);

export const Liability = withMeta(
  {
    class: z.enum(['mortgage', 'credit_card', 'loan', 'tax', 'funeral', 'medical', 'utility', 'other']),
    creditor: NonEmptyString,
    amountCents: CentsSchema,
    status: z.enum(['notified', 'paid', 'disputed']),
  },
  { path: `${MATTER}/liabilities`, softDelete: true },
);

export const Distribution = withMeta(
  {
    beneficiaryPartyId: DocIdSchema,
    kind: z.enum(['specific', 'pecuniary', 'residuary']),
    amountCents: CentsSchema.optional(),
    assetId: DocIdSchema.optional(),
    status: z.enum(['planned', 'approved', 'paid', 'cancelled']),
    paidOn: DateOnlySchema.optional(),
  },
  { path: `${MATTER}/distributions`, softDelete: true },
);

export type Party = z.infer<typeof Party.schema>;
export type Task = z.infer<typeof Task.schema>;
export type PersonalTask = z.infer<typeof PersonalTask.schema>;
export type MatterEvent = z.infer<typeof MatterEvent.schema>;
export type Deadline = z.infer<typeof Deadline.schema>;
export type DeadlineChange = z.infer<typeof DeadlineChange.schema>;
export type MatterDocument = z.infer<typeof MatterDocument.schema>;
export type Chunk = z.infer<typeof Chunk.schema>;
export type Note = z.infer<typeof Note.schema>;
export type Activity = z.infer<typeof Activity.schema>;
export type TimeEntry = z.infer<typeof TimeEntry.schema>;
export type Disbursement = z.infer<typeof Disbursement.schema>;
export type Asset = z.infer<typeof Asset.schema>;
export type Liability = z.infer<typeof Liability.schema>;
export type Distribution = z.infer<typeof Distribution.schema>;
