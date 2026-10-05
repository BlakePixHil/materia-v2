import * as z from 'zod';

import { ConflictStatusSchema } from './conflicts';
import { DEFAULT_ORG_TIMEZONE } from './constants';
import type { CreateMatterInput } from './matters';
import { DocIdSchema, InstantSchema, NonEmptyString, withMeta } from './schemas/common';
import {
  EventKindSchema,
  JurisdictionSchema,
  MatterTypeSchema,
  PartyRoleSchema,
  PrioritySchema,
  ReferralSourceSchema,
  type MatterType,
  type PartyRole,
} from './schemas/enums';
import { compareDates, DateOnlySchema, today as todayIn, type DateOnly } from './values/date-only';
import type { Cents } from './values/money';

/**
 * New matter intake (CORE-05): the step schemas the web form validates each step with and the
 * server re-checks, the builder from the finished form to the `matters-createMatter` input, the
 * fee and costs-disclosure rules, and the `users/{uid}/drafts/intake-{id}` drafts.
 *
 * Steps, in order: type → clients → details (type-specific) → parties → fees → conflict → review.
 * New contacts are created first through the contacts flow (`contacts-create`); every step refers
 * to contacts by id.
 */

// ---------- shared pieces ----------

/** Non-negative integer cents (a fee, estimate or cap; never negative). */
const AmountCents = z
  .number()
  .int({ message: 'Expected integer cents' })
  .min(0, { message: 'Enter an amount of $0 or more' })
  .max(100_000_000_00, { message: 'Enter a smaller amount' })
  .transform((value) => value as Cents);

const ContactIds = (min: number, max: number, message: string) =>
  z
    .array(DocIdSchema)
    .min(min, { message })
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Each contact can be listed once' });

/** A problem found by a cross-field check: a field path (relative to the step) and its message. */
export interface IntakeProblem {
  path: (string | number)[];
  message: string;
}

function addProblems(ctx: z.RefinementCtx, problems: readonly IntakeProblem[]): void {
  for (const problem of problems) ctx.addIssue({ code: 'custom', path: problem.path, message: problem.message });
}

/** Options for the date checks: "today" in the org's time zone (defaults to Melbourne, now). */
export interface IntakeDateOptions {
  today?: () => DateOnly;
}
const todayOf = (options: IntakeDateOptions = {}) => (options.today ?? (() => todayIn(DEFAULT_ORG_TIMEZONE)))();

/**
 * What is wrong with a date of death: in the future (after `today`), or before the deceased's date
 * of birth (from their contact, when known). Undefined when it is fine.
 */
export function dateOfDeathProblem(
  dateOfDeath: DateOnly,
  { dateOfBirth, today }: { dateOfBirth?: DateOnly | undefined; today: DateOnly },
): string | undefined {
  if (compareDates(dateOfDeath, today) > 0) return 'The date of death cannot be in the future';
  if (dateOfBirth && compareDates(dateOfDeath, dateOfBirth) < 0) {
    return 'The date of death cannot be before the date of birth';
  }
  return undefined;
}

// ---------- step 1: matter type ----------

export const IntakeTypeStep = z
  .object({
    type: MatterTypeSchema,
    jurisdiction: JurisdictionSchema.default('VIC'),
  })
  .strict();
export type IntakeTypeStep = z.infer<typeof IntakeTypeStep>;

// ---------- step 2: clients ----------

/** At least one client contact (create new ones through the contacts flow first). */
/**
 * The clients and, optionally, how the matter came in (CORE-18): the referrer contact who sent it,
 * or a referral source when no contact did. Never both.
 */
export const IntakeClientsStep = z
  .object({
    clientContactIds: ContactIds(1, 20, 'Add at least one client'),
    referrerContactId: DocIdSchema.optional(),
    referralSource: ReferralSourceSchema.optional(),
  })
  .strict()
  .refine((step) => !(step.referrerContactId && step.referralSource), {
    path: ['referralSource'],
    message: 'Choose a referrer or a source, not both',
  });
export type IntakeClientsStep = z.infer<typeof IntakeClientsStep>;

// ---------- step 3: type-specific details ----------

/** A date of death, or `'unknown'`: the matter is created without one (no event, a death certificate task). */
export const DateOfDeathInput = z.union([DateOnlySchema, z.literal('unknown')]);
export type DateOfDeathInput = z.infer<typeof DateOfDeathInput>;

const deceasedShape = {
  deceasedContactId: DocIdSchema,
  /** The deceased contact's date of birth, when known: only checked against, never stored from here. */
  deceasedDateOfBirth: DateOnlySchema.optional(),
  dateOfDeath: DateOfDeathInput,
  lastAddress: z.string().trim().max(300).optional(),
};

export const ESTATE_MATTER_TYPES = ['probate', 'loa', 'admin'] as const satisfies readonly MatterType[];
export const DISPUTE_MATTER_TYPES = ['fp', 'contest'] as const satisfies readonly MatterType[];

/** Our client's side in a family provision claim or will contest. */
export const DisputeRoleSchema = z.enum(['plaintiff', 'defendant', 'executor']);
export type DisputeRole = z.infer<typeof DisputeRoleSchema>;

/** The role the other side's parties get: the plaintiff's opponent defends, and the estate's opponent claims. */
export const OTHER_SIDE_ROLE: Readonly<Record<DisputeRole, PartyRole>> = {
  plaintiff: 'defendant',
  defendant: 'plaintiff',
  executor: 'plaintiff',
};

const WillDetails = z.object({ type: z.literal('will'), testatorContactId: DocIdSchema }).strict();
const PoaDetails = z.object({ type: z.literal('poa'), principalContactId: DocIdSchema }).strict();
const EstateDetails = z
  .object({
    type: z.enum(ESTATE_MATTER_TYPES),
    ...deceasedShape,
    /** Where the deceased was domiciled (a state, or a country for a reseal). */
    domicile: z.string().trim().min(1, { message: 'Enter the domicile' }).max(60),
    willExists: z.boolean(),
    willDate: DateOnlySchema.optional(),
  })
  .strict();
const DisputeDetails = z
  .object({
    type: z.enum(DISPUTE_MATTER_TYPES),
    ...deceasedShape,
    domicile: z.string().trim().max(60).optional(),
    ourRole: DisputeRoleSchema,
    otherSideContactIds: ContactIds(1, 20, 'Add at least one party on the other side'),
  })
  .strict();
const TrustDetails = z
  .object({
    type: z.literal('trust'),
    trustName: NonEmptyString.max(200),
    trusteeContactIds: ContactIds(1, 20, 'Add at least one trustee'),
  })
  .strict();

const DetailsUnion = z.discriminatedUnion('type', [
  WillDetails,
  PoaDetails,
  EstateDetails,
  DisputeDetails,
  TrustDetails,
]);
export type IntakeDetailsStep = z.infer<typeof DetailsUnion>;

/** Cross-field checks of the details step: dates of death and wills, and who can't be on both sides. */
export function intakeDetailsProblems(details: IntakeDetailsStep, today: DateOnly): IntakeProblem[] {
  const problems: IntakeProblem[] = [];
  if (details.type === 'will' || details.type === 'poa' || details.type === 'trust') return problems;
  const known = details.dateOfDeath === 'unknown' ? undefined : details.dateOfDeath;
  if (details.deceasedDateOfBirth && compareDates(details.deceasedDateOfBirth, today) > 0) {
    problems.push({ path: ['deceasedDateOfBirth'], message: 'The date of birth cannot be in the future' });
  }
  if (known) {
    const problem = dateOfDeathProblem(known, { dateOfBirth: details.deceasedDateOfBirth, today });
    if (problem) problems.push({ path: ['dateOfDeath'], message: problem });
  }
  if (details.type === 'fp' || details.type === 'contest') {
    if (details.otherSideContactIds.includes(details.deceasedContactId)) {
      problems.push({ path: ['otherSideContactIds'], message: 'The deceased cannot be on the other side' });
    }
    return problems;
  }
  if (details.type !== 'probate' && details.type !== 'loa' && details.type !== 'admin') return problems;
  if (details.type === 'probate' && !details.willExists) {
    problems.push({ path: ['willExists'], message: 'Probate needs a will; choose letters of administration instead' });
  }
  if (details.willDate) {
    if (!details.willExists) problems.push({ path: ['willDate'], message: 'There is no will to date' });
    else if (compareDates(details.willDate, today) > 0) {
      problems.push({ path: ['willDate'], message: 'The will date cannot be in the future' });
    } else if (known && compareDates(details.willDate, known) > 0) {
      problems.push({ path: ['willDate'], message: 'The will date cannot be after the date of death' });
    }
  }
  return problems;
}

/** The details step, checked against `today` (pass the org's today; defaults to Melbourne's). */
export function intakeDetailsStep(options: IntakeDateOptions = {}) {
  return DetailsUnion.superRefine((details, ctx) => addProblems(ctx, intakeDetailsProblems(details, todayOf(options))));
}
export const IntakeDetailsStep = intakeDetailsStep();

// ---------- step 4: parties ----------

/**
 * A party row to create with the matter: one row per role and contact (`partyDocId`). The same
 * contact may hold several roles (a testator who is also an executor is two rows).
 */
export const IntakePartyInput = z
  .object({
    contactId: DocIdSchema,
    role: PartyRoleSchema,
    share: z.string().trim().max(60).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();
export type IntakePartyInput = z.infer<typeof IntakePartyInput>;

export const IntakePartiesStep = z
  .object({ parties: z.array(IntakePartyInput).max(100) })
  .strict()
  .superRefine(({ parties }, ctx) => {
    const seen = new Set<string>();
    parties.forEach((party, i) => {
      const key = `${party.role}|${party.contactId}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['parties', i], message: 'This contact is already in this role' });
      }
      seen.add(key);
    });
  });
export type IntakePartiesStep = z.infer<typeof IntakePartiesStep>;

/**
 * A matter event to create with the matter (`matters/{id}/events`). The date of death event comes
 * from `matter.deceased.dateOfDeath` and need not be listed; a listed one must match it.
 */
export const IntakeEventInput = z
  .object({
    kind: EventKindSchema,
    date: DateOnlySchema,
    label: z.string().trim().max(200).optional(),
  })
  .strict();
export type IntakeEventInput = z.infer<typeof IntakeEventInput>;

// ---------- step 5: fees and costs disclosure ----------

export const FeeArrangementSchema = z.enum(['hourly', 'fixed', 'capped', 'conditional', 'pro_bono']);
export type FeeArrangement = z.infer<typeof FeeArrangementSchema>;

/** What a fee arrangement is missing or has in excess. Empty when valid. */
export function feeProblems(fee: {
  arrangement: FeeArrangement;
  amountCents?: number | undefined;
  capCents?: number | undefined;
  estimateCents?: number | undefined;
  rateOverrideCents?: number | undefined;
  conditional?: unknown;
}): IntakeProblem[] {
  const problems: IntakeProblem[] = [];
  if (fee.arrangement === 'fixed' && fee.amountCents === undefined) {
    problems.push({ path: ['amountCents'], message: 'Enter the fixed fee' });
  }
  if (fee.arrangement === 'capped') {
    if (fee.capCents === undefined) problems.push({ path: ['capCents'], message: 'Enter the cap' });
    else if (fee.estimateCents !== undefined && fee.estimateCents > fee.capCents) {
      problems.push({ path: ['estimateCents'], message: 'The estimate cannot be more than the cap' });
    }
  }
  if (fee.arrangement === 'conditional' && !fee.conditional) {
    problems.push({ path: ['conditional'], message: 'Enter the condition and the uplift' });
  }
  if (fee.arrangement !== 'conditional' && fee.conditional) {
    problems.push({ path: ['conditional'], message: 'Only a conditional arrangement has an uplift' });
  }
  if (fee.arrangement === 'pro_bono') {
    for (const key of ['amountCents', 'capCents', 'estimateCents', 'rateOverrideCents'] as const) {
      if (fee[key] !== undefined) problems.push({ path: [key], message: 'A pro bono matter has no fees' });
    }
  }
  return problems;
}

/**
 * The fee arrangement as entered at intake (`matter.fee` without its server-kept `history`).
 * `rateOverrideCents` replaces the responsible person's hourly rate; `conditional.upliftPct` is the
 * uplift on a conditional arrangement (at most 25%).
 */
export const FeeInput = z
  .object({
    arrangement: FeeArrangementSchema,
    amountCents: AmountCents.optional(),
    capCents: AmountCents.optional(),
    estimateCents: AmountCents.optional(),
    rateOverrideCents: AmountCents.optional(),
    conditional: z
      .object({ upliftPct: z.number().min(0).max(25), condition: NonEmptyString.max(500) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((fee, ctx) => addProblems(ctx, feeProblems(fee)));
export type FeeInput = z.infer<typeof FeeInput>;

/**
 * The estimate costs disclosure is judged on: the estimate when given, else the fixed fee or the
 * cap; zero for pro bono; undefined when nothing says (an hourly matter without an estimate).
 */
export function feeEstimateCents(fee: Pick<FeeInput, 'arrangement' | 'amountCents' | 'capCents' | 'estimateCents'>) {
  if (fee.arrangement === 'pro_bono') return 0 as Cents;
  if (fee.estimateCents !== undefined) return fee.estimateCents;
  if (fee.arrangement === 'fixed') return fee.amountCents;
  if (fee.arrangement === 'capped') return fee.capCents;
  return undefined;
}

/**
 * PLACEHOLDER (BILL-06 owns the real rules): below this estimate no costs disclosure is required.
 * It mirrors the Uniform Law's $750 floor for orientation only; it is not legal advice and must
 * not be relied on until BILL-06 replaces `costsDisclosureRequirement` with the reviewed rules.
 */
export const COSTS_DISCLOSURE_PLACEHOLDER_THRESHOLD_CENTS = 750_00;

export type CostsDisclosureRequirement = 'required' | 'not_required';

/**
 * Whether a matter needs a costs disclosure, from its estimate. PLACEHOLDER: a single threshold
 * (`COSTS_DISCLOSURE_PLACEHOLDER_THRESHOLD_CENTS`) until BILL-06. An unknown estimate needs one.
 */
export function costsDisclosureRequirement(estimateCents: number | undefined): CostsDisclosureRequirement {
  if (estimateCents === undefined) return 'required';
  return estimateCents < COSTS_DISCLOSURE_PLACEHOLDER_THRESHOLD_CENTS ? 'not_required' : 'required';
}

/**
 * The costs disclosure a new matter starts with. `waived` is recorded as given (a client who
 * waived disclosure, BILL-06 checks when that is allowed); `not_required` must match the estimate.
 */
export const CostsDisclosureInput = z
  .object({
    status: z.enum(['required', 'not_required', 'waived']),
    estimateCents: AmountCents.optional(),
  })
  .strict();
export type CostsDisclosureInput = z.infer<typeof CostsDisclosureInput>;

export const IntakeFeesStep = z
  .object({
    fee: FeeInput,
    /** The client waived costs disclosure (stored as `waived`; otherwise computed from the estimate). */
    costsDisclosureWaived: z.boolean().default(false),
  })
  .strict();
export type IntakeFeesStep = z.infer<typeof IntakeFeesStep>;

/** The costs disclosure for a fees step: waived, or the requirement for the fee's estimate. */
export function intakeCostsDisclosure(
  step: Pick<IntakeFeesStep, 'fee' | 'costsDisclosureWaived'>,
): CostsDisclosureInput {
  const estimateCents = feeEstimateCents(step.fee);
  return {
    status: step.costsDisclosureWaived ? 'waived' : costsDisclosureRequirement(estimateCents),
    ...(estimateCents !== undefined ? { estimateCents } : {}),
  };
}

// ---------- step 6: conflict ----------

/**
 * The conflict check run for this intake (`conflicts-run`) and its determination. `pending` suits
 * every role; any other status needs `conflict.determine` (checked by the server), and `potential`
 * and `conflict` need a reason. A `conflict` creates the matter as a lead only.
 */
export const IntakeConflictStep = z
  .object({
    checkId: DocIdSchema,
    status: ConflictStatusSchema,
    reason: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((step) => step.status === 'pending' || step.status === 'clear' || !!step.reason, {
    message: 'Give a reason for a potential conflict or a conflict',
    path: ['reason'],
  });
export type IntakeConflictStep = z.infer<typeof IntakeConflictStep>;

// ---------- step 7: review ----------

export const IntakeReviewStep = z
  .object({
    title: NonEmptyString.max(200),
    responsibleUid: DocIdSchema,
    teamUids: z.array(DocIdSchema).max(30).default([]),
    labels: z.array(NonEmptyString.max(40)).max(20).default([]),
    priority: PrioritySchema.default('none'),
    privileged: z.boolean().default(false),
  })
  .strict();
export type IntakeReviewStep = z.infer<typeof IntakeReviewStep>;

// ---------- the whole form ----------

export const IntakeStepIdSchema = z.enum(['type', 'clients', 'details', 'parties', 'fees', 'conflict', 'review']);
export type IntakeStepId = z.infer<typeof IntakeStepIdSchema>;
export const INTAKE_STEPS: readonly IntakeStepId[] = IntakeStepIdSchema.options;

/** Each step's schema, by step id (the details step checks dates against Melbourne's today). */
export const INTAKE_STEP_SCHEMAS = {
  type: IntakeTypeStep,
  clients: IntakeClientsStep,
  details: IntakeDetailsStep,
  parties: IntakePartiesStep,
  fees: IntakeFeesStep,
  conflict: IntakeConflictStep,
  review: IntakeReviewStep,
} as const;

/** The finished form: every step, with the details' type matching the chosen type. */
export function intakeFormSchema(options: IntakeDateOptions = {}) {
  return z
    .object({
      type: IntakeTypeStep,
      clients: IntakeClientsStep,
      details: intakeDetailsStep(options),
      parties: IntakePartiesStep,
      fees: IntakeFeesStep,
      conflict: IntakeConflictStep,
      review: IntakeReviewStep,
    })
    .strict()
    .superRefine((form, ctx) => {
      if (form.details.type !== form.type.type) {
        ctx.addIssue({ code: 'custom', path: ['details', 'type'], message: 'The details are for another matter type' });
      }
      if (form.details.type === 'fp' || form.details.type === 'contest') {
        const clients = new Set(form.clients.clientContactIds);
        form.details.otherSideContactIds.forEach((id, i) => {
          if (clients.has(id)) {
            ctx.addIssue({
              code: 'custom',
              path: ['details', 'otherSideContactIds', i],
              message: 'A client cannot be on the other side',
            });
          }
        });
      }
    });
}
export const IntakeForm = intakeFormSchema();
export type IntakeForm = z.infer<typeof IntakeForm>;

/** The task an intake without a date of death gets (or the template's task with the same key). */
export const DEATH_CERTIFICATE_TASK_KEY = 'obtain_death_certificate';
export const DEATH_CERTIFICATE_TASK_TITLE = 'Obtain the death certificate';

/** The party rows a details step implies besides the matter's own (clients, deceased, testator). */
function detailsParties(details: IntakeDetailsStep, clientContactIds: readonly string[]): IntakePartyInput[] {
  if (details.type === 'trust') return details.trusteeContactIds.map((contactId) => ({ contactId, role: 'trustee' }));
  if (details.type === 'fp' || details.type === 'contest') {
    const ours: PartyRole = details.ourRole;
    return [
      ...clientContactIds.map((contactId) => ({ contactId, role: ours })),
      ...details.otherSideContactIds.map((contactId) => ({ contactId, role: OTHER_SIDE_ROLE[details.ourRole] })),
    ];
  }
  return [];
}

/**
 * The `matters-createMatter` input for a finished, validated form. The server adds the date of
 * death event (when known), the death certificate task (when not), the template's stage and tasks,
 * and dedupes the party rows.
 */
export function intakeToCreateMatterInput(form: IntakeForm, requestId: string): z.input<typeof CreateMatterInput> {
  const { details } = form;
  const deceased =
    details.type === 'will' || details.type === 'poa' || details.type === 'trust'
      ? undefined
      : {
          contactId: details.deceasedContactId,
          ...(details.dateOfDeath === 'unknown' ? {} : { dateOfDeath: details.dateOfDeath }),
          domicile: details.domicile ?? '',
          lastAddress: details.lastAddress ?? '',
        };
  const testatorContactId =
    details.type === 'will'
      ? details.testatorContactId
      : details.type === 'poa'
        ? details.principalContactId
        : undefined;
  const facts =
    details.type === 'trust'
      ? { trustName: details.trustName }
      : (details.type === 'probate' || details.type === 'loa' || details.type === 'admin') && details.willDate
        ? { willDate: details.willDate }
        : undefined;
  const grantType =
    details.type === 'probate'
      ? 'probate'
      : details.type === 'loa'
        ? details.willExists
          ? 'loa_with_will'
          : 'loa'
        : undefined;
  const disputeKind =
    details.type === 'fp' ? 'family_provision' : details.type === 'contest' ? 'will_contest' : undefined;
  const reason = form.conflict.reason?.trim();
  return {
    requestId,
    matter: {
      title: form.review.title,
      type: form.type.type,
      jurisdiction: form.type.jurisdiction,
      responsibleUid: form.review.responsibleUid,
      teamUids: form.review.teamUids,
      labels: form.review.labels,
      priority: form.review.priority,
      privileged: form.review.privileged,
      clientContactIds: form.clients.clientContactIds,
      ...(form.clients.referrerContactId ? { referrerContactId: form.clients.referrerContactId } : {}),
      ...(form.clients.referralSource ? { referralSource: form.clients.referralSource } : {}),
      ...(deceased ? { deceased } : {}),
      ...(testatorContactId ? { testator: { contactId: testatorContactId } } : {}),
      ...(facts ? { facts } : {}),
      ...(grantType ? { estate: { grantType } } : {}),
      ...(disputeKind ? { dispute: { kind: disputeKind, proceedingIds: [] } } : {}),
      conflictCheck: { status: form.conflict.status, ...(reason ? { reason } : {}) },
    },
    parties: [...form.parties.parties, ...detailsParties(details, form.clients.clientContactIds)],
    events: [],
    fee: form.fees.fee,
    costsDisclosure: intakeCostsDisclosure(form.fees),
    conflictCheckId: form.conflict.checkId,
  };
}

// ---------- drafts ----------

/** Drafts expire (Firestore TTL on `expireAt`) this long after their last save. */
export const INTAKE_DRAFT_TTL_DAYS = 30;
/** The largest serialised form state a draft holds (the rules enforce it too). */
export const INTAKE_DRAFT_MAX_STATE_CHARS = 100_000;
/** `intake-` and a client-made id (a UUID, say). The rules check the same pattern. */
export const INTAKE_DRAFT_ID_PATTERN = /^intake-[A-Za-z0-9_-]{1,64}$/;

/** The document id of an intake draft: `intake-{id}`. */
export function intakeDraftId(id: string): string {
  const docId = `intake-${id}`;
  if (!INTAKE_DRAFT_ID_PATTERN.test(docId)) throw new Error('An intake draft id is letters, digits, "-" and "_"');
  return docId;
}

/** When a draft saved at `updatedAt` expires. */
export function intakeDraftExpireAt(updatedAt: Date): Date {
  return new Date(updatedAt.getTime() + INTAKE_DRAFT_TTL_DAYS * 86_400_000);
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const JsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValue), z.record(z.string(), JsonValue)]),
);

/** The partial form state a draft holds: any JSON-safe object (steps may be half filled in). */
export const IntakeDraftStateSchema = z.record(z.string(), JsonValue);
export type IntakeDraftState = z.infer<typeof IntakeDraftStateSchema>;

/** The draft's form state as stored: JSON text, so the rules can limit its size. */
export function encodeIntakeDraftState(state: IntakeDraftState): string {
  const text = JSON.stringify(IntakeDraftStateSchema.parse(state));
  if (text.length > INTAKE_DRAFT_MAX_STATE_CHARS) throw new Error('The draft is too large to save');
  return text;
}

/** A stored draft's form state; an empty object when it is missing or unreadable. */
export function decodeIntakeDraftState(stateJson: string | undefined): IntakeDraftState {
  if (!stateJson) return {};
  try {
    const parsed = IntakeDraftStateSchema.safeParse(JSON.parse(stateJson));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function isJsonObjectText(text: string): boolean {
  try {
    return IntakeDraftStateSchema.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

/**
 * `users/{uid}/drafts/intake-{id}`: a New matter form in progress, private to its user and
 * written by the client directly (no callable). `stateJson` is the partial form state
 * (`encodeIntakeDraftState`), `step` the step to resume at, `orgId` the org it was started in
 * (the caller's current org). Firestore TTL deletes it at `expireAt` (`updatedAt` + 30 days).
 */
export const IntakeDraft = withMeta(
  {
    orgId: DocIdSchema,
    kind: z.literal('intake'),
    step: IntakeStepIdSchema,
    stateJson: z
      .string()
      .max(INTAKE_DRAFT_MAX_STATE_CHARS)
      .refine(isJsonObjectText, { message: 'Expected the form state as a JSON object' }),
    expireAt: InstantSchema,
  },
  { path: 'users/{uid}/drafts', migratable: false },
);
export type IntakeDraft = z.infer<typeof IntakeDraft.schema>;

/** A draft's fields for a save at `now` (the client stamps `updatedAt` and `updatedBy` itself). */
export function intakeDraftFields(orgId: string, step: IntakeStepId, state: IntakeDraftState, now: Date) {
  return {
    orgId,
    kind: 'intake' as const,
    step,
    stateJson: encodeIntakeDraftState(state),
    expireAt: intakeDraftExpireAt(now),
  };
}
