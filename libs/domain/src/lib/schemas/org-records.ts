import { z } from 'zod';

import { CentsSchema, DateOnlySchema, DocIdSchema, InstantSchema, MetaShape, NonEmptyString, withMeta } from './common';
import { InvoiceStatusSchema, JurisdictionSchema, MatterTypeSchema } from './enums';

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

/** `templates/{id}`: matter templates (CORE-07). Published versions are immutable. */
export const MatterTemplate = withMeta(
  {
    name: NonEmptyString,
    matterType: MatterTypeSchema,
    version: z.number().int().min(1),
    stages: z.array(z.object({ id: NonEmptyString, title: NonEmptyString })),
    tasks: z.array(
      z.object({
        title: NonEmptyString,
        stageId: NonEmptyString,
        offsetFromEvent: z.object({ event: z.string(), days: z.number().int() }).optional(),
      }),
    ),
    deadlineRuleIds: z.array(z.string()).default([]),
    published: z.boolean(),
    source: z.enum(['system', 'org']),
  },
  { path: `${ORG}/templates` },
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

/** `metrics/{period}`: rollups; period is `day-YYYY-MM-DD`, `month-YYYY-MM` or `fy-YYYY`. */
export const Metrics = withMeta(
  {
    period: z.string().regex(/^(day-\d{4}-\d{2}-\d{2}|month-\d{4}-\d{2}|fy-\d{4})$/),
    values: z.record(z.string(), z.number()),
  },
  { path: `${ORG}/metrics`, migratable: false },
);

/** `audit/{id}`: append-only, written by functions only (ADR-010). Diffs are redacted. */
export const AuditEntry = withMeta(
  {
    at: InstantSchema,
    actor: z.union([z.object({ uid: DocIdSchema }), z.literal('system'), z.literal('clerk')]),
    action: NonEmptyString,
    entity: z.object({ path: NonEmptyString }),
    before: z.record(z.string(), z.unknown()).optional(),
    after: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string().optional(),
    source: z.enum(['client', 'callable', 'trigger', 'job', 'migration']),
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
  z.object({
    kind: z.literal('task_assigned'),
    taskId: DocIdSchema,
    matterId: DocIdSchema.optional(),
    ...notificationBase,
  }),
  z.object({ kind: z.literal('mention'), noteId: DocIdSchema, matterId: DocIdSchema, ...notificationBase }),
  z.object({ kind: z.literal('suggestion'), suggestionId: DocIdSchema, matterId: DocIdSchema, ...notificationBase }),
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

/** `calendars/{jurisdiction}-{year}` (global): public holidays and court/registry closures. */
export const Calendar = withMeta(
  {
    jurisdiction: JurisdictionSchema,
    year: z.number().int().min(2000).max(2100),
    holidays: z.array(
      z.object({ date: DateOnlySchema, name: NonEmptyString, localities: z.array(z.string()).optional() }),
    ),
    closures: z
      .array(z.object({ from: DateOnlySchema, to: DateOnlySchema, body: z.string(), name: z.string() }))
      .default([]),
    source: z.string(),
  },
  { path: 'calendars', migratable: false },
);

export type Invoice = z.infer<typeof Invoice.schema>;
export type CreditNote = z.infer<typeof CreditNote.schema>;
export type MatterTemplate = z.infer<typeof MatterTemplate.schema>;
export type DocTemplate = z.infer<typeof DocTemplate.schema>;
export type Metrics = z.infer<typeof Metrics.schema>;
export type AuditEntry = z.infer<typeof AuditEntry.schema>;
export type Integration = z.infer<typeof Integration.schema>;
export type SafeCustody = z.infer<typeof SafeCustody.schema>;
export type MigrationRun = z.infer<typeof MigrationRun.schema>;
export type RuleSetVersion = z.infer<typeof RuleSetVersion.schema>;
export type Calendar = z.infer<typeof Calendar.schema>;
