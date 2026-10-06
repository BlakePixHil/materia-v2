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
  PrioritySchema,
  ReferralSourceSchema,
  ReferrerIndustrySchema,
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
  },
  {
    path: 'orgs/{orgId}/contacts',
    softDelete: true,
    serverOwned: ['search', 'dedupeKey', 'sortName', 'mergedInto'],
  },
);

const FeeSchema = z.object({
  arrangement: z.enum(['hourly', 'fixed', 'capped', 'conditional', 'pro_bono']),
  amountCents: CentsSchema.optional(),
  capCents: CentsSchema.optional(),
  estimateCents: CentsSchema.optional(),
  rateOverrideCents: CentsSchema.optional(),
  conditional: z.object({ upliftPct: z.number().min(0).max(25), condition: z.string() }).optional(),
  history: z.array(z.object({ at: InstantSchema, by: DocIdSchema, change: z.string() })).default([]),
});

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
    costsDisclosure: z.object({
      status: z.enum(['not_required', 'required', 'sent', 'updated', 'waived']),
      sentOn: DateOnlySchema.optional(),
      estimateCents: CentsSchema.optional(),
      documentId: DocIdSchema.optional(),
    }),
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
        grossValueCents: CentsSchema.optional(),
        netValueCents: CentsSchema.optional(),
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
    destroyAfter: DateOnlySchema.optional(),
    legalHold: z.object({ on: z.boolean(), reason: z.string(), by: DocIdSchema, at: InstantSchema }).optional(),
    budget: z
      .object({ recordedCents: CentsSchema, billedCents: CentsSchema, basisCents: CentsSchema, pct: z.number() })
      .optional(),
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
    lastActivityAt: InstantSchema.optional(),
    litigationSummary: z.record(z.string(), z.unknown()).optional(),
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
      'lastActivityAt',
      'litigationSummary',
      'recomputeVersion',
      'emailToken',
      'legacyBilling',
      'budget',
      'closedAt',
      'legalHold',
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
