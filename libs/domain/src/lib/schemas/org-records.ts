import { z } from 'zod';

import {
  CentsSchema,
  DateOnlySchema,
  DocIdSchema,
  InstantSchema,
  MetaShape,
  NonEmptyString,
  SearchTokensSchema,
  withMeta,
} from './common';
import { InvoiceStatusSchema, JurisdictionSchema, MatterTypeSchema, PrioritySchema } from './enums';
import { TemplateBasedOnSchema, templateContentShape } from '../templates';

const ORG = 'orgs/{orgId}';

const InvoiceLineSchema = z.object({
  kind: z.enum(['time', 'disbursement', 'fixed_fee', 'adjustment']),
  refId: DocIdSchema.optional(),
  description: NonEmptyString,
  quantity: z.number().min(0),
  amountExGstCents: CentsSchema,
  gstCents: CentsSchema,
});

const PaymentSchema = z.object({
  id: z.string(),
  date: DateOnlySchema,
  amountCents: CentsSchema,
  method: z.enum(['eft', 'card', 'cheque', 'trust_transfer', 'other']),
  reference: z.string().optional(),
});

/** `invoices/{id}`. Numbers are gapless and never reused; issued invoices are never edited. */
/**
 * `orgs/{orgId}/counters/{name}`: a sequence (`matter-2026` for matter numbers, CORE-03). `next`
 * is the next value to hand out. Server-only: written in transactions by functions.
 */
export const Counter = withMeta(
  { next: z.number().int().min(1) },
  { path: `${ORG}/counters`, migratable: false, serverOwned: ['next'] },
);
export type Counter = z.infer<typeof Counter.schema>;

export const Invoice = withMeta(
  {
    number: z.string(),
    matterId: DocIdSchema,
    issueDate: DateOnlySchema.optional(),
    dueDate: DateOnlySchema.optional(),
    lines: z.array(InvoiceLineSchema),
    subtotalCents: CentsSchema,
    gstCents: CentsSchema,
    totalCents: CentsSchema,
    status: InvoiceStatusSchema,
    pdfDocumentId: DocIdSchema.optional(),
    xero: z.object({ invoiceId: z.string(), syncedAt: InstantSchema, error: z.string().optional() }).optional(),
    payments: z.array(PaymentSchema).default([]),
  },
  {
    path: `${ORG}/invoices`,
    serverOwned: [
      'number',
      'subtotalCents',
      'gstCents',
      'totalCents',
      'status',
      'pdfDocumentId',
      'xero',
      'payments',
      'issueDate',
    ],
    updatable: ['lines', 'dueDate'],
  },
);

/** `creditNotes/{id}`: reverses (part of) an issued invoice. */
export const CreditNote = withMeta(
  {
    number: z.string(),
    invoiceId: DocIdSchema,
    matterId: DocIdSchema,
    issueDate: DateOnlySchema,
    reason: NonEmptyString,
    lines: z.array(InvoiceLineSchema),
    totalCents: CentsSchema,
  },
  { path: `${ORG}/creditNotes`, serverOwned: ['number', 'totalCents'], updatable: [] },
);

/**
 * `templates/{id}`: an org's matter template (CORE-07): the editable draft, plus where it stands.
 * `version` is the latest published version (0 until the first publish) and `published` says
 * whether there is one. Written by the `templates-*` callables only (`templates-clone`, `-save`,
 * `-publish`); system templates ship with the code (`libs/domain/templates/system`).
 */
export const MatterTemplate = withMeta(
  {
    ...templateContentShape,
    version: z.number().int().min(0),
    source: z.enum(['system', 'org']),
    basedOn: TemplateBasedOnSchema.optional(),
    published: z.boolean(),
    publishedAt: InstantSchema.optional(),
    publishedBy: DocIdSchema.optional(),
  },
  { path: `${ORG}/templates`, updatable: [] },
);

/**
 * `templates/{templateId}/versions/{version}`: a published version, immutable (CORE-07). Matters
 * point at one (`templateId` + `templateVersion`), so their stages and tasks never change under
 * them. `stageMapping` maps the stages this version dropped to stages it has (for upgrades).
 */
export const MatterTemplateVersion = withMeta(
  {
    ...templateContentShape,
    templateId: DocIdSchema,
    version: z.number().int().min(1),
    source: z.enum(['system', 'org']),
    basedOn: TemplateBasedOnSchema.optional(),
    published: z.literal(true),
    publishedAt: InstantSchema,
    publishedBy: DocIdSchema,
    stageMapping: z.record(z.string(), z.string()).optional(),
  },
  { path: `${ORG}/templates/{templateId}/versions`, migratable: false, updatable: [] },
);

/** `docTemplates/{id}`: docx templates with merge fields (INT-06). */
export const DocTemplate = withMeta(
  {
    name: NonEmptyString,
    storagePath: z.string(),
    mergeFields: z.array(z.string()).default([]),
    matterTypes: z.array(MatterTypeSchema).default([]),
    active: z.boolean().default(true),
  },
  { path: `${ORG}/docTemplates`, softDelete: true },
);

/** Limits on checklist templates (CORE-08d); the items match a template task's checklist (CORE-07). */
export const CHECKLIST_TEMPLATE_NAME_MAX = 100;
export const CHECKLIST_TEMPLATE_ITEMS_MAX = 30;
export const CHECKLIST_TEMPLATE_ITEM_MAX = 200;
export const CHECKLIST_TEMPLATE_DUE_MAX_DAYS = 365;

/** One checklist line: trimmed, non-empty, on a single line. */
export const ChecklistTemplateItemSchema = NonEmptyString.max(CHECKLIST_TEMPLATE_ITEM_MAX).regex(/^[^\r\n]*$/, {
  message: 'One item per line',
});

/**
 * `orgs/{orgId}/checklistTemplates/{id}` (CORE-08d): a reusable checklist ("Probate kick-off")
 * applied to a task from its details. `priority` and `dueInDays` fill in a task's priority and due
 * date when it has none. Every member reads them; task.edit roles create, edit and soft delete them
 * client-direct (the rules validate the values).
 */
export const ChecklistTemplate = withMeta(
  {
    name: NonEmptyString.max(CHECKLIST_TEMPLATE_NAME_MAX),
    items: z.array(ChecklistTemplateItemSchema).min(1).max(CHECKLIST_TEMPLATE_ITEMS_MAX),
    priority: PrioritySchema.optional(),
    dueInDays: z.number().int().min(0).max(CHECKLIST_TEMPLATE_DUE_MAX_DAYS).optional(),
  },
  { path: `${ORG}/checklistTemplates`, softDelete: true, migratable: false },
);

/** Limits on task group templates (CORE-08f); the name becomes a task's group (≤ 120). */
export const TASK_GROUP_TEMPLATE_NAME_MAX = 120;
export const TASK_GROUP_TEMPLATE_TASKS_MAX = 50;
export const TASK_GROUP_TEMPLATE_TITLE_MAX = 500;

/** One task of a task group template: a single-line title, its checklist lines and defaults. */
export const TaskGroupTemplateTaskSchema = z.object({
  title: NonEmptyString.max(TASK_GROUP_TEMPLATE_TITLE_MAX).regex(/^[^\r\n]*$/, { message: 'One task per line' }),
  checklist: z.array(ChecklistTemplateItemSchema).max(CHECKLIST_TEMPLATE_ITEMS_MAX).default([]),
  priority: PrioritySchema.optional(),
  dueInDays: z.number().int().min(0).max(CHECKLIST_TEMPLATE_DUE_MAX_DAYS).optional(),
});
export type TaskGroupTemplateTask = z.infer<typeof TaskGroupTemplateTaskSchema>;

/**
 * `orgs/{orgId}/taskGroupTemplates/{id}` (CORE-08f): a reusable group of tasks ("Checklist A":
 * tasks, each with its checklist) applied to a matter's Tasks tab, where the tasks land in a group
 * named after the template. Every member reads them; task.edit roles create, edit and soft delete
 * them client-direct (the rules check the name and the list sizes).
 */
export const TaskGroupTemplate = withMeta(
  {
    name: NonEmptyString.max(TASK_GROUP_TEMPLATE_NAME_MAX),
    tasks: z.array(TaskGroupTemplateTaskSchema).min(1).max(TASK_GROUP_TEMPLATE_TASKS_MAX),
  },
  { path: `${ORG}/taskGroupTemplates`, softDelete: true, migratable: false },
);

/**
 * `metrics/{period}`: rollups; period is `day-YYYY-MM-DD`, `month-YYYY-MM` or `fy-YYYY`, or
 * `clerk-YYYY-MM` for Clerk metering (AI-02: token and cost totals, per feature and per user).
 */
export const Metrics = withMeta(
  {
    period: z.string().regex(/^(day-\d{4}-\d{2}-\d{2}|month-\d{4}-\d{2}|fy-\d{4}|clerk-\d{4}-\d{2})$/),
    values: z.record(z.string(), z.number()),
  },
  { path: `${ORG}/metrics`, migratable: false },
);

/** The kinds of change the audit trigger records; semantic events use dotted names (`invoice.issued`). */
export const AUDIT_WRITE_ACTIONS = ['create', 'update', 'delete', 'soft_delete', 'restore'] as const;

/**
 * `audit/{id}`: append-only, written by functions only (ADR-010, FND-18). The trigger uses the
 * event id as the document id. `before`/`after` hold only the changed fields, redacted: long text
 * becomes `{ len, sha256 }` and secrets are dropped. `expireAt` drives the TTL policy
 * (`retentionYears` on the org).
 */
export const AuditEntry = withMeta(
  {
    at: InstantSchema,
    actor: z.union([z.object({ uid: DocIdSchema }), z.literal('system'), z.literal('clerk')]),
    /** A write (`create`, `update`, `delete`, `soft_delete`, `restore`) or a semantic event (`invoice.issued`). */
    action: NonEmptyString,
    entity: z.object({
      path: NonEmptyString,
      collection: NonEmptyString.optional(),
      id: DocIdSchema.optional(),
      matterId: DocIdSchema.optional(),
    }),
    changedFields: z.array(z.string()).optional(),
    before: z.record(z.string(), z.unknown()).optional(),
    after: z.record(z.string(), z.unknown()).optional(),
    /** One line for semantic events ("Invoice INV-0042 issued"); never client text. */
    summary: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string().optional(),
    runId: z.string().optional(),
    source: z.enum(['client', 'callable', 'trigger', 'job', 'migration']),
    expireAt: InstantSchema,
  },
  { path: `${ORG}/audit`, migratable: false, updatable: [] },
);

export const NOTIFICATION_CHANNELS = ['inapp', 'email', 'push'] as const;
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;
/** `critical` always emails, and is never collapsed or held back for quiet hours (FND-20). */
export const NOTIFICATION_PRIORITIES = ['normal', 'high', 'critical'] as const;
export const NotificationPrioritySchema = z.enum(NOTIFICATION_PRIORITIES);
export type NotificationPriority = z.infer<typeof NotificationPrioritySchema>;

/** One delivery outcome on a channel other than in-app (FND-20), written by `notifications-deliver`. */
export const NotificationDeliverySchema = z.object({
  channel: z.enum(['email', 'push']),
  status: z.enum(['sent', 'skipped', 'failed', 'dropped']),
  /** Why it was skipped, failed or dropped (`not_configured`, `not_member`, `invalid_token`, …). */
  reason: z.string().max(64).optional(),
  at: InstantSchema,
  /** The Cloud Tasks attempt (0 for the first). */
  attempt: z.number().int().min(0),
  /** The provider's message id (Postmark, FCM); never content. */
  providerId: z.string().max(300).optional(),
  /** The device a push went to (`users/{uid}/devices/{deviceId}`). */
  deviceId: DocIdSchema.optional(),
});
export type NotificationDelivery = z.infer<typeof NotificationDeliverySchema>;

const notificationBase = {
  recipientUid: DocIdSchema,
  /** Also the email subject: never matter content ("Deadline in 3 days: M-2026-0142" at most). */
  title: NonEmptyString,
  /** Never privileged content: name the thing and link to it instead. */
  body: z.string(),
  link: z.string().startsWith('/'),
  /** `null` until read (stored explicitly, so the unread query can match it). */
  readAt: InstantSchema.nullable().optional(),
  /** The channels this recipient gets it on, after their preferences (FND-20). */
  channels: z.array(NotificationChannelSchema).min(1),
  /** `high` and `critical` are shown prominently (a toast while online). Absent means normal. */
  priority: NotificationPrioritySchema.optional(),
  /** Email and push outcomes, appended by `notifications-deliver` (server-owned). */
  deliveries: z.array(NotificationDeliverySchema).optional(),
  /** Email and push wait until then (the recipient's quiet hours). */
  deliverAfter: InstantSchema.optional(),
  /**
   * Part of a burst for this recipient: listed in the inbox but not delivered or counted; its
   * summary is. `null` otherwise (stored explicitly, so the unread badge can leave bursts out).
   */
  summaryId: DocIdSchema.nullable().optional(),
  /** On a burst summary: how many notifications it stands for. */
  collapsedCount: z.number().int().min(1).optional(),
};

/**
 * `notifications/{id}`, discriminated on `kind`. Written only through `notify()` (FND-20). Each
 * kind's default channels and priority live in `NOTIFICATION_KINDS` (notifications.ts): a new
 * kind is one member here (its payload ids) and one entry there.
 */
export const NotificationPayloadSchema = z.discriminatedUnion('kind', [
  // Someone who already has an account was invited to another org (FND-17).
  z.object({ kind: z.literal('invite'), inviteId: DocIdSchema, ...notificationBase }),
  z.object({
    kind: z.literal('deadline_reminder'),
    deadlineId: DocIdSchema,
    matterId: DocIdSchema,
    ...notificationBase,
  }),
  z.object({
    kind: z.literal('deadline_escalation'),
    deadlineId: DocIdSchema,
    matterId: DocIdSchema,
    ...notificationBase,
  }),
  // A recompute proposed a date change or removal (`changeId`), or the engine's date fell earlier
  // than an override (no `changeId`) (CORE-10). A critical deadline moved into the past is `high`.
  z.object({
    kind: z.literal('deadline_changed'),
    deadlineId: DocIdSchema,
    matterId: DocIdSchema,
    changeId: DocIdSchema.optional(),
    ...notificationBase,
  }),
  // The daily missed check asks the responsible lawyer to confirm a deadline missed (CORE-10).
  z.object({
    kind: z.literal('deadline_missed'),
    deadlineId: DocIdSchema,
    matterId: DocIdSchema,
    ...notificationBase,
  }),
  z.object({
    kind: z.literal('task_assigned'),
    taskId: DocIdSchema,
    matterId: DocIdSchema.optional(),
    ...notificationBase,
  }),
  // A task is due soon (CORE-11, reminders-dispatch); `matterId` is absent for personal tasks.
  z.object({
    kind: z.literal('task_reminder'),
    taskId: DocIdSchema,
    matterId: DocIdSchema.optional(),
    ...notificationBase,
  }),
  z.object({ kind: z.literal('mention'), noteId: DocIdSchema, matterId: DocIdSchema, ...notificationBase }),
  z.object({ kind: z.literal('suggestion'), suggestionId: DocIdSchema, matterId: DocIdSchema, ...notificationBase }),
  // A party added to an open matter is on other matters (CORE-02, conflicts-onPartyAdded).
  z.object({
    kind: z.literal('conflict_alert'),
    matterId: DocIdSchema,
    checkId: DocIdSchema,
    contactId: DocIdSchema,
    ...notificationBase,
  }),
  // An upload to a matter was infected and deleted (CORE-12): to the uploader and the org's owners
  // and admins. High priority.
  z.object({
    kind: z.literal('document_infected'),
    matterId: DocIdSchema,
    documentId: DocIdSchema,
    ...notificationBase,
  }),
  z.object({ kind: z.literal('invite_accepted'), memberUid: DocIdSchema, ...notificationBase }),
  // A matter, or one of its deadlines, was given to someone (as the responsible lawyer).
  z.object({
    kind: z.literal('assignment'),
    matterId: DocIdSchema,
    deadlineId: DocIdSchema.optional(),
    ...notificationBase,
  }),
  // Clerk finished something a person asked for on a matter (AI-04 onwards).
  z.object({
    kind: z.literal('suggestion_ready'),
    matterId: DocIdSchema,
    suggestionId: DocIdSchema.optional(),
    ...notificationBase,
  }),
  // A generated or uploaded document finished processing (CORE-12, DOC tickets).
  z.object({
    kind: z.literal('document_ready'),
    matterId: DocIdSchema,
    documentId: DocIdSchema,
    ...notificationBase,
  }),
  z.object({
    kind: z.literal('integration_error'),
    provider: z.enum(['microsoft', 'google', 'xero']),
    ...notificationBase,
  }),
  z.object({ kind: z.literal('export_ready'), exportId: DocIdSchema, ...notificationBase }),
  // A testator whose original is held in safe custody has died (CORE-17): to the packet's lawyer.
  z.object({ kind: z.literal('safe_custody'), packetId: DocIdSchema, ...notificationBase }),
  z.object({ kind: z.literal('budget_alert'), matterId: DocIdSchema, ...notificationBase }),
  z.object({ kind: z.literal('system'), ...notificationBase }),
]);
export type NotificationKind = z.infer<typeof NotificationPayloadSchema>['kind'];
export const Notification = {
  schema: NotificationPayloadSchema.and(z.object(MetaShape)),
  create: NotificationPayloadSchema,
  update: z.object({ readAt: InstantSchema.nullable() }).partial().strict(),
  // v2 (FND-20): `channels` replaces `channel`; adds `critical`, `readAt: null`, deliveries and
  // bursts. v1 documents (in-app only) are not read by anything.
  version: 2,
  path: `${ORG}/notifications`,
};
export type Notification = z.infer<typeof Notification.schema>;

/**
 * `integrations/{uid_provider}`: server-only; secrets are KMS-encrypted (ADR-019). OAuth providers
 * store a refresh token; `integrations/anthropic` holds the org's own Anthropic API key (AI-02a,
 * ADR-011b), with only its last four characters in clear.
 */
export const Integration = withMeta(
  {
    provider: z.enum(['microsoft', 'google', 'xero', 'anthropic']),
    uid: DocIdSchema.nullable(),
    /** `valid` and `invalid` are the Anthropic key's states (invalid: Anthropic rejected it). */
    status: z.enum(['connected', 'error', 'revoked', 'valid', 'invalid']),
    scopes: z.array(z.string()).default([]),
    encryptedRefreshToken: z.string().optional(),
    encryptedApiKey: z.string().optional(),
    kmsKeyVersion: z.string(),
    last4: z.string().max(4).optional(),
    setBy: DocIdSchema.optional(),
    setAt: InstantSchema.optional(),
    validatedAt: InstantSchema.optional(),
    invalidAt: InstantSchema.optional(),
    /** Whether the Anthropic key could see Opus 5.5 when it was saved. */
    opusAvailable: z.boolean().optional(),
    lastSyncAt: InstantSchema.optional(),
    error: z.string().optional(),
  },
  { path: `${ORG}/integrations`, migratable: false, updatable: [] },
);

/** A stored matter document: originals' scans and release authorities (CORE-17). */
export const MatterDocumentRefSchema = z.object({ matterId: DocIdSchema, documentId: DocIdSchema }).strict();
export type MatterDocumentRef = z.infer<typeof MatterDocumentRefSchema>;

/** What a safe custody packet holds: a will, codicil, power of attorney, enduring guardianship or other original. */
export const SafeCustodyItemKindSchema = z.enum(['will', 'codicil', 'poa', 'eg', 'other']);
export type SafeCustodyItemKind = z.infer<typeof SafeCustodyItemKindSchema>;

/** One original in a packet. `date` is the document's own date; `document` a scan of its first page. */
export const SafeCustodyItemSchema = z
  .object({
    kind: SafeCustodyItemKindSchema,
    date: DateOnlySchema.optional(),
    description: z.string().trim().max(500).default(''),
    document: MatterDocumentRefSchema.optional(),
  })
  .strict();
export type SafeCustodyItem = z.infer<typeof SafeCustodyItemSchema>;

/** Where a packet sits: the site (office), the cabinet or safe, and the slot in it. */
export const SafeCustodyLocationSchema = z
  .object({
    site: NonEmptyString.max(80),
    cabinet: z.string().trim().max(80).default(''),
    slot: z.string().trim().max(80).default(''),
  })
  .strict();
export type SafeCustodyLocation = z.infer<typeof SafeCustodyLocationSchema>;

export const SafeCustodyStatusSchema = z.enum(['held', 'out', 'released', 'destroyed']);
export type SafeCustodyStatus = z.infer<typeof SafeCustodyStatusSchema>;

export const SafeCustodyMovementKindSchema = z.enum(['in', 'out', 'returned', 'released', 'destroyed']);
export type SafeCustodyMovementKind = z.infer<typeof SafeCustodyMovementKindSchema>;

/**
 * One step in a packet's chain of custody, appended by the `safeCustody-*` callables only. `to` is
 * who or where it went (free text), `toContactId` the executor or receiving firm as a contact;
 * `authority` the document that authorised a release or destruction; `approvedBy` the second
 * lawyer who confirmed a destruction.
 */
export const SafeCustodyMovementSchema = z
  .object({
    at: InstantSchema,
    by: DocIdSchema,
    kind: SafeCustodyMovementKindSchema,
    reason: z.string().trim().max(1000).default(''),
    to: z.string().trim().max(200).optional(),
    toContactId: DocIdSchema.optional(),
    authority: MatterDocumentRefSchema.optional(),
    location: SafeCustodyLocationSchema.optional(),
    approvedBy: DocIdSchema.optional(),
  })
  .strict();
export type SafeCustodyMovement = z.infer<typeof SafeCustodyMovementSchema>;

/**
 * `safeCustody/{id}`: an original will packet (CORE-17, ADR-034). Written only by the
 * `safeCustody-*` callables, so every movement carries its authority. `testatorName`, `search` and
 * `locationKey` are denormalised for the register's search and the stocktake's order.
 */
export const SafeCustody = withMeta(
  {
    /** `SC-000123`, from the `safe-custody` counter. */
    packetNo: NonEmptyString,
    testatorContactId: DocIdSchema,
    testatorName: z.string(),
    /** The lawyer told when the testator dies. */
    responsibleUid: DocIdSchema,
    /** The will matter the original came from, when there is one. */
    matterId: DocIdSchema.optional(),
    items: z.array(SafeCustodyItemSchema).min(1).max(50),
    location: SafeCustodyLocationSchema,
    receivedOn: DateOnlySchema,
    status: SafeCustodyStatusSchema,
    movements: z.array(SafeCustodyMovementSchema).default([]),
    notes: z.string().trim().max(2000).optional(),
    /** A destruction waiting for a second lawyer's confirmation. */
    pendingDestruction: z
      .object({
        requestedBy: DocIdSchema,
        requestedAt: InstantSchema,
        authority: MatterDocumentRefSchema,
        reason: z.string().trim().max(1000),
      })
      .strict()
      .nullable()
      .optional(),
    /** The last physical stocktake that found it. */
    lastVerified: z.object({ on: DateOnlySchema, by: DocIdSchema }).strict().optional(),
    search: SearchTokensSchema,
    locationKey: z.string(),
  },
  { path: `${ORG}/safeCustody`, softDelete: true, updatable: [] },
);

/** `migrations/{runId}`: migration run reports (Legacy migration plan). */
export const MigrationRun = withMeta(
  {
    runId: NonEmptyString,
    mode: z.enum(['rehearsal', 'cutover', 'delta']),
    status: z.enum(['running', 'succeeded', 'failed', 'rolled_back']),
    startedAt: InstantSchema,
    finishedAt: InstantSchema.optional(),
    counts: z.record(z.string(), z.number().int().min(0)),
    warnings: z.array(z.object({ code: z.string(), path: z.string(), message: z.string() })).default([]),
  },
  { path: `${ORG}/migrations`, migratable: false, updatable: [] },
);

/** `ruleSets/{ruleSetId}/versions/{version}` (global, immutable once published, ADR-009). */
export const RuleSetVersion = withMeta(
  {
    ruleSetId: NonEmptyString,
    version: z.number().int().min(1),
    jurisdiction: JurisdictionSchema,
    published: z.boolean(),
    practitionerReviewed: z.boolean().default(false),
    /** The rule set's feature flag prefix (`deadlines.ruleset.vic`; the version's flag adds `.v{n}`). */
    flag: z.string().min(1).optional(),
    disclaimer: z.string().min(1).optional(),
    rules: z.array(
      z.object({
        id: NonEmptyString,
        title: NonEmptyString,
        citation: NonEmptyString,
        definition: z.record(z.string(), z.unknown()),
      }),
    ),
  },
  { path: 'ruleSets/{ruleSetId}/versions', migratable: false },
);

/**
 * `calendars/{calendarId}-{year}` (global): public holidays and court/registry closures for one
 * calendar (CORE-09): court calendars (VIC_SUPREME_COURT) and firm locality calendars
 * (VIC_GREATER_GEELONG). `verified` is set once a person has checked it against official sources.
 */
export const Calendar = withMeta(
  {
    jurisdiction: JurisdictionSchema,
    year: z.number().int().min(2000).max(2100),
    calendarId: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]+$/)
      .optional(),
    kind: z.enum(['court', 'locality']).optional(),
    holidays: z.array(
      z.object({
        date: DateOnlySchema,
        name: NonEmptyString,
        localities: z.array(z.string()).optional(),
        provisional: z.boolean().optional(),
      }),
    ),
    closures: z
      .array(z.object({ from: DateOnlySchema, to: DateOnlySchema, body: z.string(), name: z.string() }))
      .default([]),
    source: z.string(),
    verified: z.boolean().default(false),
  },
  { path: 'calendars', migratable: false },
);

export type Invoice = z.infer<typeof Invoice.schema>;
export type CreditNote = z.infer<typeof CreditNote.schema>;
export type MatterTemplate = z.infer<typeof MatterTemplate.schema>;
export type MatterTemplateVersion = z.infer<typeof MatterTemplateVersion.schema>;
export type DocTemplate = z.infer<typeof DocTemplate.schema>;
export type ChecklistTemplate = z.infer<typeof ChecklistTemplate.schema>;
export type TaskGroupTemplate = z.infer<typeof TaskGroupTemplate.schema>;
export type Metrics = z.infer<typeof Metrics.schema>;
export type AuditEntry = z.infer<typeof AuditEntry.schema>;
export type Integration = z.infer<typeof Integration.schema>;
export type SafeCustody = z.infer<typeof SafeCustody.schema>;
export type MigrationRun = z.infer<typeof MigrationRun.schema>;
export type RuleSetVersion = z.infer<typeof RuleSetVersion.schema>;
export type Calendar = z.infer<typeof Calendar.schema>;
