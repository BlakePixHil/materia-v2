import * as z from 'zod';

import {
  CentsSchema,
  DateOnlySchema,
  DocIdSchema,
  InstantSchema,
  NonEmptyString,
  SearchTokensSchema,
  withMeta,
} from './common';
import { DocTemplateKindSchema, InvoiceStatusSchema, JurisdictionSchema, MatterTypeSchema } from './enums';
import {
  AppReturnPathSchema,
  IntegrationAccountSchema,
  IntegrationConnectionStatusSchema,
  IntegrationLevelSchema,
  IntegrationStatusReasonSchema,
  OAuthProviderSchema,
} from '../integrations';
import { TemplateBasedOnSchema, templateContentShape } from '../templates';
import { XeroPullStateSchema, XeroSyncSchema } from '../xero';

const ORG = 'orgs/{orgId}';

/**
 * One invoice or credit note line (BILL-07). Amounts are integer cents ex GST; `gstCents` is worked
 * out on the line (half away from zero) and the document's GST is the sum of its lines. A discount
 * or the fee-cap adjustment is a negative `adjustment` line.
 */
export const InvoiceLineSchema = z.object({
  kind: z.enum(['time', 'disbursement', 'fixed_fee', 'adjustment']),
  /** The time entry or disbursement the line bills (itemised lines only). */
  refId: DocIdSchema.optional(),
  description: NonEmptyString,
  /** Hours for time, otherwise 1. */
  quantity: z.number().min(0),
  /** The price per unit (the hourly rate for time), when it isn't simply the amount. */
  unitPriceCents: CentsSchema.optional(),
  amountExGstCents: CentsSchema,
  gstCents: CentsSchema,
  /** No GST is charged on the line (a GST-free or input-taxed disbursement, or a GST-free line). */
  gstFree: z.boolean().optional(),
  /** When the work was done or the outlay made. */
  date: DateOnlySchema.optional(),
  /** Who did the work (time lines). */
  by: z.string().max(120).optional(),
  /** The automatic adjustment that keeps a capped matter's fees within the cap (BILL-05). */
  cap: z.boolean().optional(),
  /** Credit notes: the invoice line credited. */
  invoiceLine: z.number().int().min(0).optional(),
});
export type InvoiceLine = z.infer<typeof InvoiceLineSchema>;

/** A summary invoice's itemisation: the time entries behind its "Professional fees" line. */
export const InvoiceItemSchema = z.object({
  refId: DocIdSchema,
  date: DateOnlySchema,
  by: z.string().max(120).optional(),
  description: z.string(),
  hours: z.number().min(0),
  amountExGstCents: CentsSchema,
});
export type InvoiceItem = z.infer<typeof InvoiceItemSchema>;

/** A line the person adds to a pre-bill: a fixed fee or an adjustment (a discount is negative). */
export const InvoiceExtraLineSchema = z.object({
  kind: z.enum(['fixed_fee', 'adjustment']),
  description: NonEmptyString.max(500),
  amountExGstCents: CentsSchema.refine((value) => Math.abs(value) <= 100_000_000, {
    message: 'Up to $1,000,000 a line',
  }),
  gstFree: z.boolean().optional(),
});
export type InvoiceExtraLine = z.infer<typeof InvoiceExtraLineSchema>;

/** `xero`: a payment made in Xero and brought across (BILL-09); never recorded by hand. */
export const PaymentMethodSchema = z.enum(['eft', 'card', 'cheque', 'trust_transfer', 'other', 'xero']);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

/**
 * One payment against an invoice, or a refund of money received (BILL-08, ADR-046), recorded by
 * `billing-recordPayment`. Amounts are positive cents inc GST; a refund counts against what was
 * paid. A reversed one (a bounced cheque, a mistake) stays on the invoice with who, when and why
 * and no longer counts. `credit` marks a payment allowed to exceed what was owing (the excess is
 * held as the client's credit). `payer` is free text: an estate's executor often pays.
 */
export const InvoicePaymentSchema = z.object({
  id: z.string(),
  kind: z.enum(['payment', 'refund']).default('payment'),
  date: DateOnlySchema,
  amountCents: CentsSchema,
  method: PaymentMethodSchema,
  reference: z.string().optional(),
  payer: z.string().optional(),
  credit: z.boolean().optional(),
  recordedAt: InstantSchema.optional(),
  recordedBy: DocIdSchema.optional(),
  reversedAt: InstantSchema.optional(),
  reversedBy: DocIdSchema.optional(),
  reversalReason: z.string().optional(),
  /**
   * A payment from Xero (id `xero-{PaymentID}`) that looks like one already recorded by hand: the
   * same amount within a week (BILL-09). Both count until someone reverses one.
   */
  possibleDuplicateOf: z.string().optional(),
});
export type InvoicePayment = z.infer<typeof InvoicePaymentSchema>;

/** Who issued the document and who it is for, frozen at issue (the ATO's identity requirements). */
export const InvoicePartySchema = z.object({
  name: NonEmptyString,
  abn: z.string().optional(),
  address: z.string().optional(),
});
export type InvoiceParty = z.infer<typeof InvoicePartySchema>;

/** The PDF (FND-24 `pdf.render`, template `invoice`): rendered after issue into the matter's documents. */
export const InvoicePdfStatusSchema = z.enum(['pending', 'ready', 'failed']);
export type InvoicePdfStatus = z.infer<typeof InvoicePdfStatusSchema>;

const InvoicePdfShape = {
  pdfStatus: InvoicePdfStatusSchema.optional(),
  pdfJobId: DocIdSchema.optional(),
  /** The matter document holding the PDF (`job-{jobId}`). */
  pdfDocumentId: DocIdSchema.optional(),
};

/**
 * `orgs/{orgId}/counters/{name}`: a sequence (`matter-2026` for matter numbers, CORE-03;
 * `invoice` and `credit-note`, BILL-07). `next` is the next value to hand out. Server-only:
 * written in transactions by functions, so a failed transaction never uses a number up.
 */
export const Counter = withMeta(() => ({ next: z.number().int().min(1) }), {
  path: `${ORG}/counters`,
  migratable: false,
  serverOwned: ['next'],
});
export type Counter = z.infer<typeof Counter.schema>;

/**
 * `invoices/{id}` (BILL-07). A `draft` is a pre-bill: what to bill (the matter, a date range, the
 * time entries and disbursements left out, extra lines) and the lines built from it. Issuing gives
 * it a gapless number and freezes it; an issued invoice is never edited, only voided or credited.
 * Every write goes through the `billing-*` callables.
 */
export const Invoice = withMeta(
  () => ({
    /** Empty until issued. */
    number: z.string(),
    matterId: DocIdSchema,
    matterNumber: z.string().optional(),
    matterTitle: z.string().optional(),
    /** The pre-bill's date range (inclusive); open-ended when absent. */
    from: DateOnlySchema.optional(),
    to: DateOnlySchema.optional(),
    grouping: z.enum(['itemised', 'summary']).default('itemised'),
    excludedTimeEntryIds: z.array(DocIdSchema).default([]),
    excludedDisbursementIds: z.array(DocIdSchema).default([]),
    extraLines: z.array(InvoiceExtraLineSchema).default([]),
    /** What the lines bill: set when the pre-bill is saved and frozen at issue. */
    timeEntryIds: z.array(DocIdSchema).default([]),
    disbursementIds: z.array(DocIdSchema).default([]),
    notes: z.string().max(2000).default(''),
    paymentTermsDays: z.number().int().min(0).max(365),
    issueDate: DateOnlySchema.optional(),
    dueDate: DateOnlySchema.optional(),
    lines: z.array(InvoiceLineSchema),
    itemisation: z.array(InvoiceItemSchema).optional(),
    subtotalCents: CentsSchema,
    gstCents: CentsSchema,
    totalCents: CentsSchema,
    /** Whether the firm was registered for GST when it was issued (an "Invoice" without GST if not). */
    gstRegistered: z.boolean().optional(),
    supplier: InvoicePartySchema.optional(),
    buyer: InvoicePartySchema.optional(),
    status: InvoiceStatusSchema,
    issuedAt: InstantSchema.optional(),
    issuedBy: DocIdSchema.optional(),
    ...InvoicePdfShape,
    /** The last time it was emailed (`billing-sendInvoice`); never sent automatically. */
    sentAt: InstantSchema.optional(),
    sentBy: DocIdSchema.optional(),
    sentTo: z.array(z.string()).optional(),
    voidedAt: InstantSchema.optional(),
    voidedBy: DocIdSchema.optional(),
    voidReason: z.string().optional(),
    /** The credit notes against it and their total (inc GST). */
    creditNoteIds: z.array(DocIdSchema).default([]),
    creditedCents: CentsSchema.default(0 as never),
    /** Its copy in Xero (BILL-09). */
    xero: XeroSyncSchema.optional(),
    payments: z.array(InvoicePaymentSchema).default([]),
    /**
     * BILL-12 (ADR-035): the firm intends to pay this invoice from money held in trust. Only the
     * intention: the withdrawal is made, and recorded first, in the firm's trust system.
     */
    paidFromTrust: z.boolean().optional(),
    /** The r 42(3) notice the PDF prints, frozen when given (`billing.trustNotice` on). */
    trustNotice: z.object({ version: z.number().int().min(1), text: z.string() }).optional(),
  }),
  {
    path: `${ORG}/invoices`,
    serverOwned: [
      'number',
      'matterNumber',
      'matterTitle',
      'timeEntryIds',
      'disbursementIds',
      'lines',
      'itemisation',
      'subtotalCents',
      'gstCents',
      'totalCents',
      'gstRegistered',
      'supplier',
      'buyer',
      'status',
      'issueDate',
      'dueDate',
      'issuedAt',
      'issuedBy',
      'pdfStatus',
      'pdfJobId',
      'pdfDocumentId',
      'sentAt',
      'sentBy',
      'sentTo',
      'voidedAt',
      'voidedBy',
      'voidReason',
      'creditNoteIds',
      'creditedCents',
      'xero',
      'payments',
      'paidFromTrust',
      'trustNotice',
    ],
    updatable: [],
  },
);

/**
 * `creditNotes/{id}` (BILL-07): credits (part of) an issued invoice, with its own gapless `CN-…`
 * number. Amounts are positive: what is credited. The billed time and disbursements stay billed.
 */
export const CreditNote = withMeta(
  () => ({
    number: z.string(),
    invoiceId: DocIdSchema,
    invoiceNumber: z.string(),
    matterId: DocIdSchema,
    issueDate: DateOnlySchema,
    reason: NonEmptyString,
    full: z.boolean(),
    lines: z.array(InvoiceLineSchema),
    subtotalCents: CentsSchema,
    gstCents: CentsSchema,
    totalCents: CentsSchema,
    gstRegistered: z.boolean().optional(),
    supplier: InvoicePartySchema.optional(),
    buyer: InvoicePartySchema.optional(),
    ...InvoicePdfShape,
    /** Its copy in Xero, allocated against the invoice there (BILL-09). */
    xero: XeroSyncSchema.optional(),
  }),
  {
    path: `${ORG}/creditNotes`,
    serverOwned: [
      'number',
      'subtotalCents',
      'gstCents',
      'totalCents',
      'pdfStatus',
      'pdfJobId',
      'pdfDocumentId',
      'xero',
    ],
    updatable: [],
  },
);

/** The overdue thresholds, in days past the due date, at which a payment reminder is queued (BILL-08). */
export const REMINDER_THRESHOLDS = [7, 30, 60] as const;
export type ReminderThreshold = (typeof REMINDER_THRESHOLDS)[number];

/**
 * `invoiceReminders/{invoiceId}-{threshold}` (BILL-08, ADR-046): a payment reminder the nightly job
 * queued for an overdue invoice, for the matter's responsible lawyer to review, edit and send
 * (`billing-sendReminder`) or dismiss. Nothing is ever sent without a person. `cancelled` is set
 * by the job when the invoice no longer owes anything, is voided, or reaches a later threshold.
 * Read-only to clients (`billing.view`).
 */
export const InvoiceReminder = withMeta(
  () => ({
    invoiceId: DocIdSchema,
    invoiceNumber: z.string(),
    matterId: DocIdSchema,
    matterNumber: z.string().optional(),
    matterTitle: z.string().optional(),
    clientName: z.string().optional(),
    /** Days past due that queued it: 7, 30 or 60. */
    threshold: z.number().int().min(1),
    dueDate: DateOnlySchema,
    /** What was owing when it was queued (inc GST). */
    balanceCents: CentsSchema,
    /** Who reviews and sends it: the matter's responsible lawyer when queued. */
    lawyerUid: DocIdSchema.optional(),
    /** The clients' email addresses when queued (the default "To"). */
    to: z.array(z.string()).default([]),
    status: z.enum(['pending', 'sent', 'dismissed', 'cancelled']),
    sentAt: InstantSchema.optional(),
    sentBy: DocIdSchema.optional(),
    sentTo: z.array(z.string()).optional(),
    closedAt: InstantSchema.optional(),
    closedBy: z.string().optional(),
    closeReason: z.string().optional(),
  }),
  {
    path: `${ORG}/invoiceReminders`,
    migratable: false,
    serverOwned: [
      'invoiceId',
      'invoiceNumber',
      'matterId',
      'matterNumber',
      'matterTitle',
      'clientName',
      'threshold',
      'dueDate',
      'balanceCents',
      'lawyerUid',
      'to',
      'status',
      'sentAt',
      'sentBy',
      'sentTo',
      'closedAt',
      'closedBy',
      'closeReason',
    ],
    updatable: [],
  },
);
export type InvoiceReminder = z.infer<typeof InvoiceReminder.schema>;

/**
 * `templates/{id}`: an org's matter template (CORE-07): the editable draft, plus where it stands.
 * `version` is the latest published version (0 until the first publish) and `published` says
 * whether there is one. Written by the `templates-*` callables only (`templates-clone`, `-save`,
 * `-publish`); system templates ship with the code (`libs/domain/templates/system`).
 */
export const MatterTemplate = withMeta(
  () => ({
    ...templateContentShape,
    version: z.number().int().min(0),
    source: z.enum(['system', 'org']),
    basedOn: TemplateBasedOnSchema.optional(),
    published: z.boolean(),
    publishedAt: InstantSchema.optional(),
    publishedBy: DocIdSchema.optional(),
  }),
  { path: `${ORG}/templates`, updatable: [] },
);

/**
 * `templates/{templateId}/versions/{version}`: a published version, immutable (CORE-07). Matters
 * point at one (`templateId` + `templateVersion`), so their stages and tasks never change under
 * them. `stageMapping` maps the stages this version dropped to stages it has (for upgrades).
 */
export const MatterTemplateVersion = withMeta(
  () => ({
    ...templateContentShape,
    templateId: DocIdSchema,
    version: z.number().int().min(1),
    source: z.enum(['system', 'org']),
    basedOn: TemplateBasedOnSchema.optional(),
    published: z.literal(true),
    publishedAt: InstantSchema,
    publishedBy: DocIdSchema,
    stageMapping: z.record(z.string(), z.string()).optional(),
  }),
  { path: `${ORG}/templates/{templateId}/versions`, migratable: false, updatable: [] },
);

/** Limits on docx templates (INT-06). */
export const DOC_TEMPLATE_NAME_MAX = 120;
export const DOC_TEMPLATE_VERSIONS_MAX = 50;
/** The largest template file accepted (a letterhead with a logo is well under 1 MB). */
export const DOC_TEMPLATE_MAX_BYTES = 5 * 1024 * 1024;

/** A template file's Storage path: `orgs/{orgId}/docTemplates/{templateId}/v{n}.docx`. */
export const DocTemplateStoragePathSchema = z.string().regex(/^orgs\/[^/]+\/docTemplates\/[^/]+\/v\d+\.docx$/);

/** One uploaded version of a docx template (INT-06). Versions are never edited or removed. */
export const DocTemplateVersionSchema = z
  .object({
    version: z.number().int().min(1),
    storagePath: DocTemplateStoragePathSchema,
    fileName: NonEmptyString.max(255),
    sizeBytes: z.number().int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** The merge fields it uses, as full paths (`client.fullName`, `executors.fullName`), sorted. */
    fields: z.array(z.string()).max(500),
    /** Problems that don't stop it merging, such as fonts the PDF preview substitutes. */
    warnings: z.array(z.string().max(300)).max(20).default([]),
    uploadedAt: InstantSchema,
    uploadedBy: DocIdSchema,
  })
  .strict();
export type DocTemplateVersion = z.infer<typeof DocTemplateVersionSchema>;

/**
 * `docTemplates/{id}`: an org's docx template with merge fields (INT-06, ADR-047). Every upload is a
 * new version (`versions`; `version`, `storagePath` and `fields` mirror the latest); documents are
 * generated from `publishedVersion`, so a new upload changes nothing until it is published. A
 * template that `replaces` a system template hides that one while published. Written only by the
 * `docs-*` callables; every member reads them.
 */
export const DocTemplate = withMeta(
  () => ({
    name: NonEmptyString.max(DOC_TEMPLATE_NAME_MAX),
    kind: DocTemplateKindSchema,
    /** The matter types it is offered on; empty means every type. */
    matterTypes: z.array(MatterTypeSchema).default([]),
    storagePath: DocTemplateStoragePathSchema,
    fields: z.array(z.string()).max(500).default([]),
    version: z.number().int().min(1),
    versions: z.array(DocTemplateVersionSchema).min(1).max(DOC_TEMPLATE_VERSIONS_MAX),
    published: z.boolean().default(false),
    /** The version generation uses; absent until the first publish. */
    publishedVersion: z.number().int().min(1).optional(),
    publishedAt: InstantSchema.optional(),
    publishedBy: DocIdSchema.optional(),
    /** The system template this one stands in for (`system-letter`): hidden while this is published. */
    replaces: DocIdSchema.optional(),
  }),
  { path: `${ORG}/docTemplates`, softDelete: true, updatable: [] },
);

/** Aged-debt buckets, by whole days past the due date (BILL-08): not yet due, 1–30, 31–60, 61–90, over 90. */
export const AGED_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
export type AgedBucket = (typeof AGED_BUCKETS)[number];
export const AgedAmountsSchema = z.object({
  current: CentsSchema,
  d1_30: CentsSchema,
  d31_60: CentsSchema,
  d61_90: CentsSchema,
  d90_plus: CentsSchema,
});
export type AgedAmounts = z.infer<typeof AgedAmountsSchema>;

/** One matter's outstanding invoices in the aged-debtors report (BILL-08). */
export const DebtorRowSchema = z.object({
  matterId: DocIdSchema,
  matterNumber: z.string(),
  matterTitle: z.string(),
  /** The invoice's buyer as issued (the clients' names). */
  clientName: z.string(),
  lawyerUid: DocIdSchema.optional(),
  invoices: z.number().int().min(0),
  buckets: AgedAmountsSchema,
  totalCents: CentsSchema,
  oldestDueDate: DateOnlySchema.optional(),
});
export type DebtorRow = z.infer<typeof DebtorRowSchema>;

/** `metrics/debtors-{date}`: the aged-debtors report as of a day (BILL-08). */
export const DebtorsSnapshotSchema = z.object({
  asOf: DateOnlySchema,
  rows: z.array(DebtorRowSchema),
  /** More matters owed than one document holds; the totals still count them all. */
  truncated: z.boolean().default(false),
});
export type DebtorsSnapshot = z.infer<typeof DebtorsSnapshotSchema>;

/**
 * `metrics/{period}`: rollups; period is `day-YYYY-MM-DD`, `month-YYYY-MM` or `fy-YYYY` (INS-01,
 * ADR-048: org-wide counters in `values`, members' in `byMember/{uid}`, a large org's in
 * `shards/{n}` too), or `clerk-YYYY-MM` for Clerk metering (AI-02: token and cost totals, per
 * feature and per user), or `debtors-YYYY-MM-DD` for the aged-debtors report (BILL-08: bucket
 * totals in `values`, the matters in `debtors`; Clerk's metrics scope reads only month and year
 * rollups).
 */
export const Metrics = withMeta(
  () => ({
    period: z
      .string()
      .regex(/^(day-\d{4}-\d{2}-\d{2}|month-\d{4}-\d{2}|fy-\d{4}|clerk-\d{4}-\d{2}|debtors-\d{4}-\d{2}-\d{2})$/),
    values: z.record(z.string(), z.number()),
    /** The day the snapshot figures (`wip.`, `active.`, `overdue.`, `debtors.`) were taken (INS-01). */
    snapshotOn: DateOnlySchema.optional(),
    debtors: DebtorsSnapshotSchema.optional(),
  }),
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
  () => ({
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
  }),
  { path: `${ORG}/audit`, migratable: false, updatable: [] },
);

/**
 * `integrations/{id}`: server-only; secrets are KMS-encrypted (ADR-019). OAuth connections (INT-01,
 * ADR-051) are `{uid}_{provider}` per person or `{provider}` per practice and store a refresh token
 * bound to the document path; `integrations/anthropic` holds the org's own Anthropic API key
 * (AI-02a, ADR-011b), with only its last four characters in clear.
 */
export const Integration = withMeta(
  () => ({
    provider: z.enum(['microsoft', 'google', 'xero', 'anthropic']),
    uid: DocIdSchema.nullable(),
    /**
     * OAuth: `connected`, or `reconnect_required` once the provider refuses the refresh token.
     * `valid` and `invalid` are the Anthropic key's states (invalid: Anthropic rejected it).
     */
    status: z.enum(['connected', 'reconnect_required', 'error', 'revoked', 'valid', 'invalid']),
    level: IntegrationLevelSchema.optional(),
    /** A new id for each connect, so a refresh never overwrites a newer connection's token. */
    connectionId: z.string().optional(),
    scopes: z.array(z.string()).default([]),
    account: IntegrationAccountSchema.optional(),
    encryptedRefreshToken: z.string().optional(),
    encryptedApiKey: z.string().optional(),
    kmsKeyVersion: z.string(),
    connectedAt: InstantSchema.optional(),
    connectedBy: DocIdSchema.optional(),
    /** When the refresh token was last rotated by the provider. */
    refreshedAt: InstantSchema.optional(),
    reconnectRequiredAt: InstantSchema.optional(),
    last4: z.string().max(4).optional(),
    setBy: DocIdSchema.optional(),
    setAt: InstantSchema.optional(),
    validatedAt: InstantSchema.optional(),
    invalidAt: InstantSchema.optional(),
    /** Whether the Anthropic key could see Opus 5.5 when it was saved. */
    opusAvailable: z.boolean().optional(),
    lastSyncAt: InstantSchema.optional(),
    error: z.string().optional(),
  }),
  { path: `${ORG}/integrations`, migratable: false, updatable: [] },
);

/**
 * `integrationStatus/{id}` (INT-01, ADR-051): the client-readable mirror of an OAuth connection,
 * with the same id as its `integrations` document and nothing secret. A practice connection is
 * read by every member, a person's own only by them. Written only by the vault.
 */
export const IntegrationStatus = withMeta(
  () => ({
    provider: OAuthProviderSchema,
    level: IntegrationLevelSchema,
    /** The person whose connection it is; null for the practice's. */
    uid: DocIdSchema.nullable(),
    status: IntegrationConnectionStatusSchema,
    scopes: z.array(z.string()).default([]),
    account: IntegrationAccountSchema.optional(),
    connectedAt: InstantSchema.optional(),
    connectedBy: DocIdSchema.optional(),
    reconnectRequiredAt: InstantSchema.optional(),
    disconnectedAt: InstantSchema.optional(),
    /** A uid, or `system` (the member was removed). */
    disconnectedBy: z.string().min(1).optional(),
    reason: IntegrationStatusReasonSchema.optional(),
    /** Xero: when payments were last brought across (BILL-09). Reset by reconnecting. */
    sync: XeroPullStateSchema.optional(),
  }),
  { path: `${ORG}/integrationStatus`, migratable: false, updatable: [] },
);

/**
 * `integrationStates/{sha256(state)}` (INT-01, ADR-051): one connect attempt, server-only. The
 * OAuth `state` is a random nonce the browser carries; only its hash is the id, so reading the
 * collection gives no usable state. Used once by `integrations-complete`, which checks it belongs
 * to the caller; Firestore TTL deletes abandoned ones after `expireAt`.
 */
export const IntegrationState = withMeta(
  () => ({
    provider: OAuthProviderSchema,
    level: IntegrationLevelSchema,
    uid: DocIdSchema,
    /** The PKCE verifier (RFC 7636); only the token exchange uses it. */
    codeVerifier: z.string().min(43).max(128),
    redirectUri: z.string().url(),
    returnTo: AppReturnPathSchema,
    expireAt: InstantSchema,
  }),
  { path: `${ORG}/integrationStates`, migratable: false, updatable: [] },
);

/**
 * `xeroContacts/{tenantId}_{hash}` (BILL-09, ADR-053): the Xero contact a matter's clients are
 * invoiced as, in one Xero organisation. Keyed by the organisation and the (sorted) client
 * contacts, so joint clients ("A and B") get one contact of their own. Server-only.
 */
export const XeroContactLink = withMeta(
  () => ({
    tenantId: z.string().max(64),
    contactId: z.string().max(64),
    clientContactIds: z.array(DocIdSchema).min(1).max(20),
    /** The name it was created or matched with in Xero. */
    name: z.string().max(255),
  }),
  { path: `${ORG}/xeroContacts`, migratable: false, updatable: [] },
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
 * `safeCustody/{id}`: an original will packet (CORE-17, ADR-036). Written only by the
 * `safeCustody-*` callables, so every movement carries its authority. `testatorName`, `search` and
 * `locationKey` are denormalised for the register's search and the stocktake's order.
 */
export const SafeCustody = withMeta(
  () => ({
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
  }),
  { path: `${ORG}/safeCustody`, softDelete: true, updatable: [] },
);

const Count = z.number().int().min(0);

/** Where an enrichment run stands (MIG-09, D-21). */
export const MigrationEnrichmentStatusSchema = z.enum([
  /** Counting the pages of the run's documents (no Clerk calls). */
  'estimating',
  /** Waiting for an owner or admin to approve the estimate. */
  'awaiting_approval',
  /** They chose not to, for now: approving later starts it. */
  'declined',
  'running',
  /** Stopped before the end (`pausedFor`): approving again resumes where it stopped. */
  'paused',
  'done',
  /** The run was rolled back. */
  'cancelled',
]);
export type MigrationEnrichmentStatus = z.infer<typeof MigrationEnrichmentStatusSchema>;

/** Why a running enrichment stopped: its allowance used, the org's monthly Clerk limit reached, or Clerk off. */
export const MigrationEnrichmentPauseSchema = z.enum(['allowance', 'budget', 'clerk_off']);
export type MigrationEnrichmentPause = z.infer<typeof MigrationEnrichmentPauseSchema>;

/** What reading a run's documents and estate matters would take, counted before any Clerk call. */
export const MigrationEnrichmentEstimateSchema = z
  .object({
    /** Documents to read: live, scanned clean and not read by Clerk yet. */
    documents: Count,
    pages: Count,
    /** Pages with no text layer, read by OCR. */
    ocrPages: Count,
    /** Characters of text to embed (OCR pages counted at an average). */
    chars: Count,
    /** Documents Clerk can't read (encrypted, damaged or an unsupported kind). */
    unreadable: Count,
    /** Open estate matters Clerk reads for their key dates. */
    matters: Count,
    /** The estimate in US cents at the org's model's list price, rounded up. */
    costCents: Count,
    model: NonEmptyString,
  })
  .strict();
export type MigrationEnrichmentEstimate = z.infer<typeof MigrationEnrichmentEstimateSchema>;

/**
 * `migrationEnrichments/{runId}` (MIG-09, D-21): Clerk reading what a migration run loaded. It
 * reads every migrated document (AI-04 ingestion, at low priority, one at a time), then each open
 * estate matter's notes and documents for its key dates (`event` suggestions with citations, AI-07),
 * and tells the owner what is waiting. It starts by itself when the run's record turns `succeeded`:
 * the pages are counted first, and nothing that costs money runs until an owner or admin approves
 * the estimate and sets the allowance in Settings → Clerk and AI. Written only by functions
 * (`migration-*`); owners and admins read it.
 */
export const MigrationEnrichment = withMeta(
  () => ({
    runId: NonEmptyString,
    status: MigrationEnrichmentStatusSchema,
    phase: z.enum(['estimate', 'ingest', 'events', 'finish']),
    /** Each step's task carries it, and a step moves it on: a task with an older one is stale. */
    seq: Count,
    /** The documents to read, as `{matterId}/{docId}`, in order. */
    documents: z.array(z.string().regex(/^[^/]+\/[^/]+$/)).default([]),
    /** The estate matters to read for key dates, in order. */
    matters: z.array(DocIdSchema).default([]),
    /** The next document or matter of the phase. */
    cursor: Count.default(0),
    /** Failed tries at the current one (it is passed over after three). */
    attempts: Count.default(0),
    estimate: MigrationEnrichmentEstimateSchema.optional(),
    /** The estimate with headroom: what the approval offers as the allowance. */
    suggestedAllowanceCents: Count.optional(),
    /** The most it may spend (US cents), set when approved: separate from the org's monthly limit, which still applies. */
    allowanceCents: Count.optional(),
    /** What its Clerk calls have cost so far, in micro-dollars. */
    spentMicros: Count.default(0),
    approvedBy: DocIdSchema.optional(),
    approvedAt: InstantSchema.optional(),
    pausedFor: MigrationEnrichmentPauseSchema.optional(),
    progress: z
      .object({
        /** Documents read, passed over (Clerk can't read them, or there is no text), and failed. */
        read: Count,
        skipped: Count,
        failed: Count,
        mattersRead: Count,
        /** Key-date suggestions made. */
        events: Count,
      })
      .strict()
      .default({ read: 0, skipped: 0, failed: 0, mattersRead: 0, events: 0 }),
    /** When done: the suggestions waiting on the run's matters, and the documents listed for review. */
    suggestionsWaiting: Count.optional(),
    unreadable: Count.optional(),
    finishedAt: InstantSchema.optional(),
  }),
  { path: `${ORG}/migrationEnrichments`, migratable: false, updatable: [] },
);
export type MigrationEnrichment = z.infer<typeof MigrationEnrichment.schema>;

/** `ruleSets/{ruleSetId}/versions/{version}` (global, immutable once published, ADR-009). */
export const RuleSetVersion = withMeta(
  () => ({
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
  }),
  { path: 'ruleSets/{ruleSetId}/versions', migratable: false },
);

/**
 * `trustSnapshots/{matterId}` (BILL-11, ADR-035): the trust balance held for a matter, as copied by
 * hand from the firm's own trust records on `asAt`. Never a ledger: no transactions and no running
 * balance, only the latest copy. Its own collection (not a matter field) so only `billing.view`
 * roles can read it. Written only by `trust-recordSnapshot`; each change is audited, which is the
 * history. Never put on invoices, client exports or emails.
 */
export const TrustSnapshot = withMeta(
  () => ({
    matterId: DocIdSchema,
    amountCents: CentsSchema.refine((value) => value >= 0, { message: 'A trust balance can’t be negative' }),
    asAt: DateOnlySchema,
    source: z.literal('manual'),
    /** The records it was copied from, as named in Settings → Trust account when it was recorded. */
    sourceSystemName: NonEmptyString.max(60),
    note: z.string().trim().max(200).optional(),
    recordedBy: DocIdSchema,
    recordedAt: InstantSchema,
  }),
  { path: `${ORG}/trustSnapshots`, migratable: false, updatable: [] },
);

/**
 * `calendars/{calendarId}-{year}` (global): public holidays and court/registry closures for one
 * calendar (CORE-09): court calendars (VIC_SUPREME_COURT) and firm locality calendars
 * (VIC_GREATER_GEELONG). `verified` is set once a person has checked it against official sources.
 */
export const Calendar = withMeta(
  () => ({
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
  }),
  { path: 'calendars', migratable: false },
);

export type Invoice = z.infer<typeof Invoice.schema>;
export type CreditNote = z.infer<typeof CreditNote.schema>;
export type MatterTemplate = z.infer<typeof MatterTemplate.schema>;
export type MatterTemplateVersion = z.infer<typeof MatterTemplateVersion.schema>;
export type DocTemplate = z.infer<typeof DocTemplate.schema>;
export type Metrics = z.infer<typeof Metrics.schema>;
export type AuditEntry = z.infer<typeof AuditEntry.schema>;
export type Integration = z.infer<typeof Integration.schema>;
export type IntegrationStatus = z.infer<typeof IntegrationStatus.schema>;
export type IntegrationState = z.infer<typeof IntegrationState.schema>;
export type XeroContactLink = z.infer<typeof XeroContactLink.schema>;
export type SafeCustody = z.infer<typeof SafeCustody.schema>;
export type TrustSnapshot = z.infer<typeof TrustSnapshot.schema>;
export type RuleSetVersion = z.infer<typeof RuleSetVersion.schema>;
export type Calendar = z.infer<typeof Calendar.schema>;
