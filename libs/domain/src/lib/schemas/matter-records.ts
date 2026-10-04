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

const taskShape = {
  title: NonEmptyString,
  descriptionMd: z.string().optional(),
  status: TaskStatusSchema,
  priority: PrioritySchema.default('none'),
  assigneeUid: DocIdSchema.optional(),
  dueDate: DateOnlySchema.optional(),
  deadlineId: DocIdSchema.optional(),
  group: z.string().optional(),
  checklist: z.array(z.object({ id: z.string(), text: z.string(), done: z.boolean() })).default([]),
  order: z.number(),
  source: z.enum(['manual', 'template', 'clerk', 'migration']).default('manual'),
  completedAt: InstantSchema.optional(),
};

/**
 * `matters/{matterId}/tasks/{taskId}`. Template tasks (CORE-07) have the id `tpl-{templateTaskKey}`
 * (one per matter and template task) and, while their anchor event is unknown, no `dueDate` and
 * `duePending` naming the event ("due date pending: date of death unknown").
 */
export const Task = withMeta(
  {
    ...taskShape,
    ...GroupKeys,
    templateTaskKey: z.string().optional(),
    duePending: EventKindSchema.optional(),
  },
  {
    path: `${MATTER}/tasks`,
    softDelete: true,
    serverOwned: ['orgId', 'matterId', 'completedAt', 'templateTaskKey', 'duePending'],
  },
);

/** `orgs/{orgId}/members/{uid}/tasks/{taskId}`: personal tasks, same shape without matterId. */
export const PersonalTask = withMeta(
  { ...taskShape, orgId: DocIdSchema },
  { path: 'orgs/{orgId}/members/{uid}/tasks', softDelete: true, serverOwned: ['orgId', 'completedAt'] },
);

/** `matters/{matterId}/events/{eventId}`: key facts that drive deadlines. */
export const MatterEvent = withMeta(
  {
    kind: EventKindSchema,
    date: DateOnlySchema,
    time: TimeOfDay.optional(),
    label: z.string().optional(),
    meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
    sourceDocumentId: DocIdSchema.optional(),
  },
  { path: `${MATTER}/events`, softDelete: true },
);

const ComputedSchema = z.object({
  ruleId: NonEmptyString,
  ruleSetId: NonEmptyString,
  ruleSetVersion: z.number().int().min(1),
  anchorEventId: DocIdSchema,
  inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  trace: z.array(z.string()),
  citation: z.string().optional(),
});

/** `matters/{matterId}/deadlines/{deadlineId}`. Every computed deadline records its rule (ADR-009). */
export const Deadline = withMeta(
  {
    ...GroupKeys,
    title: NonEmptyString,
    dueDate: DateOnlySchema,
    dueTime: TimeOfDay.optional(),
    kind: DeadlineKindSchema,
    critical: z.boolean(),
    status: DeadlineStatusSchema,
    blockedReason: z.string().optional(),
    computed: ComputedSchema.optional(),
    override: z
      .object({ dueDate: DateOnlySchema, reason: NonEmptyString, by: DocIdSchema, at: InstantSchema })
      .optional(),
    reminders: z.array(z.object({ offsetDays: z.number().int(), sentAt: InstantSchema.optional() })).default([]),
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
    pastOnCreation: z.boolean().default(false),
  },
  {
    path: `${MATTER}/deadlines`,
    softDelete: true,
    serverOwned: ['orgId', 'matterId', 'computed', 'calendar', 'nextReminderAt', 'pastOnCreation'],
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
export type MatterDocument = z.infer<typeof MatterDocument.schema>;
export type Chunk = z.infer<typeof Chunk.schema>;
export type Note = z.infer<typeof Note.schema>;
export type Activity = z.infer<typeof Activity.schema>;
export type TimeEntry = z.infer<typeof TimeEntry.schema>;
export type Disbursement = z.infer<typeof Disbursement.schema>;
export type Asset = z.infer<typeof Asset.schema>;
export type Liability = z.infer<typeof Liability.schema>;
export type Distribution = z.infer<typeof Distribution.schema>;
