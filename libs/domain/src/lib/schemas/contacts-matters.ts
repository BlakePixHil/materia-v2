import { z } from 'zod';

import {
  AddressSchema,
  CentsSchema,
  DateOnlySchema,
  DocIdSchema,
  EmailSchema,
  InstantSchema,
  NonEmptyString,
  PhoneSchema,
  withMeta,
} from './common';
import { JurisdictionSchema, MatterStatusSchema, MatterTypeSchema, PrioritySchema } from './enums';

const SearchTokens = z.array(z.string().min(1)).max(200);

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
    referrerMeta: z.object({ company: z.string(), industry: z.string() }).optional(),
    notes: z.string().optional(),
    search: SearchTokens,
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
    templateId: DocIdSchema.optional(),
    templateVersion: z.number().int().optional(),
    jurisdiction: JurisdictionSchema,
    responsibleUid: DocIdSchema,
    teamUids: z.array(DocIdSchema).default([]),
    clientContactIds: z.array(DocIdSchema).min(1),
    deceased: z
      .object({ contactId: DocIdSchema, dateOfDeath: DateOnlySchema, domicile: z.string(), lastAddress: z.string() })
      .optional(),
    testator: z.object({ contactId: DocIdSchema }).optional(),
    referrerContactId: DocIdSchema.optional(),
    referralSource: z.string().optional(),
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
    }),
    estate: z
      .object({
        grossValueCents: CentsSchema.optional(),
        netValueCents: CentsSchema.optional(),
        grantType: z.enum(['probate', 'loa', 'loa_with_will', 'reseal']).optional(),
        grantDate: DateOnlySchema.optional(),
        grantNo: z.string().optional(),
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
    search: SearchTokens,
    nextDeadline: z
      .object({ id: DocIdSchema, dueDate: DateOnlySchema, title: z.string(), critical: z.boolean() })
      .optional(),
    openTaskCount: z.number().int().min(0).default(0),
    wipCents: CentsSchema.default(0 as never),
    lastActivityAt: InstantSchema.optional(),
    litigationSummary: z.record(z.string(), z.unknown()).optional(),
    recomputeVersion: z.number().int().min(0).default(0),
    emailToken: z.string().optional(),
    legacyBilling: z.record(z.string(), z.unknown()).optional(),
  },
  {
    path: 'orgs/{orgId}/matters',
    softDelete: true,
    serverOwned: [
      'number',
      'search',
      'nextDeadline',
      'openTaskCount',
      'wipCents',
      'lastActivityAt',
      'litigationSummary',
      'recomputeVersion',
      'emailToken',
      'legacyBilling',
      'budget',
      'closedAt',
      'legalHold',
    ],
  },
);

export type Contact = z.infer<typeof Contact.schema>;
export type Matter = z.infer<typeof Matter.schema>;
