import type { z } from 'zod';

import {
  contactDisplayName,
  contactSubject,
  costsDisclosureRequirement,
  feeEstimateCents,
  INTAKE_STEP_SCHEMAS,
  INTAKE_STEPS,
  intakeCostsDisclosure,
  intakeDetailsStep,
  intakeFormSchema,
  IntakeFeesStep,
  OTHER_SIDE_ROLE,
  type ConflictStatus,
  type ConflictSubject,
  type CostsDisclosureInput,
  type DateOnly,
  type DisputeRole,
  type FeeArrangement,
  type IntakeForm,
  type IntakeStepId,
  type MatterType,
  type PartyRole,
  type Priority,
} from '@materia/domain';
import { MATTER_TYPE_LABELS, type MtIconName, type MtOption } from '@materia/ui';

import type { ConflictRun } from '../conflicts/conflict-check-panel';
import { parseDob } from '../conflicts/conflict-view';

/**
 * The New matter form's state (CORE-05) and the pure rules around it: each step's input for the
 * shared zod step schemas (`libs/domain` intake.ts), inline error messages, the parties and
 * conflict subjects earlier steps imply, the suggested title and the costs disclosure. The state
 * is plain JSON (text as typed, contacts by id), so it is what an intake draft stores.
 */

/** What the form keeps about a contact it refers to (for names, conflict subjects and date checks). */
export interface IntakeContact {
  kind: 'person' | 'organisation';
  name: string;
  givenNames?: string;
  familyName?: string;
  orgName?: string;
  dateOfBirth?: string;
  dateOfDeath?: string;
  email?: string;
  phone?: string;
  abn?: string;
}

export interface IntakeDetailsState {
  /** The testator (will) or the principal (power of attorney). */
  personContactId: string | null;
  deceasedContactId: string | null;
  /** As typed (`22/07/2026`); ignored while `dateOfDeathUnknown`. */
  dateOfDeath: string;
  dateOfDeathUnknown: boolean;
  domicile: string;
  lastAddress: string;
  willExists: boolean | null;
  willDate: string;
  ourRole: DisputeRole | null;
  otherSideContactIds: string[];
  trustName: string;
  trusteeContactIds: string[];
}

export interface IntakePartyState {
  contactId: string;
  role: PartyRole;
  share: string;
}

export interface IntakeFeesState {
  arrangement: FeeArrangement;
  /** Dollar amounts as typed (`1,500` or `1500.50`). */
  amount: string;
  estimate: string;
  cap: string;
  rateOverride: string;
  upliftPct: string;
  condition: string;
  waived: boolean;
}

export interface IntakeConflictState {
  /** The last `conflicts-run` on this intake's subjects. */
  run: ConflictRun | null;
  status: ConflictStatus;
  reason: string;
}

export interface IntakeReviewState {
  title: string;
  /** The title was typed, so it no longer follows the suggestion. */
  titleEdited: boolean;
  responsibleUid: string;
  teamUids: string[];
  /** Comma-separated, as typed. */
  labels: string;
  priority: Priority;
}

export interface IntakeState {
  type: MatterType | null;
  clientContactIds: string[];
  contacts: Record<string, IntakeContact>;
  details: IntakeDetailsState;
  parties: IntakePartyState[];
  /** The type the parties were prefilled for (prefilled once per type). */
  partiesPrefilledFor: MatterType | null;
  fees: IntakeFeesState;
  conflict: IntakeConflictState;
  review: IntakeReviewState;
  /** The furthest step reached (its index). */
  reached: number;
  /** The `matters-createMatter` request id: kept across retries (and reloads) until the create succeeds. */
  requestId: string | null;
}

export function emptyIntakeState(): IntakeState {
  return {
    type: null,
    clientContactIds: [],
    contacts: {},
    details: {
      personContactId: null,
      deceasedContactId: null,
      dateOfDeath: '',
      dateOfDeathUnknown: false,
      domicile: 'VIC',
      lastAddress: '',
      willExists: null,
      willDate: '',
      ourRole: null,
      otherSideContactIds: [],
      trustName: '',
      trusteeContactIds: [],
    },
    parties: [],
    partiesPrefilledFor: null,
    fees: {
      arrangement: 'hourly',
      amount: '',
      estimate: '',
      cap: '',
      rateOverride: '',
      upliftPct: '',
      condition: '',
      waived: false,
    },
    conflict: { run: null, status: 'pending', reason: '' },
    review: { title: '', titleEdited: false, responsibleUid: '', teamUids: [], labels: '', priority: 'none' },
    reached: 0,
    requestId: null,
  };
}

/** A stored draft's state over the empty form (missing or unreadable parts stay empty). */
export function restoreIntakeState(stored: Record<string, unknown>): IntakeState {
  const empty = emptyIntakeState();
  const pick = <K extends keyof IntakeState>(key: K): IntakeState[K] => {
    const value = stored[key];
    const fallback = empty[key];
    if (value === undefined || value === null) return fallback;
    if (typeof fallback === 'object' && fallback !== null && !Array.isArray(fallback)) {
      return typeof value === 'object' && !Array.isArray(value)
        ? ({ ...fallback, ...value } as IntakeState[K])
        : fallback;
    }
    if (Array.isArray(fallback)) return (Array.isArray(value) ? value : fallback) as IntakeState[K];
    return value as IntakeState[K];
  };
  return {
    type: pick('type'),
    clientContactIds: pick('clientContactIds'),
    contacts: pick('contacts'),
    details: pick('details'),
    parties: pick('parties'),
    partiesPrefilledFor: pick('partiesPrefilledFor'),
    fees: pick('fees'),
    conflict: pick('conflict'),
    review: pick('review'),
    reached: typeof stored['reached'] === 'number' ? stored['reached'] : 0,
    requestId: typeof stored['requestId'] === 'string' ? stored['requestId'] : null,
  };
}

/** The state as JSON (drops `undefined`), ready for `encodeIntakeDraftState`. */
export function intakeStateJson(state: IntakeState): Record<string, never> {
  return JSON.parse(JSON.stringify(state)) as Record<string, never>;
}

// ---------- steps and types ----------

export const INTAKE_STEP_TITLES: Readonly<Record<IntakeStepId, string>> = {
  type: 'Matter type',
  clients: 'Clients',
  details: 'Details',
  parties: 'Parties',
  fees: 'Fees',
  conflict: 'Conflict check',
  review: 'Review and create',
};

export const INTAKE_STEP_LIST = INTAKE_STEPS.map((id) => ({ id, title: INTAKE_STEP_TITLES[id] }));

const TYPE_DESCRIPTIONS: Readonly<Record<MatterType, string>> = {
  will: 'Prepare and sign a will for a living client.',
  poa: 'Enduring or general power of attorney for a principal.',
  probate: 'Apply for a grant of probate of a will.',
  loa: 'Letters of administration, with or without a will.',
  admin: 'Administer an estate after the grant: assets, debts, distribution.',
  fp: 'A family provision claim against an estate (Part IV).',
  contest: 'A dispute about a will’s validity or meaning.',
  trust: 'Set up or administer a testamentary trust.',
};

const TYPE_ICONS: Readonly<Record<MatterType, MtIconName>> = {
  will: 'document',
  poa: 'user',
  probate: 'court',
  loa: 'draft',
  admin: 'list',
  fp: 'family-tree',
  contest: 'scale',
  trust: 'shield',
};

export const MATTER_TYPES: readonly MatterType[] = ['will', 'poa', 'probate', 'loa', 'admin', 'fp', 'contest', 'trust'];

export const MATTER_TYPE_OPTIONS: MtOption<MatterType>[] = MATTER_TYPES.map((type) => ({
  value: type,
  label: MATTER_TYPE_LABELS[type],
  description: TYPE_DESCRIPTIONS[type],
  icon: TYPE_ICONS[type],
}));

export const ESTATE_TYPES: readonly MatterType[] = ['probate', 'loa', 'admin'];
export const DISPUTE_TYPES: readonly MatterType[] = ['fp', 'contest'];
export const hasDeceased = (type: MatterType | null) =>
  !!type && (ESTATE_TYPES.includes(type) || DISPUTE_TYPES.includes(type));

export const DISPUTE_ROLE_OPTIONS: MtOption<DisputeRole>[] = [
  { value: 'plaintiff', label: 'Plaintiff', description: 'Our client brings the claim.' },
  { value: 'defendant', label: 'Defendant', description: 'Our client defends the claim.' },
  { value: 'executor', label: 'Executor', description: 'We act for the estate.' },
];

export const FEE_ARRANGEMENT_OPTIONS: MtOption<FeeArrangement>[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'fixed', label: 'Fixed fee' },
  { value: 'capped', label: 'Capped' },
  { value: 'conditional', label: 'Conditional' },
  { value: 'pro_bono', label: 'Pro bono' },
];

// ---------- parsing what was typed ----------

/** `1,500` or `$1500.50` → cents; undefined when empty; null when it isn't an amount. */
export function parseDollars(text: string): number | undefined | null {
  const trimmed = text.replace(/[\s$,]/g, '');
  if (!trimmed) return undefined;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
}

/** Cents → `1500` or `1500.50` for the input. */
export function formatDollarsInput(cents: number | undefined): string {
  if (cents === undefined) return '';
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

const AMOUNT_ERROR = 'Enter an amount like 1,500 or 1,500.50';
const DATE_ERROR = 'Enter a date like 22/07/2026';

/** A date as typed → DateOnly; undefined when empty; null when it isn't a date. */
function parseDate(text: string): DateOnly | undefined | null {
  if (!text.trim()) return undefined;
  return (parseDob(text) as DateOnly | null) ?? null;
}

// ---------- step inputs ----------

type Errors = Record<string, string>;

/** Each step's input for its schema, plus errors found while reading the text (bad dates, amounts). */
interface StepInput {
  value: Record<string, unknown>;
  errors: Errors;
}

function detailsInput(state: IntakeState): StepInput {
  const d = state.details;
  const errors: Errors = {};
  const type = state.type;
  const id = (value: string | null) => value ?? undefined;
  if (type === 'will') return { value: { type, testatorContactId: id(d.personContactId) }, errors };
  if (type === 'poa') return { value: { type, principalContactId: id(d.personContactId) }, errors };
  if (type === 'trust') {
    return { value: { type, trustName: d.trustName, trusteeContactIds: d.trusteeContactIds }, errors };
  }
  if (!type) return { value: {}, errors };
  let dateOfDeath: string | undefined;
  if (d.dateOfDeathUnknown) dateOfDeath = 'unknown';
  else {
    const parsed = parseDate(d.dateOfDeath);
    if (parsed === null) errors['dateOfDeath'] = DATE_ERROR;
    else dateOfDeath = parsed;
  }
  const deceased = d.deceasedContactId ? state.contacts[d.deceasedContactId] : undefined;
  const lastAddress = d.lastAddress.trim();
  const common = {
    type,
    deceasedContactId: id(d.deceasedContactId),
    ...(deceased?.dateOfBirth ? { deceasedDateOfBirth: deceased.dateOfBirth } : {}),
    ...(dateOfDeath ? { dateOfDeath } : {}),
    ...(lastAddress ? { lastAddress } : {}),
  };
  if (DISPUTE_TYPES.includes(type)) {
    const domicile = d.domicile.trim();
    return {
      value: {
        ...common,
        ...(domicile ? { domicile } : {}),
        ourRole: d.ourRole ?? undefined,
        otherSideContactIds: d.otherSideContactIds,
      },
      errors,
    };
  }
  let willDate: string | undefined;
  if (d.willExists) {
    const parsed = parseDate(d.willDate);
    if (parsed === null) errors['willDate'] = DATE_ERROR;
    else willDate = parsed;
  }
  return {
    value: {
      ...common,
      domicile: d.domicile,
      willExists: d.willExists ?? undefined,
      ...(willDate ? { willDate } : {}),
    },
    errors,
  };
}

/** The fee as the schema reads it (amounts in cents), plus errors for amounts that don't parse. */
export function feeInput(fees: IntakeFeesState): StepInput {
  const errors: Errors = {};
  const amount = (key: 'amount' | 'estimate' | 'cap' | 'rateOverride') => {
    const cents = parseDollars(fees[key]);
    if (cents === null) errors[key] = AMOUNT_ERROR;
    return cents ?? undefined;
  };
  const show = {
    amount: fees.arrangement === 'fixed',
    cap: fees.arrangement === 'capped',
    estimate: fees.arrangement !== 'pro_bono',
    rateOverride: fees.arrangement === 'hourly' || fees.arrangement === 'capped' || fees.arrangement === 'conditional',
  };
  const fee: Record<string, unknown> = { arrangement: fees.arrangement };
  const amountCents = show.amount ? amount('amount') : undefined;
  const capCents = show.cap ? amount('cap') : undefined;
  const estimateCents = show.estimate ? amount('estimate') : undefined;
  const rateOverrideCents = show.rateOverride ? amount('rateOverride') : undefined;
  if (amountCents !== undefined) fee['amountCents'] = amountCents;
  if (capCents !== undefined) fee['capCents'] = capCents;
  if (estimateCents !== undefined) fee['estimateCents'] = estimateCents;
  if (rateOverrideCents !== undefined) fee['rateOverrideCents'] = rateOverrideCents;
  if (fees.arrangement === 'conditional') {
    const pct = fees.upliftPct.trim();
    const upliftPct = pct === '' ? undefined : Number(pct.replace('%', ''));
    if (upliftPct !== undefined && Number.isNaN(upliftPct)) errors['upliftPct'] = 'Enter a percentage like 10';
    else if (upliftPct !== undefined || fees.condition.trim()) {
      fee['conditional'] = { upliftPct: upliftPct ?? 0, condition: fees.condition };
    }
  }
  return { value: { fee, costsDisclosureWaived: fees.waived }, errors };
}

function stepInput(state: IntakeState, step: IntakeStepId): StepInput {
  switch (step) {
    case 'type':
      return { value: state.type ? { type: state.type, jurisdiction: 'VIC' } : {}, errors: {} };
    case 'clients':
      return { value: { clientContactIds: state.clientContactIds }, errors: {} };
    case 'details':
      return detailsInput(state);
    case 'parties':
      return {
        value: {
          parties: state.parties.map((p) => ({
            contactId: p.contactId,
            role: p.role,
            ...(p.share.trim() ? { share: p.share.trim() } : {}),
          })),
        },
        errors: {},
      };
    case 'fees':
      return feeInput(state.fees);
    case 'conflict': {
      const reason = state.conflict.reason.trim();
      return {
        value: {
          ...(state.conflict.run ? { checkId: state.conflict.run.checkId } : {}),
          status: state.conflict.status,
          ...(reason ? { reason } : {}),
        },
        errors: {},
      };
    }
    case 'review': {
      const r = state.review;
      return {
        value: {
          title: r.title,
          responsibleUid: r.responsibleUid || undefined,
          teamUids: r.teamUids.filter((uid) => uid !== r.responsibleUid),
          labels: labelList(r.labels),
          priority: r.priority,
        },
        errors: {},
      };
    }
  }
}

/** `grant, urgent ,  grant` → `['grant', 'urgent']`. */
export function labelList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  ];
}

/** Copy for a missing value, by the field the schema reports. */
const REQUIRED_COPY: Readonly<Record<string, string>> = {
  type: 'Choose a matter type',
  clientContactIds: 'Add at least one client',
  testatorContactId: 'Choose the testator',
  principalContactId: 'Choose the principal',
  deceasedContactId: 'Choose the deceased',
  dateOfDeath: 'Enter the date of death, or choose Unknown',
  domicile: 'Enter the domicile',
  willExists: 'Say whether there is a will',
  ourRole: 'Choose who we act for',
  trustName: 'Enter the trust’s name',
  checkId: 'Run the conflict check first',
  title: 'Enter a title',
  responsibleUid: 'Choose the responsible lawyer',
  'conditional.condition': 'Enter the condition',
};

/** The field an error belongs to, as the form names it (`fee.amountCents` → `amount`). */
function fieldKey(step: IntakeStepId, path: readonly PropertyKey[]): string {
  const parts = path.map(String);
  if (step === 'fees' && parts[0] === 'fee') {
    const rest = parts.slice(1).join('.');
    const names: Record<string, string> = {
      amountCents: 'amount',
      capCents: 'cap',
      estimateCents: 'estimate',
      rateOverrideCents: 'rateOverride',
      conditional: 'conditional',
      'conditional.upliftPct': 'upliftPct',
      'conditional.condition': 'condition',
    };
    return names[rest] ?? rest;
  }
  if (step === 'details' && (parts[0] === 'testatorContactId' || parts[0] === 'principalContactId')) {
    return 'personContactId';
  }
  if (step === 'details' && parts[0] === 'otherSideContactIds') return 'otherSideContactIds';
  if (step === 'details' && parts[0] === 'trusteeContactIds') return 'trusteeContactIds';
  return parts.join('.');
}

function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  return path.reduce<unknown>(
    (node, key) => (node && typeof node === 'object' ? (node as Record<PropertyKey, unknown>)[key] : undefined),
    value,
  );
}

function issueMessage(step: IntakeStepId, issue: z.core.$ZodIssue, input: unknown): string {
  const path = issue.path.map(String);
  const key = path.join('.');
  const last = path.at(-1) ?? '';
  const missing =
    valueAt(input, issue.path) === undefined ||
    (issue.code === 'too_small' && 'origin' in issue && issue.origin === 'string');
  if (missing) {
    const copy = REQUIRED_COPY[key] ?? REQUIRED_COPY[last] ?? REQUIRED_COPY[path.slice(-2).join('.')];
    if (copy) return copy;
  }
  if (step === 'fees' && issue.code === 'too_big' && last === 'upliftPct') return 'The uplift is at most 25%';
  if (step === 'type' && key === 'type') return REQUIRED_COPY['type'] ?? issue.message;
  return issue.message;
}

/**
 * A step's problems, by field (`dateOfDeath`, `amount`, `parties.2`): the shared step schema's
 * issues in plain words, the text that didn't parse, and the cross-step checks the step owns.
 */
export function validateStep(state: IntakeState, step: IntakeStepId, today: DateOnly): Errors {
  const { value, errors } = stepInput(state, step);
  const schema = step === 'details' ? intakeDetailsStep({ today: () => today }) : INTAKE_STEP_SCHEMAS[step];
  const result = (schema as z.ZodType).safeParse(value);
  const found: Errors = { ...errors };
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = fieldKey(step, issue.path);
      if (!(key in found)) found[key] = issueMessage(step, issue, value);
    }
  }
  if (step === 'details' && state.type && DISPUTE_TYPES.includes(state.type)) {
    const clients = new Set(state.clientContactIds);
    if (state.details.otherSideContactIds.some((id) => clients.has(id)) && !found['otherSideContactIds']) {
      found['otherSideContactIds'] = 'A client cannot be on the other side';
    }
  }
  return found;
}

/** Whether every step up to and including `step` is valid. */
export function validThrough(state: IntakeState, step: IntakeStepId, today: DateOnly): boolean {
  const last = INTAKE_STEPS.indexOf(step);
  return INTAKE_STEPS.slice(0, last + 1).every((id) => Object.keys(validateStep(state, id, today)).length === 0);
}

/** The finished form for `intakeToCreateMatterInput` (throws when a step is invalid). */
export function buildIntakeForm(state: IntakeState, today: DateOnly): IntakeForm {
  return intakeFormSchema({ today: () => today }).parse(
    Object.fromEntries(INTAKE_STEPS.map((step) => [step, stepInput(state, step).value])),
  );
}

// ---------- who earlier steps put on the matter ----------

export interface DerivedParty {
  contactId: string;
  role: PartyRole;
  /** The step that adds it. */
  from: IntakeStepId;
}

/** The parties the clients and details steps add (the server writes these rows itself). */
export function derivedParties(state: IntakeState): DerivedParty[] {
  const rows: DerivedParty[] = state.clientContactIds.map((contactId) => ({
    contactId,
    role: 'client',
    from: 'clients',
  }));
  const d = state.details;
  const type = state.type;
  if ((type === 'will' || type === 'poa') && d.personContactId) {
    rows.push({ contactId: d.personContactId, role: 'testator', from: 'details' });
  }
  if (hasDeceased(type) && d.deceasedContactId) {
    rows.push({ contactId: d.deceasedContactId, role: 'deceased', from: 'details' });
  }
  if (type && DISPUTE_TYPES.includes(type) && d.ourRole) {
    const ours: PartyRole = d.ourRole;
    state.clientContactIds.forEach((contactId) => rows.push({ contactId, role: ours, from: 'details' }));
    const theirs = OTHER_SIDE_ROLE[d.ourRole];
    d.otherSideContactIds.forEach((contactId) => rows.push({ contactId, role: theirs, from: 'details' }));
  }
  if (type === 'trust')
    d.trusteeContactIds.forEach((contactId) => rows.push({ contactId, role: 'trustee', from: 'details' }));
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.role}|${row.contactId}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/** Parties to start the parties step with: the clients of a grant as its executors or administrators. */
export function suggestedParties(state: IntakeState): IntakePartyState[] {
  const role: PartyRole | null =
    state.type === 'probate' ? 'executor' : state.type === 'loa' || state.type === 'admin' ? 'administrator' : null;
  return role ? state.clientContactIds.map((contactId) => ({ contactId, role, share: '' })) : [];
}

/** The people and organisations the conflict check runs on: everyone on the matter, once per role. */
export function conflictSubjects(state: IntakeState): ConflictSubject[] {
  const rows = [...derivedParties(state), ...state.parties.map((p) => ({ contactId: p.contactId, role: p.role }))];
  const seen = new Set<string>();
  const subjects: ConflictSubject[] = [];
  for (const row of rows) {
    const key = `${row.role}|${row.contactId}`;
    const contact = state.contacts[row.contactId];
    if (seen.has(key) || !contact) continue;
    seen.add(key);
    subjects.push(
      contactSubject(
        {
          ...contact,
          emails: contact.email ? [{ address: contact.email }] : [],
          phones: contact.phone ? [{ number: contact.phone }] : [],
        },
        row.role,
        row.contactId,
      ),
    );
  }
  return subjects;
}

// ---------- review ----------

/** A name for a contact the form knows. */
export function intakeContactName(state: IntakeState, id: string | null | undefined): string {
  return (id && state.contacts[id]?.name) || 'Unknown contact';
}

/** The title the review step suggests: "Estate of …", "Will of …", the trust's name. */
export function suggestedTitle(state: IntakeState): string {
  const d = state.details;
  const name = (id: string | null) => (id ? state.contacts[id]?.name : undefined);
  const client = name(state.clientContactIds[0] ?? null);
  switch (state.type) {
    case 'will':
      return name(d.personContactId) ? `Will of ${name(d.personContactId)}` : '';
    case 'poa':
      return name(d.personContactId) ? `Power of attorney for ${name(d.personContactId)}` : '';
    case 'probate':
    case 'loa':
    case 'admin':
      return name(d.deceasedContactId) ? `Estate of ${name(d.deceasedContactId)}` : '';
    case 'fp':
    case 'contest': {
      const estate = name(d.deceasedContactId);
      const kind = state.type === 'fp' ? 'family provision' : 'will dispute';
      return estate ? `Estate of ${estate} (${kind})` : client ? `${client} (${kind})` : '';
    }
    case 'trust':
      return d.trustName.trim();
    default:
      return '';
  }
}

/** The costs disclosure the fees step implies (PLACEHOLDER rule until BILL-06), or null while the fee is invalid. */
export function costsDisclosureFor(fees: IntakeFeesState): (CostsDisclosureInput & { estimateKnown: boolean }) | null {
  const { value, errors } = feeInput(fees);
  if (Object.keys(errors).length) return null;
  const parsed = IntakeFeesStep.safeParse(value);
  if (!parsed.success) {
    // A half-filled fee still shows what its estimate implies.
    const fee = value['fee'] as Parameters<typeof feeEstimateCents>[0];
    const estimateCents = feeEstimateCents(fee);
    return {
      status: fees.waived ? 'waived' : costsDisclosureRequirement(estimateCents),
      ...(estimateCents !== undefined ? { estimateCents } : {}),
      estimateKnown: estimateCents !== undefined,
    };
  }
  const disclosure = intakeCostsDisclosure(parsed.data);
  return { ...disclosure, estimateKnown: disclosure.estimateCents !== undefined };
}

/** A contact as the form keeps it. */
export function intakeContact(contact: {
  kind?: 'person' | 'organisation';
  givenNames?: string | undefined;
  familyName?: string | undefined;
  preferredName?: string | undefined;
  orgName?: string | undefined;
  dateOfBirth?: string | undefined;
  dateOfDeath?: string | undefined;
  abn?: string | undefined;
  emails?: readonly { address: string }[];
  phones?: readonly { number: string }[];
}): IntakeContact {
  const out: IntakeContact = { kind: contact.kind ?? 'person', name: contactDisplayName(contact) };
  if (contact.givenNames) out.givenNames = contact.givenNames;
  if (contact.familyName) out.familyName = contact.familyName;
  if (contact.orgName) out.orgName = contact.orgName;
  if (contact.dateOfBirth) out.dateOfBirth = contact.dateOfBirth;
  if (contact.dateOfDeath) out.dateOfDeath = contact.dateOfDeath;
  if (contact.abn) out.abn = contact.abn;
  if (contact.emails?.[0]?.address) out.email = contact.emails[0].address;
  if (contact.phones?.[0]?.number) out.phone = contact.phones[0].number;
  return out;
}
