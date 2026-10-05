import { z } from 'zod';

import { CentsSchema, DateOnlySchema, DocIdSchema, InstantSchema, MetaShape, NonEmptyString, withMeta } from './common';
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

const notificationBase = {
  recipientUid: DocIdSchema,
  title: NonEmptyString,
  body: z.string(),
  link: z.string().startsWith('/'),
  readAt: InstantSchema.optional(),
  channel: z.array(z.enum(['inapp', 'email', 'push'])).min(1),
  /** `high` notifications are shown prominently (a conflict alert, CORE-02). Absent means normal. */
  priority: z.enum(['normal', 'high']).optional(),
};

/** `notifications/{id}`, discriminated on `kind`. */
export const NotificationPayloadSchema = z.discriminatedUnion('kind', [
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
  z.object({ kind: z.literal('system'), ...notificationBase }),
]);
export const Notification = {
  schema: NotificationPayloadSchema.and(z.object(MetaShape)),
  create: NotificationPayloadSchema,
  update: z.object({ readAt: InstantSchema }).partial().strict(),
  version: 1,
  path: `${ORG}/notifications`,
};
export type Notification = z.infer<typeof Notification.schema>;

/** `integrations/{uid_provider}`: server-only; refresh tokens are KMS-encrypted (ADR-019). */
export const Integration = withMeta(
  {
    provider: z.enum(['microsoft', 'google', 'xero']),
    uid: DocIdSchema.nullable(),
    status: z.enum(['connected', 'error', 'revoked']),
    scopes: z.array(z.string()),
    encryptedRefreshToken: z.string(),
    kmsKeyVersion: z.string(),
    lastSyncAt: InstantSchema.optional(),
    error: z.string().optional(),
  },
  { path: `${ORG}/integrations`, migratable: false, updatable: [] },
);

/** `safeCustody/{id}`: will packets and their movements (CORE-17). */
export const SafeCustody = withMeta(
  {
    testatorContactId: DocIdSchema,
    documentIds: z.array(DocIdSchema).default([]),
    packetNo: NonEmptyString,
    location: z.string(),
    receivedOn: DateOnlySchema,
    movements: z
      .array(
        z.object({
          at: InstantSchema,
          by: DocIdSchema,
          kind: z.enum(['in', 'out', 'returned', 'released']),
          to: z.string().optional(),
          authorityDocId: DocIdSchema.optional(),
        }),
      )
      .default([]),
    status: z.enum(['held', 'out', 'released']),
  },
  { path: `${ORG}/safeCustody`, softDelete: true, serverOwned: ['movements', 'status'] },
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
export type Metrics = z.infer<typeof Metrics.schema>;
export type AuditEntry = z.infer<typeof AuditEntry.schema>;
export type Integration = z.infer<typeof Integration.schema>;
export type SafeCustody = z.infer<typeof SafeCustody.schema>;
export type MigrationRun = z.infer<typeof MigrationRun.schema>;
export type RuleSetVersion = z.infer<typeof RuleSetVersion.schema>;
export type Calendar = z.infer<typeof Calendar.schema>;
