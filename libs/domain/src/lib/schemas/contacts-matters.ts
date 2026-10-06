import * as z from 'zod';

import {
  AddressSchema,
  CentsSchema,
  DateOnlySchema,
  DocIdSchema,
  EmailSchema,
  InstantSchema,
  NonEmptyString,
  PhoneSchema,
  SearchTokensSchema,
  withMeta,
} from './common';
import {
  JurisdictionSchema,
  MatterStatusSchema,
  MatterTypeSchema,
  OriginalsOutcomeSchema,
  PartyRoleSchema,
  PrioritySchema,
  ReferralSourceSchema,
  ReferrerIndustrySchema,
  RetentionHoldSchema,
} from './enums';

/**
 * `matter.conflictAlert` (CORE-02): set by `conflicts-onPartyAdded` when a party added to an open
 * or on-hold matter is on other matters. `conflicts-determine` on the same `checkId` clears it. It
 * never blocks anything; the matter page shows a banner.
 */
export const ConflictAlertSchema = z.object({
  checkId: DocIdSchema,
  contactId: DocIdSchema,
  partyId: DocIdSchema.optional(),
  at: InstantSchema,
  /** Whether a hit has an adverse role (always false while `conflicts.enforced` is off). */
  adverse: z.boolean(),
});
export type ConflictAlert = z.infer<typeof ConflictAlertSchema>;

/** `orgs/{orgId}/contacts/{contactId}`: people and organisations. */
export const Contact = withMeta(
  {
    kind: z.enum(['person', 'organisation']),
    givenNames: z.string().optional(),
    familyName: z.string().optional(),
    preferredName: z.string().optional(),
    dateOfBirth: DateOnlySchema.optional(),
    dateOfDeath: DateOnlySchema.optional(),
    orgName: z.string().optional(),
    abn: z
      .string()
      .regex(/^\d{11}$/)
      .optional(),
    emails: z.array(EmailSchema).default([]),
    phones: z.array(PhoneSchema).default([]),
    addresses: z.array(AddressSchema).default([]),
    tags: z.array(z.string()).default([]),
    isReferrer: z.boolean().default(false),
    /**
     * Who the referrer works for and their industry (CORE-18). An industry from before the enum
     * (free text) reads as `other`; `referrerIndustryFromText` maps legacy text properly.
     */
    referrerMeta: z
      .object({
        company: z.string().optional(),
        industry: ReferrerIndustrySchema.optional().catch('other'),
      })
      .optional(),
    notes: z.string().optional(),
    search: SearchTokensSchema,
    dedupeKey: z.string(),
    /** Lower-cased display name for `orderBy` (CORE-01), maintained by `contacts-onWrite`. */
    sortName: z.string(),
    /** Set by `contacts-merge`: this contact is a tombstone, merged into that one. */
    mergedInto: DocIdSchema.optional(),
    /**
     * The roles the contact holds on live, unprivileged matters (CORE-01a, `matterCountsForRoles`),
     * each once in `PARTY_ROLE_ORDER`, for the "Role in matters" filter. Kept by
     * `contacts-onPartyWrite` (and `matters-denormalise` when a matter is deleted, restored or its
     * privileged flag changes); `materia-scripts backfill-matter-roles` fills older contacts.
     */
    matterRoles: z.array(PartyRoleSchema).default([]),
  },
  {
    path: 'orgs/{orgId}/contacts',
    softDelete: true,
    serverOwned: ['search', 'dedupeKey', 'sortName', 'mergedInto', 'matterRoles'],
  },
);

/**
 * `matter.closing` (CORE-19): what the closing checklist recorded when `matters-close` closed the
 * matter, and why it has no destruction date (`holds`) when it has none.
 */
export const ClosingRecordSchema = z.object({
  originals: OriginalsOutcomeSchema.optional(),
  closingLetterSent: z.boolean(),
  finalDistributionRecorded: z.boolean(),
  /** Items closed without being done, each with the lawyer's reason. */
  overrides: z.record(z.string(), z.string()).optional(),
  tasksCancelled: z.number().int().min(0).default(0),
  holds: z.array(RetentionHoldSchema).default([]),
});
export type ClosingRecord = z.infer<typeof ClosingRecordSchema>;

/**
 * A fee arrangement's terms (BILL-05): what a revision changes, and the `from` and `to` of each
 * `history` entry. `estimateCents` is the single estimate given at intake; the range
 * (`estimateLowCents` to `estimateHighCents`) is what a costs disclosure quotes, and its high end
 * is the budget's basis on hourly and conditional matters.
 */
export const FeeTermsSchema = z.object({
  arrangement: z.enum(['hourly', 'fixed', 'capped', 'conditional', 'pro_bono']),
  amountCents: CentsSchema.optional(),
  capCents: CentsSchema.optional(),
  estimateCents: CentsSchema.optional(),
  estimateLowCents: CentsSchema.optional(),
  estimateHighCents: CentsSchema.optional(),
  rateOverrideCents: CentsSchema.optional(),
  conditional: z.object({ upliftPct: z.number().min(0).max(25), condition: z.string() }).optional(),
});
export type FeeTerms = z.infer<typeof FeeTermsSchema>;

/**
 * One revision of a matter's fee arrangement (BILL-05), written by `fees-update`: who, when, the
 * terms before and after, and why. Entries from before BILL-05 carry only a `change` line.
 */
export const FeeRevisionSchema = z.object({
  at: InstantSchema,
  by: DocIdSchema,
  from: FeeTermsSchema.optional(),
  to: FeeTermsSchema.optional(),
  reason: z.string().optional(),
  change: z.string().optional(),
});
export type FeeRevision = z.infer<typeof FeeRevisionSchema>;

const FeeSchema = FeeTermsSchema.extend({
  /** Counts revisions (BILL-05; absent means 0); budget alerts fire once per threshold per revision. */
  revision: z.number().int().min(0).optional(),
  history: z.array(FeeRevisionSchema).default([]),
});

/**
 * `matter.budget` (BILL-05), kept by the `fees-budgetOn*` triggers and `fees-update`. Recorded
 * value is all live time at its rate (billable or not, any status) plus disbursements ex GST, so
 * profitability shows on fixed fees too. `basisCents` is the fixed fee, the cap, or the top of the
 * estimate; `pct` is recorded against it as a whole-number percentage (86 = 86%, may pass 100).
 * Both are absent when there is no basis (pro bono, or hourly without an estimate). `alerted`
 * lists the thresholds already alerted for `revision` of the fee.
 */
export const MatterBudgetSchema = z.object({
  recordedCents: CentsSchema,
  billedCents: CentsSchema,
  basisCents: CentsSchema.optional(),
  pct: z.number().int().min(0).optional(),
  timeCents: CentsSchema.optional(),
  disbursementsCents: CentsSchema.optional(),
  revision: z.number().int().min(0).optional(),
  alerted: z.array(z.number().int()).optional(),
});
export type MatterBudget = z.infer<typeof MatterBudgetSchema>;

/** What a matter's costs disclosure must be, by its estimate's band (BILL-06): none, the uniform standard form, or full. */
export const DisclosureRequirementSchema = z.enum(['none', 'short_form', 'full']);
export type DisclosureRequirement = z.infer<typeof DisclosureRequirementSchema>;

/**
 * Where a matter's costs disclosure stands (BILL-06). `update_required` follows a significant change
 * to an estimate already disclosed; `updated` is an updated disclosure sent after it.
 */
export const CostsDisclosureStatusSchema = z.enum([
  'not_required',
  'required',
  'sent',
  'update_required',
  'updated',
  'waived',
]);
export type CostsDisclosureStatus = z.infer<typeof CostsDisclosureStatusSchema>;

/** Why a lawyer recorded that no disclosure is needed (the Uniform Law's exceptions; BILL-06). */
export const DisclosureWaiverReasonSchema = z.enum(['commercial_or_government', 'sophisticated_client', 'other']);
export type DisclosureWaiverReason = z.infer<typeof DisclosureWaiverReasonSchema>;

/** How a disclosure was given. Materia records it; it doesn't send it (BILL-06). */
export const DisclosureSentMethodSchema = z.enum(['email', 'post', 'hand']);
export type DisclosureSentMethod = z.infer<typeof DisclosureSentMethodSchema>;

/** What made an estimate revision significant: the band moved, it rose past the org's percentage, or it was first given. */
export const DisclosureUpdateReasonSchema = z.enum(['band', 'increase', 'estimate']);
export type DisclosureUpdateReason = z.infer<typeof DisclosureUpdateReasonSchema>;

/** One line of a matter's costs disclosure history (BILL-06), newest last. `by` is `system` for the server. */
export const DisclosureEventSchema = z.object({
  at: InstantSchema,
  by: DocIdSchema,
  action: z.enum([
    'assessed',
    'reassessed',
    'update_required',
    'generated',
    'sent',
    'waived',
    'waiver_removed',
    'reminded',
  ]),
  status: CostsDisclosureStatusSchema,
  requirement: DisclosureRequirementSchema.optional(),
  estimateCents: CentsSchema.optional(),
  documentId: DocIdSchema.optional(),
  note: z.string().max(500).optional(),
});
export type DisclosureEvent = z.infer<typeof DisclosureEventSchema>;

/**
 * `matter.costsDisclosure` (CORE-05, BILL-06; server-written). The status, the requirement the
 * estimate's band gives under the jurisdiction's rules (`rulesVersion`, absent where none are
 * configured), the estimate it was assessed on (`basisEstimateCents`, absent while there is none),
 * since when a disclosure has been due (`requiredSince`, for the 7-day reminder), the last one
 * sent (date, method, estimate and band) and the generated document, a lawyer's waiver, and the
 * history. `estimateCents` is CORE-05's name for the estimate, on matters opened before BILL-06.
 */
export const CostsDisclosureSchema = z.object({
  status: CostsDisclosureStatusSchema,
  requirement: DisclosureRequirementSchema.optional(),
  bandId: z.string().max(60).optional(),
  rulesVersion: z.string().max(60).optional(),
  basisEstimateCents: CentsSchema.optional(),
  estimateCents: CentsSchema.optional(),
  notRequiredReason: z.enum(['below_threshold', 'pro_bono']).optional(),
  requiredSince: DateOnlySchema.optional(),
  remindedOn: DateOnlySchema.optional(),
  updateReasons: z.array(DisclosureUpdateReasonSchema).optional(),
  sentOn: DateOnlySchema.optional(),
  sentMethod: DisclosureSentMethodSchema.optional(),
  sentEstimateCents: CentsSchema.optional(),
  sentBandId: z.string().max(60).optional(),
  documentId: DocIdSchema.optional(),
  /** The open "send the disclosure" task the server made, completed when one is recorded as sent. */
  taskId: DocIdSchema.optional(),
  waiver: z
    .object({
      reason: DisclosureWaiverReasonSchema,
      note: z.string().max(500).optional(),
      by: DocIdSchema,
      at: InstantSchema,
    })
    .optional(),
  /** Absent on matters opened before BILL-06. */
  history: z.array(DisclosureEventSchema).optional(),
});
export type CostsDisclosure = z.infer<typeof CostsDisclosureSchema>;

/** `orgs/{orgId}/matters/{matterId}`. */
export const Matter = withMeta(
  {
    number: NonEmptyString,
    title: NonEmptyString,
    type: MatterTypeSchema,
    status: MatterStatusSchema,
    stageId: z.string().optional(),
    /** The day (org time zone) the matter entered `stageId`; template task due dates count from it (CORE-07). */
    stageEnteredOn: DateOnlySchema.optional(),
    templateId: DocIdSchema.optional(),
    templateVersion: z.number().int().optional(),
    jurisdiction: JurisdictionSchema,
    responsibleUid: DocIdSchema,
    teamUids: z.array(DocIdSchema).default([]),
    clientContactIds: z.array(DocIdSchema).min(1),
    /**
     * The deceased. `dateOfDeath` is absent while unknown (CORE-05): the matter then has no
     * `date_of_death` event, its template tasks anchored on it show "due date pending", and it gets
     * a death certificate task. Recording it later (key facts) makes the event known.
     */
    deceased: z
      .object({
        contactId: DocIdSchema,
        dateOfDeath: DateOnlySchema.optional(),
        domicile: z.string(),
        lastAddress: z.string(),
      })
      .optional(),
    testator: z.object({ contactId: DocIdSchema }).optional(),
    /** The contact who referred the matter (CORE-18), usually one with `isReferrer`. */
    referrerContactId: DocIdSchema.optional(),
    /** Where the matter came from when no referrer contact sent it (CORE-18); never set with `referrerContactId`. */
    referralSource: ReferralSourceSchema.optional(),
    fee: FeeSchema,
    costsDisclosure: CostsDisclosureSchema,
    conflictCheck: z.object({
      status: z.enum(['pending', 'clear', 'potential', 'conflict']),
      checkedAt: InstantSchema.optional(),
      checkedBy: DocIdSchema.optional(),
      resultId: DocIdSchema.optional(),
      /** Why a potential conflict was waived, or why it is a conflict (CORE-02). */
      reason: z.string().optional(),
    }),
    conflictAlert: ConflictAlertSchema.optional(),
    estate: z
      .object({
        /** Kept by `estate-onWrite` from the estate register once it has records (CORE-16). */
        grossValueCents: CentsSchema.optional(),
        /** Gross less liabilities; negative for an insolvent estate. */
        netValueCents: CentsSchema.optional(),
        /** Held back from distribution (tax, costs, contingencies): the residue is shown after it (CORE-16). */
        reservedCents: z.number().int().min(0).optional(),
        grantType: z.enum(['probate', 'loa', 'loa_with_will', 'reseal']).optional(),
        grantDate: DateOnlySchema.optional(),
        grantNo: z.string().optional(),
        /** The deceased's main residence is in the estate: the CGT main residence window applies (CORE-10). */
        hasMainResidence: z.boolean().optional(),
      })
      .optional(),
    /** Key facts not held elsewhere (CORE-06): the will's date, the court file number, a trust's name (CORE-05). */
    facts: z
      .object({
        willDate: DateOnlySchema.optional(),
        courtFileNo: z.string().trim().max(60).optional(),
        trustName: z.string().trim().max(200).optional(),
      })
      .optional(),
    dispute: z
      .object({
        kind: z.enum(['family_provision', 'will_contest', 'construction', 'executor_removal', 'other']),
        proceedingIds: z.array(DocIdSchema).default([]),
      })
      .optional(),
    privileged: z.boolean().default(false),
    priority: PrioritySchema.default('none'),
    externalRef: z.string().optional(),
    /** A link to the matter elsewhere, e.g. in the firm's 3E (CORE-21a): an absolute http(s) URL. */
    externalUrl: z
      .string()
      .trim()
      .max(2000)
      .refine((value) => /^https?:\/\/\S+$/i.test(value), { message: 'Enter a web address starting https://' })
      .optional(),
    boardOrder: z.number().optional(),
    labels: z.array(z.string()).default([]),
    relatedMatterIds: z.array(DocIdSchema).default([]),
    closedAt: InstantSchema.optional(),
    closeReason: z.string().optional(),
    /** CORE-19: the day after which the matter may be destroyed; absent while open or held. */
    destroyAfter: DateOnlySchema.optional(),
    closing: ClosingRecordSchema.optional(),
    /** Set by the nightly `matters-archiveClosed` (or a manual archive): the matter is read-only. */
    archivedAt: InstantSchema.optional(),
    /** Placed and released by owners and admins (`matters-setLegalHold`); `on` blocks destruction. */
    legalHold: z.object({ on: z.boolean(), reason: z.string(), by: DocIdSchema, at: InstantSchema }).optional(),
    /** On the tombstone a destroyed matter leaves (CORE-19); the certificate records what went. */
    destroyedAt: InstantSchema.optional(),
    destroyedBy: DocIdSchema.optional(),
    certificateId: DocIdSchema.optional(),
    budget: MatterBudgetSchema.optional(),
    // Denormalised and server-maintained
    search: SearchTokensSchema,
    nextDeadline: z
      .object({ id: DocIdSchema, dueDate: DateOnlySchema, title: z.string(), critical: z.boolean() })
      .optional(),
    openTaskCount: z.number().int().min(0).default(0),
    wipCents: CentsSchema.default(0 as never),
    /** The date of the matter's last invoice (BILL-07 sets it); the WIP tab shows it (BILL-03). */
    lastInvoicedOn: DateOnlySchema.optional(),
    /** Unbilled, live disbursements ex GST (BILL-04), kept by `disbursements-onWrite`; time is `wipCents`. */
    disbursementWipCents: CentsSchema.optional(),
    /** What the matter's issued invoices still owe, inc GST (BILL-08), kept by `billing-outstandingOnInvoice`. */
    outstandingCents: CentsSchema.optional(),
    lastActivityAt: InstantSchema.optional(),
    litigationSummary: z.record(z.string(), z.unknown()).optional(),
    /** The estate register's totals (CORE-16), kept by `estate-onWrite` so they never need every row. */
    estateRegister: z
      .object({
        grossCents: CentsSchema,
        liabilitiesCents: CentsSchema,
        netCents: CentsSchema,
        outsideCents: CentsSchema,
        realisedCents: CentsSchema,
        assetCount: z.number().int().min(0),
        liabilityCount: z.number().int().min(0),
        updatedAt: InstantSchema,
      })
      .optional(),
    recomputeVersion: z.number().int().min(0).default(0),
    emailToken: z.string().optional(),
    legacyBilling: z.record(z.string(), z.unknown()).optional(),
  },
  {
    path: 'orgs/{orgId}/matters',
    softDelete: true,
    // Clients edit only these (CORE-03); number, status and the rest go through callables.
    // The stage moves through `matters-changeStage`; `privileged` also needs `privileged.view` (rules).
    updatable: [
      'title',
      'responsibleUid',
      'teamUids',
      'labels',
      'priority',
      'externalRef',
      'externalUrl',
      'estate',
      'deceased',
      'facts',
      'privileged',
      // The referral (CORE-18), edited on the matter header.
      'referrerContactId',
      'referralSource',
      // The Matters board's card order (CORE-04): a reorder is a client write.
      'boardOrder',
    ],
    serverOwned: [
      'number',
      'search',
      'nextDeadline',
      'openTaskCount',
      'wipCents',
      'lastInvoicedOn',
      'disbursementWipCents',
      'outstandingCents',
      'lastActivityAt',
      'litigationSummary',
      'estateRegister',
      'recomputeVersion',
      'emailToken',
      'legacyBilling',
      'budget',
      'closedAt',
      'closeReason',
      'destroyAfter',
      'closing',
      'archivedAt',
      'legalHold',
      'destroyedAt',
      'destroyedBy',
      'certificateId',
      'conflictAlert',
      'stageEnteredOn',
    ],
  },
);

/**
 * `orgs/{orgId}/matterNumbers/{key}`: the reservation that makes a matter number unique per org
 * (CORE-03). `key` is `matterNumberKey(number)`. Written by `matters-createMatter` in the same
 * transaction as the matter; server-only. A soft-deleted matter keeps its number.
 */
export const MatterNumber = withMeta(
  { number: NonEmptyString, matterId: DocIdSchema, year: z.number().int().min(2000).max(9999) },
  { path: 'orgs/{orgId}/matterNumbers', migratable: false, serverOwned: ['number', 'matterId', 'year'] },
);

export type Contact = z.infer<typeof Contact.schema>;
export type MatterNumber = z.infer<typeof MatterNumber.schema>;
export type Matter = z.infer<typeof Matter.schema>;
