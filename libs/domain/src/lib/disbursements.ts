import * as z from 'zod';

import { GST_RATE } from './constants';
import { CentsSchema, DocIdSchema, NonEmptyString, withMeta } from './schemas/common';
import { GstTreatmentSchema, type GstTreatment } from './schemas/enums';
import {
  Disbursement,
  DISBURSEMENT_MAX_CENTS,
  DISBURSEMENT_PAYEE_MAX,
  DisbursementCategorySchema,
  type DisbursementCategory,
} from './schemas/matter-records';

/**
 * Disbursements (BILL-04): outlays on the client's behalf (court filing fees, searches, probate
 * advertising, valuations, couriers), the GST maths, what they add to WIP, the invoice line BILL-07
 * builds from one, and the org's presets. Money is integer cents throughout; GST is worked out per
 * disbursement and never on a total (Edge-case register, Money & billing).
 */

// ---------- GST ----------

/** Integer `numerator / denominator` for non-negative numbers, rounding half up. */
function divRoundHalfUp(numerator: number, denominator: number): number {
  const quotient = Math.floor(numerator / denominator);
  const remainder = numerator - quotient * denominator;
  return remainder * 2 >= denominator ? quotient + 1 : quotient;
}

const RATE_BASIS_POINTS = Math.round(GST_RATE * 10_000);

/** GST on an ex-GST amount: 10% for taxable supplies, rounded half up to the cent; otherwise 0. */
export function disbursementGst(amountExGstCents: number, treatment: GstTreatment): number {
  if (treatment !== 'taxable') return 0;
  return divRoundHalfUp(amountExGstCents * RATE_BASIS_POINTS, 10_000);
}

/**
 * The ex-GST part of a GST-inclusive amount: `round(incl / 11 × 10)` for taxable supplies (half
 * up); GST-free and input-taxed amounts carry no GST, so the whole amount is ex-GST.
 */
export function exGstFromInclusive(amountIncGstCents: number, treatment: GstTreatment): number {
  if (treatment !== 'taxable') return amountIncGstCents;
  return divRoundHalfUp(amountIncGstCents * 10_000, 10_000 + RATE_BASIS_POINTS);
}

export interface DisbursementAmounts {
  amountExGstCents: number;
  gstCents: number;
}

/**
 * The stored amounts for what was entered. Entered GST-inclusive (`amountIncGstCents` set), the
 * ex-GST part is derived and GST is the rest, so any 1-cent remainder sits in the GST and ex + GST
 * always equals what was paid. Entered excluding GST, the GST is 10% of it for taxable supplies.
 */
export function disbursementAmounts(input: {
  amountExGstCents?: number | null | undefined;
  amountIncGstCents?: number | null | undefined;
  gstTreatment: GstTreatment;
}): DisbursementAmounts {
  const inclusive = input.amountIncGstCents;
  if (typeof inclusive === 'number') {
    const amountExGstCents = exGstFromInclusive(inclusive, input.gstTreatment);
    return { amountExGstCents, gstCents: inclusive - amountExGstCents };
  }
  const amountExGstCents = input.amountExGstCents ?? 0;
  return { amountExGstCents, gstCents: disbursementGst(amountExGstCents, input.gstTreatment) };
}

/** Why an entered amount can't be saved, or null. */
export function disbursementAmountProblem(cents: number | null | undefined): string | null {
  if (cents === null || cents === undefined) return 'Enter the amount paid.';
  if (!Number.isSafeInteger(cents) || cents < 0) return 'Enter an amount in dollars, such as 42.50.';
  if (cents === 0) return 'The amount must be more than $0.00.';
  if (cents > DISBURSEMENT_MAX_CENTS) return 'That’s more than $1,000,000. Check the amount.';
  return null;
}

export const GST_TREATMENT_LABELS: Record<GstTreatment, string> = {
  taxable: 'Taxable (10% GST)',
  gst_free: 'GST-free',
  input_taxed: 'Input-taxed',
};

export const DISBURSEMENT_CATEGORY_LABELS: Record<DisbursementCategory, string> = {
  court_fee: 'Court fee',
  advertising: 'Advertising',
  search: 'Search',
  certificate: 'Certificate',
  valuation: 'Valuation',
  courier: 'Courier and postage',
  other: 'Other',
};

// ---------- WIP and invoices ----------

/** What a disbursement adds to its matter's `disbursementWipCents`: ex GST, while unbilled and live. */
export function disbursementWipContribution(
  disbursement: { status?: unknown; amountExGstCents?: unknown; deletedAt?: unknown } | null | undefined,
): number {
  if (!disbursement || disbursement.deletedAt) return 0;
  if (disbursement.status !== 'unbilled') return 0;
  const amount = disbursement.amountExGstCents;
  return typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
}

export interface DisbursementRowLike {
  status: string;
  amountExGstCents: number;
  gstCents: number;
  deletedAt?: unknown;
}

export interface DisbursementTotals {
  exGstCents: number;
  gstCents: number;
  incGstCents: number;
  count: number;
}

/** Totals of the live, unbilled disbursements (written-off and billed ones are left out). */
export function disbursementTotals(rows: readonly DisbursementRowLike[]): DisbursementTotals {
  let exGstCents = 0;
  let gstCents = 0;
  let count = 0;
  for (const row of rows) {
    if (row.deletedAt || row.status !== 'unbilled') continue;
    exGstCents += row.amountExGstCents;
    gstCents += row.gstCents;
    count++;
  }
  return { exGstCents, gstCents, incGstCents: exGstCents + gstCents, count };
}

/** One invoice line (`Invoice.lines[]`) for a disbursement: the BILL-07 contract. */
export interface DisbursementInvoiceLine {
  kind: 'disbursement';
  refId: string;
  description: string;
  quantity: 1;
  amountExGstCents: number;
  gstCents: number;
}

/**
 * The invoice line for an unbilled disbursement (BILL-07 adds it to a pre-bill and then marks the
 * disbursement billed with its `invoiceId`). The line keeps the disbursement's own GST: it is never
 * recomputed on the invoice total.
 */
export function disbursementInvoiceLine(disbursement: {
  id: string;
  description: string;
  payee?: string;
  amountExGstCents: number;
  gstCents: number;
}): DisbursementInvoiceLine {
  const payee = disbursement.payee?.trim();
  const description =
    payee && !disbursement.description.includes(payee)
      ? `${disbursement.description} (${payee})`
      : disbursement.description;
  return {
    kind: 'disbursement',
    refId: disbursement.id,
    description,
    quantity: 1,
    amountExGstCents: disbursement.amountExGstCents,
    gstCents: disbursement.gstCents,
  };
}

// ---------- presets ----------

/** Presets one org keeps at most. */
export const DISBURSEMENT_PRESETS_MAX = 50;
export const DISBURSEMENT_PRESET_LABEL_MAX = 120;

/** One preset: it only prefills a new disbursement; the amount is always editable. */
export const DisbursementPresetSchema = z.object({
  id: DocIdSchema.max(40),
  label: NonEmptyString.max(DISBURSEMENT_PRESET_LABEL_MAX),
  category: DisbursementCategorySchema,
  gstTreatment: GstTreatmentSchema,
  payee: z.string().max(DISBURSEMENT_PAYEE_MAX).optional(),
  /** Left empty when the fee changes often (court fees change each financial year). */
  defaultAmountCents: CentsSchema.refine((value) => value > 0 && value <= DISBURSEMENT_MAX_CENTS, {
    message: 'Enter an amount between $0.01 and $1,000,000',
  })
    .nullable()
    .optional(),
});
export type DisbursementPreset = z.infer<typeof DisbursementPresetSchema>;

export const DisbursementPresetsSchema = z
  .array(DisbursementPresetSchema)
  .max(DISBURSEMENT_PRESETS_MAX)
  .refine((presets) => new Set(presets.map((p) => p.id)).size === presets.length, {
    message: 'Preset ids must be unique',
  });

/** `orgs/{orgId}/settings/disbursementPresets`; owners and admins write it directly. */
export const DISBURSEMENT_PRESETS_DOC = 'disbursementPresets';
/** The presets document (the only client-readable document in `settings`). */
export const DisbursementPresetsDoc = withMeta(
  { presets: DisbursementPresetsSchema },
  { path: 'orgs/{orgId}/settings', migratable: false },
);
export const disbursementPresetsPath = (orgId: string) => `orgs/${orgId}/settings/${DISBURSEMENT_PRESETS_DOC}`;

/**
 * The starting presets, used until the org saves its own (and written by the seed). Illustrative
 * and awaiting practitioner review (BILL-04a): amounts are blank because the fees change each
 * financial year, and the GST treatments need checking against current ATO guidance.
 */
export const DEFAULT_DISBURSEMENT_PRESETS: readonly DisbursementPreset[] = [
  {
    id: 'vsc-grant-filing',
    label: 'Supreme Court of Victoria filing fee: application for grant',
    category: 'court_fee',
    gstTreatment: 'gst_free',
    payee: 'Supreme Court of Victoria',
  },
  {
    id: 'grant-advertisement',
    label: 'Advertisement of intention to apply for a grant',
    category: 'advertising',
    gstTreatment: 'taxable',
  },
  {
    id: 's33-notice',
    label: 'Statutory notice (s 33) advertisement',
    category: 'advertising',
    gstTreatment: 'taxable',
  },
  { id: 'title-search', label: 'Title search', category: 'search', gstTreatment: 'taxable', payee: 'LANDATA' },
  {
    id: 'death-certificate',
    label: 'Death certificate',
    category: 'certificate',
    gstTreatment: 'gst_free',
    payee: 'Births, Deaths and Marriages Victoria',
  },
  { id: 'valuation', label: 'Valuation', category: 'valuation', gstTreatment: 'taxable' },
  { id: 'courier', label: 'Courier', category: 'courier', gstTreatment: 'taxable' },
];

/** The org's presets, or the starting ones when it hasn't saved any (or the document is malformed). */
export function presetsOrDefault(doc: { presets?: unknown } | null | undefined): readonly DisbursementPreset[] {
  if (!doc) return DEFAULT_DISBURSEMENT_PRESETS;
  const parsed = DisbursementPresetsSchema.safeParse(doc.presets);
  return parsed.success ? parsed.data : DEFAULT_DISBURSEMENT_PRESETS;
}

/** A preset id from a label: "Title search" → "title-search" (made unique against `taken`). */
export function presetId(label: string, taken: Iterable<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'preset';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

// ---------- writes ----------

/**
 * A client-created disbursement (`matters/{matterId}/disbursements`): the rules require
 * `status: 'unbilled'` and `wipCountedCents: 0`; `disbursements-onWrite` then sets the real amounts
 * and counts it into the matter's `disbursementWipCents`.
 */
export const DisbursementCreateInput = /* @__PURE__ */ Disbursement.create.extend({
  orgId: DocIdSchema,
  matterId: DocIdSchema,
  amountExGstCents: CentsSchema.refine((v) => v >= 0 && v <= DISBURSEMENT_MAX_CENTS),
  gstCents: CentsSchema.refine((v) => v >= 0),
  status: z.literal('unbilled').default('unbilled'),
  wipCountedCents: z.literal(0).default(0),
});
export type DisbursementCreateInput = z.input<typeof DisbursementCreateInput>;

export const DISBURSEMENT_CALLABLES = {
  setStatus: 'disbursements-setStatus',
} as const;

/** Disbursements one `disbursements-setStatus` call changes at most. */
export const DISBURSEMENT_STATUS_BATCH_MAX = 100;

/**
 * `disbursements-setStatus` (`time.approve`, idempotent): writes off unbilled disbursements or
 * restores written-off ones to unbilled. Billed ones are never changed (they move with their
 * invoice, BILL-07); ones already in the target status are skipped.
 */
export const SetDisbursementStatusInput = /* @__PURE__ */ z.object({
  requestId: z.uuid(),
  matterId: DocIdSchema,
  disbursementIds: z.array(DocIdSchema).min(1).max(DISBURSEMENT_STATUS_BATCH_MAX),
  status: z.enum(['unbilled', 'written_off']),
});
export type SetDisbursementStatusInput = z.infer<typeof SetDisbursementStatusInput>;

export interface SetDisbursementStatusResult {
  updated: string[];
  skipped: string[];
}
