import * as z from 'zod';

import { CentsSchema, CitationSchema, DateOnlySchema, DocIdSchema, NonEmptyString, withMeta } from './common';

const MATTER = 'orgs/{orgId}/matters/{matterId}';
const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Litigation subcollections on `contest` and `fp` matters (Domain doc). Courts are Victorian. */
export const Proceeding = withMeta(
  {
    court: z.enum(['VSC', 'VCC', 'VCAT', 'other']),
    list: z.string(),
    location: z.string(),
    fileNumber: z.string(),
    judicialOfficer: z.string().optional(),
    stage: z.string(),
    filedOn: DateOnlySchema,
    ourRole: z.enum(['plaintiff', 'defendant', 'executor', 'interested']),
  },
  { path: `${MATTER}/proceedings`, softDelete: true },
);

export const CourtEvent = withMeta(
  {
    proceedingId: DocIdSchema,
    kind: z.enum(['directions', 'mediation', 'hearing', 'judgment', 'callover', 'other']),
    date: DateOnlySchema,
    time: TimeOfDay.optional(),
    location: z.string(),
    outcome: z.string().optional(),
    ordersDocumentId: DocIdSchema.optional(),
  },
  { path: `${MATTER}/courtEvents`, softDelete: true },
);

export const CourtOrder = withMeta(
  {
    courtEventId: DocIdSchema,
    orderNo: z.string(),
    text: NonEmptyString,
    requiresAction: z.boolean(),
    dueDate: DateOnlySchema.optional(),
    deadlineId: DocIdSchema.optional(),
    responsiblePartyRole: z.string(),
    status: z.enum(['pending', 'complied', 'varied']),
  },
  { path: `${MATTER}/orders`, softDelete: true },
);

export const ChronologyEntry = withMeta(
  {
    date: DateOnlySchema,
    datePrecision: z.enum(['day', 'month', 'year', 'approx']),
    title: NonEmptyString,
    detail: z.string(),
    sources: z.array(CitationSchema).default([]),
    disputed: z.boolean().default(false),
    issueIds: z.array(DocIdSchema).default([]),
  },
  { path: `${MATTER}/chronology`, softDelete: true },
);

/** `internalAssessment` is lawyer-only and never client-facing (Clerk rule 7). */
export const Issue = withMeta(
  {
    title: NonEmptyString,
    elements: z.array(z.string()).default([]),
    ourPosition: z.string(),
    internalAssessment: z.string().optional(),
  },
  { path: `${MATTER}/issues`, softDelete: true },
);

export const Evidence = withMeta(
  {
    documentId: DocIdSchema.optional(),
    witnessPartyId: DocIdSchema.optional(),
    issueIds: z.array(DocIdSchema).default([]),
    supports: z.enum(['us', 'them', 'neutral']),
    strength: z.number().int().min(1).max(3),
    admissibilityNote: z.string().optional(),
  },
  { path: `${MATTER}/evidence`, softDelete: true },
);

export const Subpoena = withMeta(
  {
    issuedTo: NonEmptyString,
    direction: z.enum(['issued', 'received']),
    issuedOn: DateOnlySchema,
    returnDate: DateOnlySchema,
    status: z.enum(['draft', 'served', 'returned', 'set_aside', 'complete']),
    accessOrderMade: z.boolean().default(false),
    materialDocumentIds: z.array(DocIdSchema).default([]),
  },
  { path: `${MATTER}/subpoenas`, softDelete: true },
);

/** Offers are always privileged. */
export const Offer = withMeta(
  {
    kind: z.enum(['calderbank', 'offer_of_compromise', 'without_prejudice', 'open']),
    by: z.enum(['us', 'them']),
    madeOn: DateOnlySchema,
    expiresOn: DateOnlySchema.optional(),
    amountCents: CentsSchema.optional(),
    termsMd: z.string(),
    status: z.enum(['open', 'accepted', 'rejected', 'lapsed', 'withdrawn']),
    deadlineId: DocIdSchema.optional(),
    privileged: z.literal(true),
  },
  { path: `${MATTER}/offers`, softDelete: true },
);

export const CourtBook = withMeta(
  {
    title: NonEmptyString,
    tabs: z.array(
      z.object({
        title: NonEmptyString,
        entries: z.array(
          z.object({
            documentId: DocIdSchema,
            version: z.number().int().min(1),
            pageFrom: z.number().int().min(1).optional(),
            pageTo: z.number().int().min(1).optional(),
          }),
        ),
      }),
    ),
    status: z.enum(['draft', 'building', 'built', 'failed']),
    outputDocumentId: DocIdSchema.optional(),
    builtFromHash: z.string().optional(),
  },
  { path: `${MATTER}/courtBooks`, softDelete: true, serverOwned: ['outputDocumentId', 'builtFromHash'] },
);

export type Proceeding = z.infer<typeof Proceeding.schema>;
export type CourtEvent = z.infer<typeof CourtEvent.schema>;
export type CourtOrder = z.infer<typeof CourtOrder.schema>;
export type ChronologyEntry = z.infer<typeof ChronologyEntry.schema>;
export type Issue = z.infer<typeof Issue.schema>;
export type Evidence = z.infer<typeof Evidence.schema>;
export type Subpoena = z.infer<typeof Subpoena.schema>;
export type Offer = z.infer<typeof Offer.schema>;
export type CourtBook = z.infer<typeof CourtBook.schema>;
