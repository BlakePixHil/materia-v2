import * as z from 'zod';

import { DocIdSchema } from './schemas/common';
import {
  DisclosureRequirementSchema,
  DisclosureSentMethodSchema,
  DisclosureWaiverReasonSchema,
  type CostsDisclosure,
  type CostsDisclosureStatus,
  type DisclosureEvent,
  type DisclosureRequirement,
  type DisclosureSentMethod,
  type DisclosureUpdateReason,
  type DisclosureWaiverReason,
  type FeeTerms,
} from './schemas/contacts-matters';
import { JurisdictionSchema } from './schemas/enums';
import { addDays, compareDates, DateOnlySchema, type DateOnly } from './values/date-only';
import { formatCents, type Cents } from './values/money';
import rulesFile from '../../costs-disclosure/rules.json';

/*
 * Costs disclosure (BILL-06, ADR-052): under the Legal Profession Uniform Law (Part 4.3) a law
 * practice discloses the basis of its costs and an estimate of the total, and again when anything
 * disclosed changes significantly. Which disclosure an estimate needs comes from versioned rules
 * per jurisdiction (`libs/domain/costs-disclosure/rules.json`); everything here is pure, so intake,
 * the matter screen and the functions agree. The VIC v1 rules and the wording are ILLUSTRATIVE
 * until a practitioner signs them off (BILL-06a): the feature ships behind `billing.costsDisclosure`.
 */

// ---------- the rules ----------

/** One band of a jurisdiction's rules: estimates up to `maxCents` (inclusive; the last band has none). */
export const DisclosureBandSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    maxCents: z.number().int().positive().optional(),
    requirement: DisclosureRequirementSchema,
    /** The template the disclosure is generated from (a system template id; a firm's own replaces it). */
    formTemplateId: z.string().min(1).optional(),
    citation: z.string().min(1),
  })
  .strict();
export type DisclosureBand = z.infer<typeof DisclosureBandSchema>;

export const DisclosureRulesSchema = z
  .object({
    version: z.string().regex(/^[a-z]+-v\d+$/),
    name: z.string().min(1),
    /** Not yet signed off by a practitioner: the screens say so. */
    illustrative: z.boolean(),
    bands: z.array(DisclosureBandSchema).min(1),
  })
  .strict()
  .superRefine((rules, ctx) => {
    rules.bands.forEach((band, i) => {
      const last = i === rules.bands.length - 1;
      if (last !== (band.maxCents === undefined)) {
        ctx.addIssue({ code: 'custom', path: ['bands', i, 'maxCents'], message: 'Only the last band is open-ended' });
      }
      const previous = rules.bands[i - 1]?.maxCents;
      if (previous !== undefined && band.maxCents !== undefined && band.maxCents <= previous) {
        ctx.addIssue({ code: 'custom', path: ['bands', i, 'maxCents'], message: 'Bands go up in order' });
      }
      if (band.requirement !== 'none' && !band.formTemplateId) {
        ctx.addIssue({ code: 'custom', path: ['bands', i, 'formTemplateId'], message: 'A disclosure needs a form' });
      }
    });
  });
export type DisclosureRules = z.infer<typeof DisclosureRulesSchema>;

export const DisclosureRulesFileSchema = z
  .object({
    $comment: z.string().optional(),
    schemaVersion: z.literal(1),
    jurisdictions: z.partialRecord(JurisdictionSchema, DisclosureRulesSchema),
  })
  .strict();
export type DisclosureRulesFile = z.infer<typeof DisclosureRulesFileSchema>;

let parsedRules: DisclosureRulesFile | undefined;

/** The rules file, checked once (a malformed file fails every test that reads it). */
export function costsDisclosureRules(): DisclosureRulesFile {
  return (parsedRules ??= DisclosureRulesFileSchema.parse(rulesFile));
}

/** A jurisdiction's rules, or undefined where none are configured (never another state's). */
export function disclosureRulesFor(jurisdiction: string): DisclosureRules | undefined {
  const rules = costsDisclosureRules().jurisdictions;
  return Object.hasOwn(rules, jurisdiction) ? rules[jurisdiction as keyof typeof rules] : undefined;
}

/** The full disclosure's built-in template: what's generated when the band can't be told. */
export const FULL_DISCLOSURE_TEMPLATE_ID = 'system-costs-disclosure';

// ---------- assessing an estimate ----------

/** The fee terms a disclosure is assessed on (optional fields may be present as undefined). */
export type DisclosureFee = Pick<FeeTerms, 'arrangement'> & {
  [K in 'amountCents' | 'capCents' | 'estimateCents' | 'estimateHighCents']?: FeeTerms[K] | undefined;
};

/**
 * The estimate a disclosure is judged on: the top of the estimate's range, else the single
 * estimate, else the fixed fee or the cap; zero for pro bono; undefined when nothing says (an
 * hourly matter without an estimate).
 */
export function disclosureBasisCents(fee: DisclosureFee | null | undefined): Cents | undefined {
  if (!fee) return undefined;
  if (fee.arrangement === 'pro_bono') return 0 as Cents;
  const estimate = fee.estimateHighCents ?? fee.estimateCents;
  if (estimate !== undefined) return estimate as Cents;
  if (fee.arrangement === 'fixed') return fee.amountCents as Cents | undefined;
  if (fee.arrangement === 'capped') return fee.capCents as Cents | undefined;
  return undefined;
}

export interface DisclosureAssessment {
  jurisdiction: string;
  /** False where the jurisdiction has no rules: the screens say so and nothing is assumed. */
  rulesConfigured: boolean;
  rulesVersion?: string;
  illustrative: boolean;
  /** The band's requirement; absent when it can't be told (no rules, or no estimate yet). */
  requirement?: DisclosureRequirement;
  band?: DisclosureBand;
  citation?: string;
  /** There's no estimate to assess. */
  estimateNeeded: boolean;
  /** The template to generate the disclosure from: the band's, else the full disclosure. */
  formTemplateId: string;
}

/**
 * Which disclosure an estimate needs (BILL-06): the first band of the jurisdiction's rules whose
 * `maxCents` the estimate doesn't pass. Without rules for the jurisdiction, or without an estimate,
 * the requirement is unknown (never assumed): the matter still needs a disclosure.
 */
export function assessDisclosure(input: {
  jurisdiction: string;
  estimateHighCents: number | undefined;
}): DisclosureAssessment {
  const { jurisdiction, estimateHighCents } = input;
  const rules = disclosureRulesFor(jurisdiction);
  const estimateNeeded = estimateHighCents === undefined;
  if (!rules) {
    return {
      jurisdiction,
      rulesConfigured: false,
      illustrative: false,
      estimateNeeded,
      formTemplateId: FULL_DISCLOSURE_TEMPLATE_ID,
    };
  }
  const base = { jurisdiction, rulesConfigured: true, rulesVersion: rules.version, illustrative: rules.illustrative };
  const fullForm = rules.bands.at(-1)?.formTemplateId ?? FULL_DISCLOSURE_TEMPLATE_ID;
  if (estimateHighCents === undefined) return { ...base, estimateNeeded: true, formTemplateId: fullForm };
  const band = rules.bands.find((b) => b.maxCents === undefined || estimateHighCents <= b.maxCents) as DisclosureBand;
  // A disclosure given below the lower threshold uses the first form the rules have.
  const form = band.formTemplateId ?? rules.bands.find((b) => b.formTemplateId)?.formTemplateId ?? fullForm;
  return {
    ...base,
    requirement: band.requirement,
    band,
    citation: band.citation,
    estimateNeeded: false,
    formTemplateId: form,
  };
}

/** Whether a disclosure is needed: not for pro bono, or an estimate below the lower threshold. */
export function disclosureNeed(
  assessment: DisclosureAssessment,
  fee: Pick<DisclosureFee, 'arrangement'> | null | undefined,
): { status: 'required' | 'not_required'; notRequiredReason?: 'below_threshold' | 'pro_bono' } {
  if (fee?.arrangement === 'pro_bono') return { status: 'not_required', notRequiredReason: 'pro_bono' };
  if (assessment.requirement === 'none') return { status: 'not_required', notRequiredReason: 'below_threshold' };
  return { status: 'required' };
}

/** The assessment's fields as `matter.costsDisclosure` keeps them (absent ones cleared to undefined). */
function assessedFields(assessment: DisclosureAssessment, basisCents: Cents | undefined) {
  return {
    requirement: assessment.requirement,
    bandId: assessment.band?.id,
    rulesVersion: assessment.rulesVersion,
    basisEstimateCents: basisCents,
  };
}

/** Drops undefined fields, so the record writes and compares cleanly. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** The most history lines a matter keeps (the oldest go first). */
export const DISCLOSURE_HISTORY_MAX = 50;

/** The history with one more line, newest last, at most `DISCLOSURE_HISTORY_MAX`. */
export function withDisclosureEvent(history: readonly DisclosureEvent[] | undefined, event: DisclosureEvent) {
  return [...(history ?? []), compact(event)].slice(-DISCLOSURE_HISTORY_MAX);
}

/** A lawyer's record that no disclosure is needed, with its reason ("other" needs a note). */
export const DisclosureWaiverInput = z
  .object({
    reason: DisclosureWaiverReasonSchema,
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine((waiver, ctx) => {
    if (waiver.reason === 'other' && !waiver.note) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'Say why no disclosure is needed' });
    }
  });
export type DisclosureWaiverInput = z.infer<typeof DisclosureWaiverInput>;

/**
 * A new matter's costs disclosure (CORE-05 intake, BILL-06): assessed from the jurisdiction's rules
 * and the fee. `requested` is what intake asked for: `waived` with the lawyer's reason, `required`
 * (kept even below the threshold), or `not_required` (refused by the caller when the estimate needs
 * one). A required disclosure is due from `today`.
 */
export function initialCostsDisclosure(options: {
  jurisdiction: string;
  fee: DisclosureFee | null | undefined;
  requested?: 'required' | 'not_required' | 'waived' | undefined;
  waiver?: DisclosureWaiverInput | undefined;
  uid: string;
  now: Date;
  today: DateOnly;
}): CostsDisclosure {
  const basis = disclosureBasisCents(options.fee);
  const assessment = assessDisclosure({ jurisdiction: options.jurisdiction, estimateHighCents: basis });
  const need = disclosureNeed(assessment, options.fee);
  const waived = options.requested === 'waived' && !!options.waiver;
  const status: CostsDisclosureStatus = waived ? 'waived' : options.requested === 'required' ? 'required' : need.status;
  const record = compact({
    status,
    ...assessedFields(assessment, basis),
    notRequiredReason: status === 'not_required' ? need.notRequiredReason : undefined,
    requiredSince: status === 'required' ? options.today : undefined,
    waiver:
      waived && options.waiver
        ? compact({ ...options.waiver, note: options.waiver.note || undefined, by: options.uid, at: options.now })
        : undefined,
    history: [] as DisclosureEvent[],
  });
  record.history = withDisclosureEvent([], {
    at: options.now,
    by: options.uid,
    action: waived ? 'waived' : 'assessed',
    status,
    requirement: assessment.requirement,
    estimateCents: basis,
  });
  return record;
}

// ---------- an estimate revision (BILL-05) ----------

/** An estimate revision is significant when it rises by more than this percentage, unless the org sets its own. */
export const DEFAULT_DISCLOSURE_CHANGE_PCT = 10;

export const DisclosureChangePctSchema = z.number().int().min(1).max(100);

/** The org's significant-change percentage (`org.billing.disclosureChangePct`); the default when unset or malformed. */
export function disclosureChangePct(
  org: { billing?: { disclosureChangePct?: unknown } | undefined } | null | undefined,
): number {
  const parsed = DisclosureChangePctSchema.safeParse(org?.billing?.disclosureChangePct);
  return parsed.success ? parsed.data : DEFAULT_DISCLOSURE_CHANGE_PCT;
}

/**
 * Why a revised estimate needs an updated disclosure, compared with the one last disclosed: its
 * band moved (`band`), it rose by more than `pct`% (`increase`, compared exactly), or an estimate is
 * given where the disclosure had none (`estimate`). Empty when the change isn't significant.
 */
export function significantDisclosureChange(options: {
  disclosed: { estimateCents?: number | undefined; bandId?: string | undefined };
  next: { estimateCents?: number | undefined; bandId?: string | undefined };
  pct: number;
}): DisclosureUpdateReason[] {
  const { disclosed, next, pct } = options;
  const reasons: DisclosureUpdateReason[] = [];
  if (disclosed.bandId && next.bandId && disclosed.bandId !== next.bandId) reasons.push('band');
  if (disclosed.estimateCents === undefined) {
    if (next.estimateCents !== undefined && next.estimateCents > 0) reasons.push('estimate');
  } else if (next.estimateCents !== undefined && next.estimateCents * 100 > disclosed.estimateCents * (100 + pct)) {
    reasons.push('increase');
  }
  return reasons;
}

export interface DisclosureRevision {
  next: CostsDisclosure;
  /** The revision made a disclosure already given out of date: a task and a notification follow. */
  updateRequired: boolean;
  /** A matter that needed none now needs one (it's due from today; the 7-day reminder covers it). */
  becameRequired: boolean;
  reasons: DisclosureUpdateReason[];
  /** Nothing about the disclosure changed. */
  unchanged: boolean;
}

/**
 * What a fee revision (BILL-05) does to a matter's costs disclosure (BILL-06): the requirement is
 * assessed again on the new estimate. Before anything is disclosed the status follows the estimate
 * (`required` or `not_required`); once a disclosure is sent, a significant change (the band moves,
 * or the estimate rises by more than the org's percentage) makes it `update_required` from today.
 * A waiver stands. The history gains a line whenever the status or the assessment changes.
 */
export function reviseDisclosure(options: {
  current: CostsDisclosure | null | undefined;
  jurisdiction: string;
  fee: DisclosureFee | null | undefined;
  pct: number;
  uid: string;
  now: Date;
  today: DateOnly;
}): DisclosureRevision {
  const current = (options.current ?? { status: 'required', history: [] }) as CostsDisclosure;
  const basis = disclosureBasisCents(options.fee);
  const assessment = assessDisclosure({ jurisdiction: options.jurisdiction, estimateHighCents: basis });
  const need = disclosureNeed(assessment, options.fee);
  const assessed = assessedFields(assessment, basis);
  let status = current.status;
  let reasons: DisclosureUpdateReason[] = [];
  const patch: Partial<CostsDisclosure> = { ...assessed };

  if (status === 'not_required' || status === 'required') {
    status = need.status;
    patch.notRequiredReason = status === 'not_required' ? need.notRequiredReason : undefined;
    patch.requiredSince = status === 'required' ? (current.requiredSince ?? options.today) : undefined;
    if (status !== 'required') patch.remindedOn = undefined;
  } else if (status === 'sent' || status === 'updated') {
    reasons = significantDisclosureChange({
      disclosed: {
        estimateCents: current.sentEstimateCents ?? current.basisEstimateCents ?? current.estimateCents,
        bandId: current.sentBandId ?? current.bandId,
      },
      next: { estimateCents: basis, bandId: assessment.band?.id },
      pct: options.pct,
    });
    if (reasons.length) {
      status = 'update_required';
      patch.updateReasons = reasons;
      patch.requiredSince = options.today;
      patch.remindedOn = undefined;
    }
  }
  // `update_required` stays until an updated disclosure is sent; `waived` stays until a lawyer removes it.

  // A patch field set to undefined clears it: `compact` drops it from the spread.
  const next = compact({ ...current, ...patch, status }) as CostsDisclosure;
  const assessmentChanged =
    current.requirement !== next.requirement ||
    current.bandId !== next.bandId ||
    current.rulesVersion !== next.rulesVersion ||
    (current.basisEstimateCents ?? current.estimateCents) !== next.basisEstimateCents;
  const unchanged = current.status === status && !assessmentChanged;
  if (!unchanged) {
    next.history = withDisclosureEvent(current.history, {
      at: options.now,
      by: options.uid,
      action: status === 'update_required' && current.status !== 'update_required' ? 'update_required' : 'reassessed',
      status,
      requirement: assessment.requirement,
      estimateCents: basis,
    });
  }
  return {
    next,
    updateRequired: status === 'update_required' && current.status !== 'update_required',
    becameRequired: status === 'required' && current.status === 'not_required',
    reasons,
    unchanged,
  };
}

// ---------- recording it ----------

/** What recording a disclosure as sent makes the status: `updated` after one was already given. */
export function sentStatus(current: Pick<CostsDisclosure, 'status' | 'sentOn'>): 'sent' | 'updated' {
  return current.status === 'update_required' || current.status === 'updated' || !!current.sentOn ? 'updated' : 'sent';
}

/** Statuses a disclosure can be recorded as sent from (a waiver is removed first). */
export const SENDABLE_DISCLOSURE_STATUSES: readonly CostsDisclosureStatus[] = [
  'required',
  'update_required',
  'not_required',
  'sent',
  'updated',
];

/** Waiting on someone: a disclosure is due and not yet given. */
export function disclosureOutstanding(status: CostsDisclosureStatus | undefined): boolean {
  return status === 'required' || status === 'update_required';
}

/** Days a required disclosure may go unsent before the responsible lawyer gets a task and a reminder. */
export const DISCLOSURE_REMINDER_DAYS = 7;

/**
 * Whether the nightly run should remind about a matter's disclosure: it is still `required`
 * `DISCLOSURE_REMINDER_DAYS` after it became due, and hasn't been reminded about since.
 * (`update_required` gets its task and notification when the estimate changes.) `fallbackSince` is
 * the day the matter opened, for matters from before BILL-06.
 */
export function disclosureReminderDue(
  disclosure: Pick<CostsDisclosure, 'status' | 'requiredSince' | 'remindedOn'> | null | undefined,
  today: DateOnly,
  fallbackSince?: DateOnly,
): boolean {
  if (disclosure?.status !== 'required') return false;
  const since = disclosure.requiredSince ?? fallbackSince;
  if (!since) return false;
  if (compareDates(addDays(since, DISCLOSURE_REMINDER_DAYS), today) > 0) return false;
  return !disclosure.remindedOn || compareDates(disclosure.remindedOn, since) < 0;
}

/** The server's "send the disclosure" task on a matter: one per time it falls due, so a done one is never reopened. */
export function disclosureTaskId(kind: 'due' | 'update', since: DateOnly): string {
  return `costs-disclosure-${kind}-${since}`;
}

// ---------- words ----------

export const DISCLOSURE_STATUS_LABELS: Readonly<Record<CostsDisclosureStatus, string>> = {
  not_required: 'Not required',
  required: 'Required',
  sent: 'Sent',
  update_required: 'Update required',
  updated: 'Updated disclosure sent',
  waived: 'Not needed (recorded by a lawyer)',
};

export const DISCLOSURE_REQUIREMENT_LABELS: Readonly<Record<DisclosureRequirement, string>> = {
  none: 'No disclosure required',
  short_form: 'Short form (uniform standard disclosure form)',
  full: 'Full disclosure',
};

export const DISCLOSURE_WAIVER_REASON_LABELS: Readonly<Record<DisclosureWaiverReason, string>> = {
  commercial_or_government: 'Commercial or government client',
  sophisticated_client: 'Sophisticated client',
  other: 'Other reason',
};

export const DISCLOSURE_SENT_METHOD_LABELS: Readonly<Record<DisclosureSentMethod, string>> = {
  email: 'Email',
  post: 'Post',
  hand: 'By hand',
};

export const DISCLOSURE_UPDATE_REASON_LABELS: Readonly<Record<DisclosureUpdateReason, string>> = {
  band: 'the estimate moved to a different disclosure band',
  increase: 'the estimate went up by more than the practice’s threshold',
  estimate: 'an estimate was given after the disclosure',
};

const money = (cents: number) => formatCents(cents as Cents);

/**
 * One line saying what a matter needs, for intake and the matter screen: "Full disclosure required
 * (estimate $4,500.00)", "Required: estimate needed", "Rules not configured for NSW", "Not required:
 * pro bono".
 */
export function disclosureNeedText(disclosure: {
  status: CostsDisclosureStatus;
  requirement?: DisclosureRequirement | undefined;
  rulesVersion?: string | undefined;
  basisEstimateCents?: number | undefined;
  notRequiredReason?: 'below_threshold' | 'pro_bono' | undefined;
  jurisdiction: string;
}): string {
  const estimate = disclosure.basisEstimateCents;
  const shown = estimate !== undefined ? ` (estimate ${money(estimate)})` : '';
  if (disclosure.notRequiredReason === 'pro_bono') return 'Not required: pro bono';
  if (disclosure.status === 'not_required') return `Not required${shown}`;
  if (!disclosure.rulesVersion) return `Rules not configured for ${disclosure.jurisdiction}${shown}`;
  if (estimate === undefined) return 'Required: estimate needed';
  const requirement = disclosure.requirement;
  if (requirement === 'short_form') return `Short-form disclosure required${shown}`;
  if (requirement === 'full') return `Full disclosure required${shown}`;
  return `Disclosure recorded${shown}`;
}

/** "Short form (uniform standard disclosure form)" for the merge data; full when the band is unknown. */
export function disclosureFormName(requirement: DisclosureRequirement | undefined): string {
  return requirement === 'short_form' ? DISCLOSURE_REQUIREMENT_LABELS.short_form : DISCLOSURE_REQUIREMENT_LABELS.full;
}

// ---------- the costs-* callables ----------

export const COSTS_CALLABLES = {
  generateDisclosure: 'costs-generateDisclosure',
  markDisclosureSent: 'costs-markDisclosureSent',
  setDisclosureWaiver: 'costs-setDisclosureWaiver',
} as const;

const RequestId = z.uuid();

/**
 * `costs-generateDisclosure` (`billing.view`; flag `billing.costsDisclosure`; idempotent): merges
 * the disclosure template for the matter's band (the firm's own when it replaces the built-in one)
 * with the matter, client, fee and estimate, and saves it to the matter's documents (category
 * `correspondence`, tag `costs-disclosure`). The matter keeps the document's id.
 */
export const GenerateDisclosureInput = z.object({ requestId: RequestId, matterId: DocIdSchema });
export type GenerateDisclosureInput = z.infer<typeof GenerateDisclosureInput>;

export interface GenerateDisclosureResult {
  matterId: string;
  documentId: string;
  name: string;
  templateId: string;
  /** Merge fields with no value (printed `[[missing: …]]`). */
  missing: string[];
}

/**
 * `costs-markDisclosureSent` (`billing.view`; flag; idempotent): records the disclosure as given on
 * `sentOn` (not after today) by `method`. Emailing it from Materia comes later. The status becomes
 * `sent`, or `updated` after an earlier one, and the open disclosure task is completed.
 */
export const MarkDisclosureSentInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  sentOn: DateOnlySchema,
  method: DisclosureSentMethodSchema,
  /** The document given; defaults to the last one generated. */
  documentId: DocIdSchema.optional(),
});
export type MarkDisclosureSentInput = z.infer<typeof MarkDisclosureSentInput>;

/**
 * `costs-setDisclosureWaiver` (`matter.fee`: lawyer and above; flag; idempotent; audited): records
 * that no disclosure is needed (a commercial or government client, a sophisticated client, or
 * another reason with a note), or with `waiver: null` removes that and assesses the estimate again.
 */
export const SetDisclosureWaiverInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  waiver: DisclosureWaiverInput.nullable(),
});
export type SetDisclosureWaiverInput = z.infer<typeof SetDisclosureWaiverInput>;

export interface DisclosureResult {
  matterId: string;
  status: CostsDisclosureStatus;
}
