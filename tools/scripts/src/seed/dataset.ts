/**
 * The fictional practice for local development: Harbour & Vine Legal, a wills and estates firm in
 * Geelong. Every document is built with the libs/test-utils factories, so it is schema-valid by
 * construction. All people, matters and documents are invented (the cast of the design mockups);
 * never add real client data here.
 *
 * Dates are relative to `anchor` (today in the org timezone by default), so "due today" and
 * "overdue" stay meaningful whenever the seed runs.
 */
import * as DeadlinesNs from '@materia/deadlines';
import * as D from '@materia/domain';
// Namespace import: the workspace lib loads as CommonJS under tsx, so named imports don't resolve.
import * as TestUtilsNs from '@materia/test-utils';

import { DEMO_CLERK_THREADS, DEMO_CONFLICT_DATES, DEMO_CONTACTS, demoMatters } from './demo-data.ts';
import { applyDemo } from './demo.ts';
import { unwrap } from './interop.ts';

const domain = unwrap(D);
const F = unwrap(TestUtilsNs);
const deadlines = unwrap(DeadlinesNs);

const {
  buildConflictFixture,
  buildLoadMatters,
  makeContact,
  makeAsset,
  makeChecklistTemplate,
  makeDistribution,
  makeLiability,
  makeTaskGroupTemplate,
  makeCounter,
  makeDeadline,
  makeDocumentHash,
  makeMatter,
  makeMatterDocument,
  makeMatterEvent,
  makeMatterNumber,
  makeMember,
  makeNote,
  makeOrg,
  makeParty,
  makePersonalTask,
  makeTask,
  makeTimeEntry,
  makeTrustSnapshot,
  makeUser,
} = F;

export const SEED_ORG_ID = 'org-harbour-vine';

/** Password for every seeded account. Emulator-only and deliberately public. */
export const SEED_PASSWORD = 'materia-local-dev';

/**
 * `default` (the practice), `minimal` (2 matters), `empty` (org and accounts only), `load`: the
 * default practice plus LOAD_MATTER_COUNT generated matters for list performance (CORE-03), and
 * `demo`: the default practice with a year and a half of history (closed matters, invoices and
 * payments for Insights), invoices on its open matters and every built feature on (seed/demo.ts).
 * `demo` is what `materia-scripts demo-reset` loads into the demo practice on dev.
 */
export type SeedScenario = 'default' | 'minimal' | 'empty' | 'load' | 'demo';
export const SEED_SCENARIOS: readonly SeedScenario[] = ['default', 'minimal', 'empty', 'load', 'demo'];

/** Extra matters in the `load` scenario. */
export const LOAD_MATTER_COUNT = 500;

/** The seeded org's matter number format (CORE-03). */
export const SEED_MATTER_NUMBER_FORMAT = 'HV-{YYYY}-{seq:4}';

export type FixtureName = 'will' | 'death-certificate' | 'court-order';

/** Facts about a fixture PDF the documents need (computed from the committed files). */
export interface FixtureInfo {
  sizeBytes: number;
  sha256: string;
  pages: number;
}

export interface SeedAccount {
  uid: string;
  email: string;
  displayName: string;
  role: D.Role;
}

export interface SeedDoc {
  path: string;
  data: Record<string, unknown>;
}

export interface SeedFile {
  storagePath: string;
  fixture: FixtureName;
}

export interface SeedDataset {
  accounts: SeedAccount[];
  docs: SeedDoc[];
  files: SeedFile[];
}

/** The test accounts, one per role (shown in AGENTS.md). */
export const SEED_ACCOUNTS: readonly SeedAccount[] = [
  { uid: 'user-priya', email: 'owner@harbourvine.example', displayName: 'Priya Shah', role: 'owner' },
  { uid: 'user-jordan', email: 'lawyer@harbourvine.example', displayName: 'Jordan Price', role: 'lawyer' },
  { uid: 'user-daniel', email: 'paralegal@harbourvine.example', displayName: 'Daniel Kim', role: 'paralegal' },
  { uid: 'user-sam', email: 'readonly@harbourvine.example', displayName: 'Sam Lee', role: 'readonly' },
];

const MEMBERS: Record<string, { title: string; rate: number; colour: string }> = {
  'user-priya': { title: 'Principal', rate: 52_000, colour: '#346CFC' },
  'user-jordan': { title: 'Senior Associate', rate: 45_000, colour: '#0E9F8E' },
  'user-daniel': { title: 'Paralegal', rate: 22_000, colour: '#D97706' },
  'user-sam': { title: 'Accounts', rate: 0, colour: '#6B7280' },
};

const PRIYA = 'user-priya';
const JORDAN = 'user-jordan';
const DANIEL = 'user-daniel';

export type ContactSpec = {
  id: string;
  given?: string;
  family?: string;
  org?: string;
  dateOfDeath?: number;
  dateOfBirth?: string;
  suburb?: string;
  tags?: string[];
  referrer?: boolean;
  /** A referrer's company and industry (CORE-18). */
  referrerMeta?: { company?: string; industry: D.ReferrerIndustry };
};

/** About 25 fictional contacts (a few of them near-duplicates). `dateOfDeath` is days before the anchor. */
const CONTACTS: ContactSpec[] = [
  {
    id: 'c-margaret-doyle',
    given: 'Margaret',
    family: 'Doyle',
    dateOfDeath: 81,
    dateOfBirth: '1944-03-02',
    suburb: 'Geelong',
  },
  { id: 'c-catherine-doyle', given: 'Catherine', family: 'Doyle', suburb: 'Newtown' },
  { id: 'c-peter-hale', given: 'Peter', family: 'Hale', suburb: 'Belmont' },
  { id: 'c-thomas-doyle', given: 'Thomas', family: 'Doyle', suburb: 'Torquay' },
  { id: 'c-linh-nguyen', given: 'Linh', family: 'Nguyen', suburb: 'Lara' },
  { id: 'c-minh-nguyen', given: 'Minh', family: 'Nguyen', suburb: 'Corio' },
  { id: 'c-hoa-nguyen', given: 'Hoa', family: 'Nguyen', dateOfDeath: 260, suburb: 'Lara' },
  { id: 'c-eileen-brennan', given: 'Eileen', family: 'Brennan', suburb: 'Ocean Grove' },
  { id: 'c-arthur-brennan', given: 'Arthur', family: 'Brennan', dateOfDeath: 140, suburb: 'Ocean Grove' },
  { id: 'c-samuel-okafor', given: 'Samuel', family: 'Okafor', dateOfDeath: 45, suburb: 'Highton' },
  { id: 'c-grace-okafor', given: 'Grace', family: 'Okafor', suburb: 'Highton' },
  { id: 'c-harriet-okafor', given: 'Harriet', family: 'Okafor', suburb: 'Grovedale' },
  { id: 'c-paul-okafor', given: 'Paul', family: 'Okafor', suburb: 'Grovedale' },
  { id: 'c-alice-whitfield', given: 'Alice', family: 'Whitfield', dateOfBirth: '1938-11-20', suburb: 'Barwon Heads' },
  { id: 'c-james-whitfield', given: 'James', family: 'Whitfield', suburb: 'Barwon Heads' },
  { id: 'c-desmond-feather', given: 'Desmond', family: 'Featherstonehaugh', dateOfDeath: 200, suburb: 'Drysdale' },
  { id: 'c-ruth-ellis', given: 'Ruth', family: 'Ellis', dateOfDeath: 610, suburb: 'Queenscliff' },
  { id: 'c-oliver-ellis', given: 'Oliver', family: 'Ellis', suburb: 'Queenscliff' },
  { id: 'c-mei-chen', given: 'Mei', family: 'Chen', suburb: 'Leopold' },
  { id: 'c-wei-chen', given: 'Wei', family: 'Chen', suburb: 'Leopold' },
  { id: 'c-kim-ho', given: 'Kim', family: 'Ho', suburb: 'Geelong', tags: ['other side'] },
  { id: 'c-rose-patel', given: 'Rose', family: 'Patel', suburb: 'Geelong', tags: ['counsel'] },
  {
    id: 'c-bay-funerals',
    org: 'Bayside Funerals Pty Ltd (fictional)',
    tags: ['supplier'],
    referrer: true,
    referrerMeta: { industry: 'funeral_director' },
  },
  { id: 'c-corio-bank', org: 'Corio Savings Bank (fictional)', tags: ['institution'] },
  {
    id: 'c-lighthouse-advisers',
    org: 'Lighthouse Financial Advisers (fictional)',
    referrer: true,
    referrerMeta: { company: 'Lighthouse Financial Advisers (fictional)', industry: 'financial_planner' },
    tags: ['referrer'],
  },
  // Near-duplicates, for trying duplicate detection and merge (CORE-01).
  { id: 'c-katherine-doyle', given: 'Katherine', family: 'Doyle', suburb: 'Newtown' },
  { id: 'c-alice-whitfield-2', given: 'Alice', family: 'Whitfeld', dateOfBirth: '1938-11-02', suburb: 'Barwon Heads' },
  { id: 'c-lighthouse-advisors', org: 'Lighthouse Financial Advisors Pty Ltd (fictional)', tags: ['referrer'] },
];

export type Offset = number;

/** A time entry: when, how long, who, what; drafts on open matters and billed on closed ones unless `entry` says. */
export type TimeSpec = [
  daysAgo: number,
  minutes: number,
  uid: string,
  narrative: string,
  entry?: { status?: D.TimeEntryStatus; billable?: boolean },
];

export interface MatterSpec {
  id: string;
  title: string;
  type: D.MatterType;
  status: D.MatterStatus;
  priority: D.Priority;
  responsible: string;
  team: string[];
  clients: string[];
  deceased?: string;
  testator?: string;
  /** Who referred the matter, or where it came from (CORE-18). */
  referrer?: string;
  referralSource?: D.ReferralSource;
  dispute?: 'family_provision' | 'will_contest';
  parties: [contactId: string, role: D.PartyRole][];
  events: [kind: D.EventKind, offset: Offset, label?: string][];
  tasks: [title: string, status: D.TaskStatus, priority: D.Priority, due: Offset | null, assignee: string][];
  deadlines: [
    title: string,
    due: Offset,
    kind: 'statutory' | 'court' | 'internal',
    critical: boolean,
    status: D.DeadlineStatus,
  ][];
  notes: string[];
  time: TimeSpec[];
  documents: FixtureName[];
  minimal?: boolean;
  /** Its deadlines also come from the engine (CORE-10), as deadlines-recompute would write them. */
  computeDeadlines?: boolean;
  /** Opened this many days before the anchor (its `createdAt`); when the seed runs if absent. */
  openedDaysAgo?: number;
  /** A closed or archived matter's closing day, in days before the anchor (30 if absent). */
  closedDaysAgo?: number;
  /** The stage and key facts when MATTER_DETAILS has none (the demo's history). */
  detail?: MatterDetailSpec;
  /** The closing record: an estate whose final distribution is recorded counts in the cycle times (INS-01). */
  closing?: { finalDistributionRecorded: boolean };
  /** Invoices billing its `billed` time (the demo, BILL-07), oldest first; see seed/demo.ts. */
  invoices?: InvoiceSpec[];
}

/**
 * An issued invoice on a seeded matter (BILL-07, BILL-08): it bills the matter's `billed` time
 * entries dated after the previous invoice's issue day up to its own, plus a fixed fee if given.
 * Payments are [days ago, method, cents]; without cents, the rest of what is owed.
 */
export interface InvoiceSpec {
  issuedDaysAgo: number;
  fixedFee?: string;
  paymentTermsDays?: number;
  paidFromTrust?: boolean;
  payments?: [daysAgo: number, method: D.PaymentMethod, cents?: number][];
}

/**
 * Each type's seeded fee (BILL-05). Estimates are fictional, in the range a Geelong firm might give
 * in a Victorian costs disclosure. The Doyle estate's was revised once, so its history shows.
 */
function seedFee(type: D.MatterType, revised?: { at: Date; by: string }): D.Matter['fee'] {
  const cents = (dollars: number) => (dollars * 100) as D.Cents;
  if (revised) {
    const from = { arrangement: 'hourly' as const, estimateCents: cents(4500) };
    const to = { arrangement: 'hourly' as const, estimateLowCents: cents(4500), estimateHighCents: cents(6500) };
    return {
      ...to,
      revision: 1,
      history: [{ ...revised, from, to, reason: 'Second executor joined; estimate given as a range' }],
    };
  }
  switch (type) {
    case 'will':
    case 'poa':
      return { arrangement: 'fixed', amountCents: cents(1650), history: [] };
    case 'trust':
      return { arrangement: 'capped', capCents: cents(5000), estimateCents: cents(4000), history: [] };
    case 'fp':
    case 'contest':
      return { arrangement: 'hourly', estimateLowCents: cents(25000), estimateHighCents: cents(40000), history: [] };
    default:
      return { arrangement: 'hourly', estimateLowCents: cents(4500), estimateHighCents: cents(6500), history: [] };
  }
}

/** Twelve matters: every type and every status. Offsets are days from the anchor. */
const MATTERS: MatterSpec[] = [
  {
    id: 'm-doyle-estate',
    title: 'Estate of Margaret Doyle',
    type: 'probate',
    status: 'open',
    referrer: 'c-bay-funerals',
    priority: 'urgent',
    responsible: JORDAN,
    team: [JORDAN, DANIEL],
    clients: ['c-catherine-doyle'],
    deceased: 'c-margaret-doyle',
    parties: [
      ['c-catherine-doyle', 'executor'],
      ['c-peter-hale', 'executor'],
      ['c-thomas-doyle', 'beneficiary'],
      ['c-margaret-doyle', 'deceased'],
    ],
    events: [
      ['date_of_death', -81],
      ['will_located', -70, 'Original will held in safe custody'],
      ['notice_published', -1, 'Probate notice published online'],
    ],
    tasks: [
      ['Publish notice of intended application', 'done', 'high', -1, DANIEL],
      ['Prepare probate summons and affidavit', 'in_progress', 'urgent', 0, JORDAN],
      ['Request date-of-death valuation for the residence', 'todo', 'medium', 5, DANIEL],
    ],
    // A manual deadline; the statutory ones are computed from the events (computeDeadlines).
    deadlines: [['Send costs disclosure update', 0, 'internal', false, 'upcoming']],
    notes: [
      'Called Catherine about the asset schedule. She will send the bank statements by Friday.',
      'Thomas has asked for a copy of the will; confirm entitlement before sending.',
    ],
    time: [
      [6, 108, JORDAN, 'Drafted probate summons and affidavit'],
      [3, 24, JORDAN, 'Emails with executor re asset schedule'],
      [1, 30, DANIEL, 'Prepared and published probate notice'],
    ],
    documents: ['will', 'death-certificate'],
    minimal: true,
    computeDeadlines: true,
  },
  {
    id: 'm-nguyen-fp',
    title: 'Nguyen v Nguyen',
    type: 'fp',
    status: 'open',
    priority: 'high',
    responsible: PRIYA,
    team: [PRIYA, JORDAN],
    clients: ['c-linh-nguyen'],
    deceased: 'c-hoa-nguyen',
    dispute: 'family_provision',
    parties: [
      ['c-linh-nguyen', 'plaintiff'],
      ['c-minh-nguyen', 'defendant'],
      ['c-kim-ho', 'other_side_solicitor'],
      ['c-rose-patel', 'counsel'],
    ],
    events: [
      ['date_of_death', -260],
      ['fp_claim_filed', -60],
      ['order_made', -21, 'Directions orders'],
      ['hearing', 38, 'Mediation'],
    ],
    tasks: [
      ['Serve the plaintiff’s affidavit on the defendant', 'todo', 'urgent', -2, JORDAN],
      ['Brief counsel for mediation', 'todo', 'high', 20, PRIYA],
    ],
    deadlines: [
      ['Serve plaintiff’s affidavit (orders, para 3)', -2, 'court', true, 'upcoming'],
      ['Mediation', 38, 'court', true, 'upcoming'],
    ],
    notes: ['Other side has proposed a consent extension of 7 days for service.'],
    time: [
      [9, 162, PRIYA, 'Conference with client re evidence'],
      [4, 66, JORDAN, 'Settled affidavit of plaintiff'],
    ],
    documents: ['court-order'],
    minimal: true,
  },
  {
    id: 'm-doyle-brennan',
    title: 'Doyle v Brennan',
    type: 'contest',
    status: 'open',
    priority: 'high',
    responsible: PRIYA,
    team: [PRIYA],
    clients: ['c-eileen-brennan'],
    deceased: 'c-arthur-brennan',
    dispute: 'will_contest',
    parties: [
      ['c-eileen-brennan', 'defendant'],
      ['c-thomas-doyle', 'plaintiff'],
      ['c-kim-ho', 'other_side_solicitor'],
    ],
    events: [
      ['date_of_death', -140],
      ['caveat_lodged', -90],
    ],
    tasks: [['Obtain the will-maker’s medical records', 'blocked', 'medium', 12, PRIYA]],
    deadlines: [['File defence', 16, 'court', true, 'upcoming']],
    notes: ['Capacity is the main issue; consider a retrospective capacity report.'],
    time: [[12, 90, PRIYA, 'Reviewed caveat and grounds']],
    documents: ['court-order'],
  },
  {
    id: 'm-okafor-loa',
    title: 'Estate of Samuel Okafor',
    type: 'loa',
    status: 'on_hold',
    priority: 'medium',
    responsible: JORDAN,
    team: [JORDAN],
    clients: ['c-grace-okafor'],
    deceased: 'c-samuel-okafor',
    parties: [
      ['c-grace-okafor', 'administrator'],
      ['c-samuel-okafor', 'deceased'],
    ],
    events: [['date_of_death', -45]],
    tasks: [['Search for a will (no will located yet)', 'in_progress', 'medium', 3, DANIEL]],
    deadlines: [['Follow up the will search', 3, 'internal', false, 'upcoming']],
    notes: ['On hold until the family confirms there is no will.'],
    time: [[20, 48, JORDAN, 'Initial conference with Grace Okafor']],
    documents: ['death-certificate'],
  },
  {
    id: 'm-okafor-wills',
    title: 'Harriet and Paul Okafor',
    type: 'will',
    status: 'lead',
    referrer: 'c-lighthouse-advisers',
    priority: 'low',
    responsible: JORDAN,
    team: [JORDAN],
    clients: ['c-harriet-okafor', 'c-paul-okafor'],
    testator: 'c-harriet-okafor',
    parties: [
      ['c-harriet-okafor', 'testator'],
      ['c-paul-okafor', 'testator'],
    ],
    events: [],
    tasks: [['Book will signing', 'todo', 'medium', 5, DANIEL]],
    deadlines: [],
    notes: ['Mirror wills with a testamentary trust for the children.'],
    time: [],
    documents: [],
  },
  {
    id: 'm-whitfield-poa',
    title: 'Alice Whitfield — enduring power of attorney',
    type: 'poa',
    status: 'open',
    referralSource: 'existing_client',
    priority: 'medium',
    responsible: JORDAN,
    team: [JORDAN],
    clients: ['c-alice-whitfield'],
    testator: 'c-alice-whitfield',
    parties: [
      ['c-alice-whitfield', 'client'],
      ['c-james-whitfield', 'attorney'],
    ],
    events: [],
    tasks: [['Arrange a second witness for signing', 'todo', 'high', 2, DANIEL]],
    deadlines: [
      ['Signing appointment', 2, 'internal', false, 'upcoming'],
      // Today (CORE-14): something of Jordan's is overdue.
      ['Return the signed enduring power of attorney', -1, 'internal', false, 'upcoming'],
    ],
    notes: [],
    time: [[2, 36, JORDAN, 'Drafted enduring power of attorney']],
    documents: [],
  },
  {
    id: 'm-feather-admin',
    title: 'Estate of Desmond Featherstonehaugh',
    type: 'admin',
    status: 'open',
    priority: 'none',
    responsible: PRIYA,
    team: [PRIYA, DANIEL],
    clients: ['c-oliver-ellis'],
    deceased: 'c-desmond-feather',
    parties: [
      ['c-oliver-ellis', 'executor'],
      ['c-desmond-feather', 'deceased'],
      ['c-bay-funerals', 'other_side_solicitor'],
    ],
    events: [
      ['date_of_death', -200],
      ['grant_issued', -60],
      ['statutory_notice_published', -45, 'Section 33 notice published'],
    ],
    tasks: [
      ['Collect proceeds of the Corio Savings Bank account', 'todo', 'medium', 14, DANIEL],
      ['Pay the funeral account', 'done', 'medium', -30, DANIEL],
    ],
    deadlines: [['Distribution not before (6 months from grant, illustrative)', 120, 'statutory', false, 'upcoming']],
    notes: ['Grant issued; collecting assets.'],
    time: [[15, 60, DANIEL, 'Letters to asset holders']],
    documents: ['will'],
  },
  {
    id: 'm-ellis-trust',
    title: 'Ellis Testamentary Trust',
    type: 'trust',
    status: 'open',
    priority: 'low',
    responsible: PRIYA,
    team: [PRIYA],
    clients: ['c-oliver-ellis'],
    parties: [['c-oliver-ellis', 'trustee']],
    events: [],
    tasks: [['Prepare annual trust distribution minutes', 'todo', 'low', 40, PRIYA]],
    deadlines: [['Trust distribution resolution (30 June, illustrative)', 60, 'internal', false, 'upcoming']],
    notes: [],
    time: [],
    documents: [],
  },
  {
    id: 'm-ellis-estate',
    title: 'Estate of Ruth Ellis',
    type: 'probate',
    status: 'closed',
    priority: 'none',
    responsible: PRIYA,
    team: [PRIYA],
    clients: ['c-oliver-ellis'],
    deceased: 'c-ruth-ellis',
    parties: [
      ['c-oliver-ellis', 'executor'],
      ['c-ruth-ellis', 'deceased'],
    ],
    events: [
      ['date_of_death', -610],
      ['notice_published', -560, 'Probate notice published online'],
      ['grant_issued', -480],
      ['statutory_notice_published', -470, 'Section 33 notice published'],
    ],
    tasks: [['Final distribution', 'done', 'medium', -200, PRIYA]],
    deadlines: [['Final distribution', -200, 'internal', false, 'done']],
    notes: ['Estate finalised and file closed.'],
    time: [],
    documents: ['will', 'death-certificate'],
  },
  {
    id: 'm-chen-wills',
    title: 'Mei and Wei Chen',
    type: 'will',
    status: 'archived',
    referrer: 'c-lighthouse-advisers',
    priority: 'none',
    responsible: JORDAN,
    team: [JORDAN],
    clients: ['c-mei-chen', 'c-wei-chen'],
    testator: 'c-mei-chen',
    parties: [
      ['c-mei-chen', 'testator'],
      ['c-wei-chen', 'testator'],
    ],
    events: [],
    tasks: [],
    deadlines: [],
    notes: [],
    time: [],
    documents: [],
  },
  {
    id: 'm-brennan-estate',
    title: 'Estate of Arthur Brennan',
    type: 'admin',
    status: 'on_hold',
    priority: 'medium',
    responsible: PRIYA,
    team: [PRIYA],
    clients: ['c-eileen-brennan'],
    deceased: 'c-arthur-brennan',
    parties: [
      ['c-eileen-brennan', 'executor'],
      ['c-arthur-brennan', 'deceased'],
    ],
    events: [['date_of_death', -140]],
    tasks: [['Await outcome of Doyle v Brennan', 'blocked', 'none', null, PRIYA]],
    deadlines: [],
    notes: ['Administration paused while the will is contested.'],
    time: [],
    documents: ['death-certificate'],
  },
  {
    id: 'm-nguyen-poa',
    title: 'Minh Nguyen — power of attorney',
    type: 'poa',
    status: 'closed',
    priority: 'none',
    responsible: JORDAN,
    team: [JORDAN],
    clients: ['c-minh-nguyen'],
    testator: 'c-minh-nguyen',
    parties: [['c-minh-nguyen', 'client']],
    events: [],
    tasks: [],
    deadlines: [],
    notes: [],
    time: [[300, 42, JORDAN, 'Signing appointment']],
    documents: [],
  },
];

/**
 * The matter screen's stage and key facts for a few matters (CORE-06), so the stepper and the key
 * facts card have content. Stages are the matter type's system template stages (CORE-07); each
 * stage's required facts and events are present. Dates are offsets from the anchor; grant and
 * court file numbers are invented.
 */
export interface MatterDetailSpec {
  stageId: string;
  willDate?: Offset;
  courtFileNo?: string;
  grantDate?: Offset;
  grantNo?: string;
  grossValueCents?: number;
}

/**
 * Disbursements (BILL-04), on open matters: [days ago, description, paid to, category, GST
 * treatment, amount in cents (fictional), entered incl. or excl. GST, status, receipt document].
 */
type DisbursementSpec = [
  daysAgo: number,
  description: string,
  payee: string,
  category: D.DisbursementCategory,
  treatment: D.GstTreatment,
  cents: number,
  entered: 'inc' | 'ex',
  status: D.DisbursementStatus,
  receiptDoc?: number,
];
const DISBURSEMENTS: Readonly<Record<string, readonly DisbursementSpec[]>> = {
  'm-doyle-estate': [
    [
      75,
      'Death certificate',
      'Births, Deaths and Marriages Victoria',
      'certificate',
      'gst_free',
      4_250,
      'inc',
      'unbilled',
      2,
    ],
    [
      2,
      'Statutory notice (s 33) advertisement',
      'Fictional Notices Pty Ltd',
      'advertising',
      'taxable',
      18_700,
      'inc',
      'unbilled',
    ],
    [10, 'Courier: original will to counsel', 'Fictional Couriers', 'courier', 'taxable', 2_750, 'inc', 'written_off'],
  ],
  'm-nguyen-fp': [[30, 'Title search', 'Fictional Titles Office', 'search', 'taxable', 2_000, 'ex', 'unbilled']],
};

/** A seeded disbursement's stored amounts. */
function seedDisbursementAmounts([, , , , treatment, cents, entered]: DisbursementSpec) {
  const amounts = domain.disbursementAmounts(
    entered === 'inc'
      ? { amountIncGstCents: cents, gstTreatment: treatment }
      : { amountExGstCents: cents, gstTreatment: treatment },
  );
  return { ...amounts, amountIncGstCents: entered === 'inc' ? cents : null };
}

const MATTER_DETAILS: Readonly<Record<string, MatterDetailSpec>> = {
  'm-doyle-estate': { stageId: 'advertisement', willDate: -2400, grossValueCents: 1_284_500_00 },
  'm-nguyen-fp': {
    stageId: 'mediation',
    willDate: -3100,
    courtFileNo: 'S ECI 2026 90417',
    grossValueCents: 2_150_000_00,
  },
  'm-doyle-brennan': { stageId: 'proceedings_filed', willDate: -400, courtFileNo: 'S ECI 2026 90233' },
  'm-okafor-loa': { stageId: 'instructions' },
  'm-okafor-wills': { stageId: 'instructions' },
  'm-whitfield-poa': { stageId: 'execution' },
  'm-feather-admin': {
    stageId: 'statutory_notice',
    grantDate: -20,
    grantNo: 'S PRB 2026 90188',
    grossValueCents: 640_250_00,
  },
  'm-ellis-trust': { stageId: 'administration' },
  'm-ellis-estate': {
    stageId: 'closed',
    willDate: -4000,
    grantDate: -480,
    grantNo: 'S PRB 2025 90051',
    grossValueCents: 915_000_00,
  },
};

/** A seeded Clerk suggestion (AI-07): what a Clerk feature proposed, with its sources. */
interface SuggestionSpec {
  kind: D.SuggestionKind;
  payload: Record<string, unknown>;
  /** Quotes of the fixture PDFs' text (AI-05 verifies them; the viewer highlights them). */
  citations: D.CitationInput[];
  rationale: string;
  privileged?: boolean;
  /** Proposed over two weeks ago and swept: shown under "Show expired". */
  expired?: boolean;
}

/** Clerk suggestions on the Overview of the Doyle estate (fictional). */
const SUGGESTIONS: Readonly<Record<string, readonly SuggestionSpec[]>> = {
  'm-doyle-estate': [
    {
      kind: 'task',
      payload: { title: 'Ask the bank for the date-of-death balance of the estate account', priority: 'medium' },
      citations: [
        {
          kind: 'document',
          documentId: 'm-doyle-estate-doc-1',
          docVersion: 1,
          page: 2,
          quote: 'I direct that my executors pay my funeral expenses and debts from my estate.',
        },
      ],
      rationale: 'The executors pay the debts from the estate and the asset schedule has no bank balance yet.',
    },
    {
      kind: 'key_fact',
      payload: { field: 'grossValue', value: 1_291_300_00 },
      citations: [
        {
          kind: 'document',
          documentId: 'm-doyle-estate-doc-1',
          docVersion: 1,
          page: 1,
          quote: 'I give my residence at 1 Example Street, Geelong to my daughter Catherine Doyle.',
        },
      ],
      rationale: 'The updated valuation of the residence adds $6,800.00 to the estate.',
    },
    {
      kind: 'note',
      payload: {
        bodyMd: 'The will makes no provision for Thomas Doyle; he is named in it, so he may ask for a copy.',
        pinned: false,
      },
      citations: [
        {
          kind: 'document',
          documentId: 'm-doyle-estate-doc-1',
          docVersion: 1,
          page: 1,
          quote: 'I make no provision for my son Thomas Doyle, for reasons he understands.',
        },
      ],
      rationale: 'Answers the open question in the file notes.',
    },
    {
      kind: 'note',
      payload: { bodyMd: 'Counsel’s view: the risk of a caveat from Peter Hale is low.', pinned: false },
      citations: [],
      rationale: 'From the privileged advice on file.',
      privileged: true,
    },
    {
      kind: 'document_meta',
      payload: { documentId: 'm-doyle-estate-doc-2', title: 'Death certificate of Margaret Doyle' },
      citations: [],
      rationale: 'A clearer title for the certificate.',
      expired: true,
    },
  ],
};

/** A seeded Clerk conversation on a matter (AI-05): a question and Clerk's cited answer. */
export interface ClerkThreadSpec {
  id: string;
  title: string;
  question: string;
  /** With `[n]` markers: `n` is the citation's position + 1. */
  answer: string;
  citations: D.CitationInput[];
}

const doyleWill = (page: number, quote: string): D.CitationInput => ({
  kind: 'document',
  documentId: 'm-doyle-estate-doc-1',
  docVersion: 1,
  page,
  quote,
});

/**
 * Clerk threads on the Doyle estate (fictional). The citations quote the will fixture; the last
 * one is a quote verification rejected (stored with `verified: false`), so its claim reads
 * "unverified". Listed in the Clerk panel (AI-06) on the matter, for its owner.
 */
const CLERK_THREADS: Readonly<Record<string, readonly ClerkThreadSpec[]>> = {
  'm-doyle-estate': [
    {
      id: 'm-doyle-estate-ct-1',
      title: 'Who benefits under the will',
      question: 'Who are the executors, and who benefits under the will?',
      answer: [
        'Catherine Doyle and Peter Hale are the executors.[1]',
        'The residence at 1 Example Street goes to Catherine[2], and so does the residue.[3]',
        'The will makes no provision for Thomas Doyle.[4]',
        'The executors pay the funeral expenses and debts from the estate.[5]',
        'The matter is at the advertisement stage.[6]',
        'Thomas was given a copy of the will in 2020.[7]',
      ].join(' '),
      citations: [
        doyleWill(1, 'I appoint my daughter Catherine Doyle and my friend Peter Hale to be the executors'),
        doyleWill(1, 'I give my residence at 1 Example Street, Geelong to my daughter Catherine Doyle.'),
        doyleWill(1, 'I give the residue of my estate to my daughter Catherine Doyle absolutely.'),
        doyleWill(1, 'I make no provision for my son Thomas Doyle, for reasons he understands.'),
        doyleWill(2, 'I direct that my executors pay my funeral expenses and debts from my estate.'),
        { kind: 'record', recordRef: { collection: 'matter', id: 'm-doyle-estate' }, quote: 'Stage: Advertisement' },
        { ...doyleWill(2, 'A copy of this will was given to Thomas in 2020.'), verified: false },
      ],
    },
  ],
};

/**
 * The estate register of the Doyle probate (CORE-16): assets in the estate adding up to its gross
 * value key fact, assets passing outside it (super under a binding nomination, a joint tenancy's
 * half), a foreign holding, liabilities and two distributions to Thomas. Values are invented.
 */
interface EstateRegisterSpec {
  assets: (Partial<D.Asset> & { id: string })[];
  liabilities: (Partial<D.Liability> & { id: string })[];
  distributions: (Omit<Partial<D.Distribution>, 'beneficiaryPartyId' | 'assetId'> & {
    id: string;
    beneficiary: string;
    asset?: string;
  })[];
}

const ESTATE_REGISTERS: Readonly<Record<string, EstateRegisterSpec>> = {
  'm-doyle-estate': {
    assets: [
      {
        id: 'residence',
        class: 'real_property',
        description: 'Residence, 14 Fictional Crescent, Belmont',
        institution: 'Volume 11234 Folio 567',
        valueAtDeathCents: 980_000_00 as D.Cents,
        valuationSource: 'Fictional Valuers Pty Ltd',
        status: 'valued',
      },
      {
        id: 'everyday',
        class: 'bank',
        description: 'Everyday account',
        institution: 'Corio Savings Bank, account ending 4471',
        valueAtDeathCents: 48_250_00 as D.Cents,
        valuationSource: 'Bank date-of-death letter',
        status: 'realised',
        realisedCents: 48_250_00 as D.Cents,
      },
      {
        id: 'term-deposit',
        class: 'bank',
        description: 'Term deposit',
        institution: 'Corio Savings Bank, deposit ending 0902',
        valueAtDeathCents: 120_000_00 as D.Cents,
        status: 'valued',
      },
      {
        id: 'mining-shares',
        class: 'shares',
        description: 'Fictional Mining Ltd, 2,000 ordinary shares',
        institution: 'SRN ending 3318',
        valueAtDeathCents: 36_250_00 as D.Cents,
        status: 'identified',
      },
      {
        id: 'us-fund',
        class: 'shares',
        description: 'US index fund units',
        institution: 'Fictional Brokerage Inc.',
        valueAtDeathCents: 70_000_00 as D.Cents,
        originalCurrency: 'USD',
        originalAmount: 46_000,
        status: 'valued',
      },
      {
        id: 'car',
        class: 'vehicle',
        description: '2019 hatchback, registration FIC-123',
        valueAtDeathCents: 18_000_00 as D.Cents,
        status: 'identified',
      },
      {
        id: 'contents',
        class: 'personal',
        description: 'Household contents and jewellery',
        valueAtDeathCents: 12_000_00 as D.Cents,
        status: 'identified',
      },
      {
        id: 'super',
        class: 'superannuation',
        description: 'Fictional Super, binding nomination to Thomas Doyle',
        valueAtDeathCents: 310_000_00 as D.Cents,
        passesOutsideEstate: true,
        status: 'identified',
      },
      {
        id: 'holiday-unit',
        class: 'real_property',
        description: 'Holiday unit, Lorne, held with Catherine Doyle',
        valueAtDeathCents: 420_000_00 as D.Cents,
        jointlyHeld: true,
        jointHolding: 'joint_tenants',
        shareBps: 5000,
        passesOutsideEstate: true,
        status: 'identified',
      },
    ],
    liabilities: [
      {
        id: 'funeral',
        class: 'funeral',
        creditor: 'Fictional Funerals',
        amountCents: 9_850_00 as D.Cents,
        status: 'paid',
      },
      {
        id: 'card',
        class: 'debt',
        creditor: 'Corio Savings Bank credit card',
        reference: 'Card ending 8812',
        amountCents: 4_120_35 as D.Cents,
        status: 'notified',
      },
      {
        id: 'tax',
        class: 'tax',
        creditor: 'Australian Taxation Office',
        reference: 'Date of death return (estimate)',
        amountCents: 6_500_00 as D.Cents,
        status: 'notified',
      },
    ],
    distributions: [
      { id: 'car-to-thomas', beneficiary: 'c-thomas-doyle', kind: 'specific', asset: 'car', status: 'planned' },
      { id: 'residue-thomas', beneficiary: 'c-thomas-doyle', kind: 'residuary', share: 'One half', status: 'planned' },
    ],
  },
};

/** A seeded register's documents and the totals `estate-onWrite` would keep on the matter. */
function seedEstateRegister(matterId: string, register: EstateRegisterSpec, meta: Record<string, unknown>) {
  const assetId = (id: string) => `${matterId}-asset-${id}`;
  const assets = register.assets.map(({ id, ...fields }) => ({
    id: assetId(id),
    data: makeAsset({ ...meta, jointlyHeld: false, passesOutsideEstate: false, ...fields }),
  }));
  const liabilities = register.liabilities.map(({ id, ...fields }) => ({
    id: `${matterId}-liability-${id}`,
    data: makeLiability({ ...meta, ...fields }),
  }));
  const distributions = register.distributions.map(({ id, beneficiary, asset, ...fields }) => ({
    id: `${matterId}-distribution-${id}`,
    data: makeDistribution({
      ...meta,
      ...fields,
      beneficiaryPartyId: domain.partyDocId('beneficiary', beneficiary),
      ...(asset ? { assetId: assetId(asset) } : {}),
    }),
  }));
  const totals = domain.estateTotals(
    assets.map((asset) => asset.data),
    liabilities.map((liability) => liability.data),
  );
  return { assets, liabilities, distributions, totals };
}

/**
 * The party rows a seeded matter gets: one client row per client (CORE-06: `clientContactIds`
 * follows the client rows), then its other parties, one row per role and contact.
 */
export function seedParties(spec: {
  clients: readonly string[];
  parties: readonly (readonly [contactId: string, role: D.PartyRole])[];
}): [contactId: string, role: D.PartyRole][] {
  const rows: [string, D.PartyRole][] = [
    ...spec.clients.map((id): [string, D.PartyRole] => [id, 'client']),
    ...spec.parties.map(([id, role]): [string, D.PartyRole] => [id, role]),
  ];
  const seen = new Set<string>();
  return rows.filter(([id, role]) => {
    const key = `${role}|${id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A seeded matter's computed deadlines (CORE-10): the Victorian rule set (its statutory rules on,
 * as the seeded org's flag says), limited to the template's rules, planned against no stored
 * deadlines; plus the tasks those rules create for the stages the matter has reached.
 */
function seedComputedDeadlines(input: {
  type: D.MatterType;
  estate: Record<string, unknown>;
  events: { id: string; kind: D.EventKind; date: D.DateOnly }[];
  template: D.Template;
  stageAt: number;
  today: D.DateOnly;
}) {
  const selection = deadlines.selectRules(deadlines.VIC_RULESET_V1, {
    statutoryEnabled: true,
    ruleIds: input.template.deadlineRuleIds.length ? input.template.deadlineRuleIds : undefined,
  });
  const filed = input.events.some((event) => event.kind === 'probate_filed' || event.kind === 'grant_issued');
  const results = deadlines.computeSafely({
    matter: {
      type: input.type,
      jurisdiction: 'VIC',
      facts: { estate: input.estate, grant: filed ? { filed: true } : {}, org: {} },
    },
    events: input.events,
    ruleSet: selection.ruleSet,
    calendars: deadlines.VIC_CALENDARS,
    localityCalendar: deadlines.LOCALITY_CALENDARS['VIC_GREATER_GEELONG'] as string,
    today: input.today,
  });
  const plan = deadlines.planRecompute({
    results,
    skipped: selection.skipped,
    existing: [],
    pending: [],
    today: input.today,
  });
  const stages = input.template.stages;
  const tasks = plan.tasks
    .filter((task) => {
      const at = task.stage ? stages.findIndex((stage) => stage.id === task.stage) : -1;
      return at < 0 || at <= input.stageAt;
    })
    .map((task) => {
      const stage = task.stage ? stages.find((s) => s.id === task.stage) : undefined;
      return {
        ...task,
        id: deadlines.linkedTaskId(task.dedupeKey),
        group: (stage as { name?: string } | undefined)?.name ?? 'Deadlines',
      };
    });
  // One task per dedupe key, linked to the first deadline that wants it (as the recompute does).
  return { creates: plan.creates, tasks: tasks.filter((task, i) => tasks.findIndex((t) => t.id === task.id) === i) };
}

const FIXTURE_FILES: Record<FixtureName, { name: string; category: D.MatterDocument['category'] }> = {
  will: { name: 'Will (fictional sample).pdf', category: 'will' },
  'death-certificate': { name: 'Death certificate (SAMPLE).pdf', category: 'death_certificate' },
  'court-order': { name: 'Orders (fictional sample).pdf', category: 'court_document' },
};

/** Builds the dataset for a scenario. Pure: the same anchor and fixtures give the same output. */
/** A task's or document's `search`, from its title or name; other documents unchanged. */
export function withSearchTokens(path: string, data: Record<string, unknown>): Record<string, unknown> {
  const collection = path.split('/').at(-2);
  if (collection === 'tasks' && typeof data['title'] === 'string') {
    return { ...data, search: domain.taskSearchTokens(data['title']) };
  }
  if (collection === 'documents' && typeof data['name'] === 'string') {
    return { ...data, search: domain.documentSearchTokens(data['name']) };
  }
  return data;
}

export function buildDataset(options: {
  scenario?: SeedScenario;
  anchor: D.DateOnly;
  fixtures: Record<FixtureName, FixtureInfo>;
  now?: Date;
}): SeedDataset {
  const scenario = options.scenario ?? 'default';
  const anchor = options.anchor;
  const rel = (days: number) => domain.addDays(anchor, days);
  const now = options.now ?? new Date(`${anchor}T00:00:00Z`);
  const meta = { createdAt: now, updatedAt: now, createdBy: PRIYA, updatedBy: PRIYA };
  const org = SEED_ORG_ID;
  const docs: SeedDoc[] = [];
  const files: SeedFile[] = [];
  // Tasks and documents carry their ⌘K tokens as `tasks-onWrite` and `documents-onWrite` would
  // write them (CORE-15), so search works without the functions emulator too.
  const add = (path: string, data: object) =>
    docs.push({ path, data: withSearchTokens(path, data as Record<string, unknown>) });

  add(
    `orgs/${org}`,
    makeOrg({
      ...meta,
      name: 'Harbour & Vine Legal',
      abn: '00000000001',
      jurisdictions: ['VIC'],
      primaryJurisdiction: 'VIC',
      timezone: 'Australia/Melbourne',
      holidayLocality: 'VIC_GREATER_GEELONG',
      matterNumberFormat: SEED_MATTER_NUMBER_FORMAT,
      security: { mfaRequired: false, sessionIdleMinutes: 60 },
      // The owner has accepted the current terms of service (SEC-01), so signing in as Priya doesn't
      // stop at the acceptance page.
      termsAcceptedVersion: domain.TERMS_VERSION,
      termsAcceptedAt: now,
      termsAcceptedBy: PRIYA,
      // The owner has acknowledged the current data-use disclosure (AI-13), so Clerk runs on the seed.
      settings: {
        clerk: {
          enabled: true,
          model: 'claude-sonnet-5-5',
          ackVersion: domain.CLERK_DISCLOSURE_VERSION,
          acknowledgedBy: 'user-priya',
          acknowledgedAt: now,
        },
      },
      // Conflict checks mark adverse roles here, so the conflict scenarios show them (CORE-02), and
      // matters follow their templates' stages and tasks (CORE-07), and the illustrative Victorian
      // statutory deadline rules apply (CORE-10), the Doyle probate has an estate register (CORE-16)
      // and Clerk's suggestions show on the Overview (AI-07), as does the fee panel (BILL-05). Trust
      // balances copied from the firm's trust records show on matters (BILL-11, ADR-035), and the
      // retention destruction queue runs (CORE-19).
      flags: {
        'conflicts.enforced': true,
        'templates.system': true,
        'deadlines.ruleset.vic.v1': true,
        'estate.register': true,
        'matters.destruction': true,
        'clerk.features.suggestions': true,
        'billing.trustDisplay': true,
        // Fee arrangements, budgets and budget alerts on the Overview (BILL-05).
        'billing.feeBudgets': true,
        // Costs disclosure tracking (BILL-06), illustrative until a practitioner signs it off (BILL-06a).
        'billing.costsDisclosure': true,
        // Disbursements and their presets (BILL-04), awaiting practitioner review (BILL-04a).
        'billing.disbursements': true,
      },
      trust: { showOnMatters: true, system: 'other', otherName: 'In-house trust records', staleAfterDays: 30 },
    }),
  );

  // The starting disbursement presets (BILL-04), as an admin's first save writes them.
  add(`orgs/${org}/settings/${domain.DISBURSEMENT_PRESETS_DOC}`, {
    ...meta,
    schemaVersion: 1,
    presets: domain.DEFAULT_DISBURSEMENT_PRESETS.map((preset) => ({ ...preset })),
  });

  // The letterhead's contact details (INT-06), as an admin saves them in Settings → Document templates.
  add(`orgs/${org}/settings/${domain.LETTERHEAD_DOC}`, {
    ...meta,
    schemaVersion: 1,
    address: 'Level 2, 10 Example Street\nGeelong VIC 3220',
    phone: '(03) 5200 0000',
    email: 'reception@harbourvine.example',
    website: 'harbourvine.example',
    footer: 'Fictional practice for demonstration only.',
  });

  for (const account of SEED_ACCOUNTS) {
    const member = MEMBERS[account.uid] as (typeof MEMBERS)[string];
    const [firstName = account.displayName, lastName = ''] = account.displayName.split(' ');
    add(
      `orgs/${org}/members/${account.uid}`,
      makeMember({
        ...meta,
        role: account.role,
        status: 'active',
        email: account.email,
        displayName: account.displayName,
        initials: `${firstName[0] ?? ''}${lastName[0] ?? ''}`,
        title: member.title,
        defaultRateCents: member.rate as D.Cents,
        rates: member.rate ? [{ effectiveFrom: domain.dateOnly('2026-07-01'), rateCents: member.rate as D.Cents }] : [],
        colour: member.colour,
        ...(account.role === 'paralegal' ? { supervisorUid: JORDAN } : {}),
      }),
    );
    add(
      `users/${account.uid}`,
      makeUser({
        ...meta,
        email: account.email,
        displayName: account.displayName,
        firstName,
        lastName,
        orgIds: [org],
        activeOrgId: org,
        memberships: { [org]: { role: account.role, name: 'Harbour & Vine Legal' } },
      }),
    );
  }

  // Global reference data (CORE-09): the calendars and the Victorian rule set the engine uses.
  const system = { createdAt: now, updatedAt: now, createdBy: 'system', updatedBy: 'system', schemaVersion: 1 };
  for (const calendar of deadlines.CALENDAR_YEARS)
    add(`calendars/${deadlines.calendarDocId(calendar)}`, { ...deadlines.toCalendarDoc(calendar), ...system });
  const ruleSet = deadlines.VIC_RULESET_V1;
  add(`ruleSets/${ruleSet.ruleSetId}/versions/${ruleSet.version}`, { ...deadlines.toRuleSetDoc(ruleSet), ...system });

  add(
    `orgs/${org}/members/${PRIYA}/tasks/pt-trust-recon`,
    makePersonalTask({
      ...meta,
      orgId: org,
      title: 'Review trust account reconciliation',
      assigneeUid: PRIYA,
      status: 'todo',
      priority: 'medium',
      dueDate: rel(2),
      order: 1,
    }),
  );

  if (scenario === 'empty') return { accounts: [...SEED_ACCOUNTS], docs, files };

  // A checklist template to apply from a task's details (CORE-08d).
  add(
    `orgs/${org}/checklistTemplates/ct-probate-kick-off`,
    makeChecklistTemplate({
      ...meta,
      name: 'Probate kick-off',
      items: [
        'Order the death certificate',
        'Locate the original will',
        'Search the will bank',
        'Ask the bank for date-of-death balances',
        'Diarise the notice of intended application',
      ],
      priority: 'high',
      dueInDays: 7,
    }),
  );
  // A task group template to add from a matter's Tasks tab (CORE-08f).
  add(
    `orgs/${org}/taskGroupTemplates/tg-estate-letters`,
    makeTaskGroupTemplate({
      ...meta,
      name: 'Estate letters',
      tasks: [
        {
          title: 'Write to the bank',
          checklist: ['Account numbers', 'Certified death certificate', 'Date-of-death balances'],
          priority: 'high',
          dueInDays: 3,
        },
        { title: 'Write to the super fund', checklist: ['Member number', 'Binding nomination'], dueInDays: 7 },
        { title: 'Notify Centrelink', checklist: [] },
      ],
    }),
  );

  const matters =
    scenario === 'minimal' ? MATTERS.filter((m) => m.minimal) : scenario === 'demo' ? demoMatters(MATTERS) : MATTERS;
  const allContacts = scenario === 'demo' ? [...CONTACTS, ...DEMO_CONTACTS] : CONTACTS;
  const contactIds = new Set(
    matters.flatMap((m) => [...m.clients, ...m.parties.map(([id]) => id), ...(m.deceased ? [m.deceased] : [])]),
  );
  const contacts = scenario === 'minimal' ? CONTACTS.filter((c) => contactIds.has(c.id)) : allContacts;
  // Two matters' trust balances, as copied from those records: one current, one out of date.
  for (const [matterId, amountCents, daysAgo] of [
    ['m-doyle-estate', 8_421_000, 3],
    ['m-feather-admin', 500_000, 38],
  ] as const) {
    if (!matters.some((m) => m.id === matterId)) continue;
    add(
      `orgs/${org}/trustSnapshots/${matterId}`,
      makeTrustSnapshot({
        ...meta,
        matterId,
        amountCents: amountCents as D.Cents,
        asAt: rel(-daysAgo),
        source: 'manual',
        sourceSystemName: 'In-house trust records',
        recordedBy: PRIYA,
        recordedAt: now,
      }),
    );
  }

  const contactById = new Map(allContacts.map((c) => [c.id, c]));
  const nameOf = (id: string) => {
    const c = contactById.get(id);
    return c ? domain.contactDisplayName({ givenNames: c.given, familyName: c.family, orgName: c.org }) : undefined;
  };
  // Numbers as matters-createMatter allocates them: this year (in Melbourne) from 1, reserved, with
  // the counter past them so new matters don't collide.
  const year = domain.matterNumberYear(now, 'Australia/Melbourne');
  const HOUR = 3_600_000;
  // Numbered in the year each matter opened: this year, unless its spec says when it opened.
  const seqs = new Map<number, number>([[year, 1]]);
  const takeSeq = (y: number) => {
    const seq = seqs.get(y) ?? 1;
    seqs.set(y, seq + 1);
    return seq;
  };
  /** An instant on the day `days` before the anchor (mid-morning in Melbourne). */
  const daysAgoAt = (days: number) => new Date(`${rel(-days)}T00:00:00Z`);

  for (const spec of contacts) {
    const person = !spec.org;
    add(
      `orgs/${org}/contacts/${spec.id}`,
      makeContact({
        ...meta,
        kind: person ? 'person' : 'organisation',
        givenNames: spec.given,
        familyName: spec.family,
        orgName: spec.org,
        dateOfBirth: spec.dateOfBirth ? domain.dateOnly(spec.dateOfBirth) : undefined,
        dateOfDeath: spec.dateOfDeath === undefined ? undefined : rel(-spec.dateOfDeath),
        emails: person && !spec.dateOfDeath ? [{ type: 'personal', address: `${spec.id.slice(2)}@example.com` }] : [],
        phones: spec.dateOfDeath
          ? []
          : [
              {
                type: person ? 'mobile' : 'work',
                number: `+6140000${String(contacts.indexOf(spec)).padStart(4, '0')}`,
              },
            ],
        addresses: [
          {
            type: person ? 'residential' : 'business',
            line1: `${10 + contacts.indexOf(spec)} Example Street`,
            suburb: spec.suburb ?? 'Geelong',
            state: 'VIC',
            postcode: '3220',
            country: 'AU',
          },
        ],
        tags: spec.tags ?? [],
        isReferrer: spec.referrer ?? false,
        referrerMeta: spec.referrerMeta,
        ...domain.contactDerivedFields({
          kind: person ? 'person' : 'organisation',
          givenNames: spec.given,
          familyName: spec.family,
          orgName: spec.org,
          dateOfBirth: spec.dateOfBirth ? domain.dateOnly(spec.dateOfBirth) : undefined,
        }),
      }),
    );
  }

  const openedAtOf = (spec: MatterSpec) => (spec.openedDaysAgo === undefined ? now : daysAgoAt(spec.openedDaysAgo));
  // Numbered in the order they opened, as the counter would have handed the numbers out.
  const numbers = new Map<string, string>();
  matters
    .map((spec, index) => ({ spec, index, at: openedAtOf(spec).getTime() }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .forEach(({ spec }) => {
      const y = domain.matterNumberYear(openedAtOf(spec), 'Australia/Melbourne');
      numbers.set(spec.id, domain.formatMatterNumber(SEED_MATTER_NUMBER_FORMAT, y, takeSeq(y)));
    });

  matters.forEach((spec, index) => {
    const base = `orgs/${org}/matters/${spec.id}`;
    const openedAt = openedAtOf(spec);
    const openedYear = domain.matterNumberYear(openedAt, 'Australia/Melbourne');
    const number = numbers.get(spec.id) as string;
    const deceased = spec.deceased ? contactById.get(spec.deceased) : undefined;
    const openTasks = spec.tasks.filter(([, status]) => status !== 'done' && status !== 'cancelled');
    const staticDeadlines = spec.deadlines.map(([title, due, kind, critical, status], i) => ({
      id: `${spec.id}-dl-${i + 1}`,
      title,
      dueDate: rel(due),
      kind,
      critical,
      status,
    }));
    const closed = spec.status === 'closed' || spec.status === 'archived';
    const closedAt = closed
      ? spec.closedDaysAgo === undefined
        ? new Date(now.getTime() - 30 * 86_400_000)
        : daysAgoAt(spec.closedDaysAgo)
      : undefined;
    // Time entries: drafts on open matters, billed on closed ones, unless the spec says otherwise.
    // Unbilled billable time is work in progress (BILL-01).
    const timeEntries = spec.time.map(([daysAgo, minutes, uid, narrative, entry]) => {
      const units = Math.ceil(minutes / 6);
      const rate = MEMBERS[uid]?.rate ?? 0;
      const status: D.TimeEntryStatus = entry?.status ?? (closed ? 'billed' : 'draft');
      const billable = entry?.billable ?? true;
      const amount = domain.timeAmountCents(units, rate);
      return { daysAgo, minutes, uid, narrative, units, rate, amount, status, billable };
    });
    const wip = timeEntries.reduce(
      (sum, { billable, status, amount }) => sum + domain.wipContribution({ billable, status, amountCents: amount }),
      0,
    );
    // The fee (BILL-05): fixed for wills and powers of attorney, a cap on the trust, hourly with a
    // Victorian-style estimate range elsewhere. The budget is what the fees triggers would compute.
    const fee = seedFee(spec.type, spec.id === 'm-doyle-estate' ? { at: now, by: JORDAN } : undefined);
    const recorded = timeEntries.reduce((sum, entry) => sum + entry.amount, 0);
    const billed = timeEntries.reduce((sum, entry) => sum + (entry.status === 'billed' ? entry.amount : 0), 0);
    const budget = domain.planBudget({
      fee,
      previous: null,
      sums: { timeCents: recorded, disbursementsCents: 0, billedCents: billed },
      pcts: domain.DEFAULT_BUDGET_ALERT_PCTS,
      alertsOn: false,
    }).budget;
    const detail = MATTER_DETAILS[spec.id] ?? spec.detail;
    const registerSpec = ESTATE_REGISTERS[spec.id];
    const register = registerSpec ? seedEstateRegister(spec.id, registerSpec, meta) : null;
    const estateFacts =
      detail && (detail.grantDate !== undefined || detail.grantNo || detail.grossValueCents !== undefined)
        ? {
            ...(detail.grantDate !== undefined ? { grantDate: rel(detail.grantDate) } : {}),
            ...(detail.grantNo ? { grantNo: detail.grantNo } : {}),
            ...(detail.grossValueCents !== undefined ? { grossValueCents: detail.grossValueCents as D.Cents } : {}),
          }
        : undefined;
    // A matter with an estate register (CORE-16) carries the values estate-onWrite keeps.
    const estate = register
      ? { ...estateFacts, grossValueCents: register.totals.grossCents, netValueCents: register.totals.netCents }
      : estateFacts;
    const facts =
      detail && (detail.willDate !== undefined || detail.courtFileNo)
        ? {
            ...(detail.willDate !== undefined ? { willDate: rel(detail.willDate) } : {}),
            ...(detail.courtFileNo ? { courtFileNo: detail.courtFileNo } : {}),
          }
        : undefined;

    // The type's system template (CORE-07): the matter's stage, and the template tasks of every
    // stage up to it (earlier stages' done; all done once the matter is closed).
    const template = domain.systemTemplate(domain.systemTemplateId(spec.type)) as D.Template;
    const stageId = detail?.stageId ?? (template.stages[0]?.id as string);
    const stageAt = template.stages.findIndex((stage) => stage.id === stageId);
    const stageEnteredOn = closed && spec.closedDaysAgo !== undefined ? rel(-spec.closedDaysAgo) : rel(-7);
    const anchors: D.AnchorContext = {
      matter: {
        ...(deceased && deceased.dateOfDeath !== undefined
          ? {
              deceased: {
                contactId: deceased.id,
                dateOfDeath: rel(-deceased.dateOfDeath),
                domicile: 'VIC',
                lastAddress: '',
              },
            }
          : {}),
        ...(estate ? { estate } : {}),
      },
      events: spec.events.map(([kind, offset]) => ({ kind, date: rel(offset) })),
    };
    const templateTasks = template.tasks
      .filter((task) => template.stages.findIndex((stage) => stage.id === task.stageId) <= stageAt)
      .map((task) => {
        const done = closed || task.stageId !== stageId;
        return {
          id: domain.templateTaskDocId(task.key),
          done,
          fields: domain.templateTaskFields(template, task, anchors, {
            stageEnteredOn,
            responsibleUid: spec.responsible,
            paralegalUid: DANIEL,
          }),
        };
      });
    const openTemplateTasks = templateTasks.filter((task) => !task.done).length;

    // CORE-10: the engine's deadlines from the matter's events and its template's rules, planned as
    // deadlines-recompute plans them (a recompute of the seeded matter finds nothing to change),
    // with the tasks their rules create once the matter has reached the rule's stage.
    const engine = spec.computeDeadlines
      ? seedComputedDeadlines({
          type: spec.type,
          estate: estate ?? {},
          events: spec.events.map(([kind, offset], i) => ({ id: `${spec.id}-ev-${i + 1}`, kind, date: rel(offset) })),
          template,
          stageAt,
          today: anchor,
        })
      : { creates: [], tasks: [] };
    const next = domain.nextDeadlineOf([
      ...staticDeadlines,
      ...engine.creates.map((create) => ({ id: create.id, ...create.fields })),
    ]);

    add(`orgs/${org}/matterNumbers/${domain.matterNumberKey(number)}`, {
      ...makeMatterNumber({ ...meta, number, matterId: spec.id, year: openedYear }),
    });
    const matterData = {
      ...makeMatter({
        ...meta,
        createdAt: openedAt,
        number,
        title: spec.title,
        type: spec.type,
        status: spec.status,
        priority: spec.priority,
        jurisdiction: 'VIC',
        responsibleUid: spec.responsible,
        teamUids: spec.team,
        stageId,
        stageEnteredOn,
        templateId: template.id,
        templateVersion: template.version,
        estate,
        ...(register ? { estateRegister: { ...register.totals, updatedAt: now } } : {}),
        facts,
        clientContactIds: spec.clients,
        deceased:
          deceased && deceased.dateOfDeath !== undefined
            ? {
                contactId: deceased.id,
                dateOfDeath: rel(-deceased.dateOfDeath),
                domicile: 'VIC',
                lastAddress: `${deceased.suburb ?? 'Geelong'} VIC`,
              }
            : undefined,
        testator: spec.testator ? { contactId: spec.testator } : undefined,
        referrerContactId: spec.referrer,
        referralSource: spec.referralSource,
        dispute: spec.dispute ? { kind: spec.dispute, proceedingIds: [] } : undefined,
        fee,
        budget,
        costsDisclosure: {
          status: spec.type === 'will' ? 'not_required' : 'sent',
          ...(spec.type === 'will'
            ? {}
            : { sentOn: spec.openedDaysAgo === undefined ? rel(-30) : rel(-Math.max(0, spec.openedDaysAgo - 2)) }),
        },
        conflictCheck: { status: spec.status === 'lead' ? 'pending' : 'clear' },
        // The clients' names as matters-denormalise keeps them (SEC-07d), for the Matters list.
        clientNames: spec.clients.map(nameOf).filter((name): name is string => !!name),
        search: domain.matterSearchTokens({
          number,
          title: spec.title,
          clientNames: spec.clients.map(nameOf).filter((name): name is string => !!name),
          ...(spec.deceased && nameOf(spec.deceased) ? { deceasedName: nameOf(spec.deceased) as string } : {}),
        }),
        nextDeadline: next,
        openTaskCount: openTasks.length + openTemplateTasks + engine.tasks.length,
        recomputeVersion: spec.computeDeadlines ? 1 : 0,
        wipCents: wip as D.Cents,
        disbursementWipCents: (DISBURSEMENTS[spec.id] ?? []).reduce(
          (sum, item) => sum + (item[7] === 'unbilled' ? seedDisbursementAmounts(item).amountExGstCents : 0),
          0,
        ) as D.Cents,
        // Most recent first in the order above, a few hours apart.
        lastActivityAt: new Date(now.getTime() - index * 5 * HOUR),
        closedAt,
        ...(spec.closing
          ? { closing: { closingLetterSent: true, ...spec.closing, tasksCancelled: 0, holds: [] } }
          : {}),
        closeReason: closed ? 'Matter completed' : undefined,
        labels: spec.priority === 'urgent' ? ['urgent'] : [],
      }),
      // Live matters carry deletedAt: null (the Matters list filters on it).
      deletedAt: null,
    };
    add(base, matterData);

    for (const [contactId, role] of seedParties(spec)) {
      add(
        `${base}/parties/${domain.partyDocId(role, contactId)}`,
        makeParty({ ...meta, orgId: org, matterId: spec.id, contactId, role }),
      );
    }
    if (register) {
      for (const asset of register.assets) add(`${base}/assets/${asset.id}`, asset.data);
      for (const liability of register.liabilities) add(`${base}/liabilities/${liability.id}`, liability.data);
      for (const distribution of register.distributions)
        add(`${base}/distributions/${distribution.id}`, distribution.data);
    }
    spec.events.forEach(([kind, offset, label], i) =>
      add(
        `${base}/events/${spec.id}-ev-${i + 1}`,
        makeMatterEvent({
          ...meta,
          kind,
          date: rel(offset),
          ...(label ? { label } : {}),
          // A copy of the matter's flag, as every writer keeps it (CORE-10b).
          privileged: matterData.privileged,
        }),
      ),
    );
    // Each task's copy of its matter (SEC-07e), as tasks-onWrite fills it.
    const taskCopy = domain.taskMatterCopy(matterData) ?? undefined;
    spec.tasks.forEach(([title, status, priority, due, assignee], i) =>
      add(
        `${base}/tasks/${spec.id}-t-${i + 1}`,
        makeTask({
          ...meta,
          orgId: org,
          matterId: spec.id,
          matter: taskCopy,
          title,
          status,
          priority,
          assigneeUid: assignee,
          dueDate: due === null ? undefined : rel(due),
          order: i + 1,
          completedAt: status === 'done' ? now : undefined,
          // Counted in the matter's openTaskCount above, so tasks-onWrite leaves them alone (CORE-08).
          countedOpen: status !== 'done' && status !== 'cancelled',
        }),
      ),
    );
    for (const task of templateTasks) {
      add(
        `${base}/tasks/${task.id}`,
        makeTask({
          ...meta,
          ...task.fields,
          // No anchor yet: no due date (the factory's default would otherwise stand).
          dueDate: task.fields.dueDate,
          orgId: org,
          matterId: spec.id,
          ...(task.done ? { status: 'done' as const, completedAt: closedAt ?? now } : {}),
          countedOpen: !task.done,
          matter: taskCopy,
        }),
      );
    }
    // Each deadline's copy of its matter (SEC-07c), as the deadline writers stamp it.
    const matterCopy = domain.deadlineMatterCopy(matterData) ?? undefined;
    spec.deadlines.forEach(([title, due, kind, critical, status], i) =>
      add(
        `${base}/deadlines/${spec.id}-dl-${i + 1}`,
        makeDeadline({
          ...meta,
          orgId: org,
          matterId: spec.id,
          title,
          dueDate: rel(due),
          kind,
          critical,
          status,
          assigneeUid: spec.responsible,
          // Manual (no rule): entered by the firm, or illustrative on matters the engine doesn't seed.
          computed: undefined,
          reminders: [{ offsetDays: -7 }, { offsetDays: -1 }],
          pastOnCreation: false,
          privileged: matterData.privileged,
          matter: matterCopy,
        }),
      ),
    );
    for (const { id, fields } of engine.creates) {
      const task = engine.tasks.find((t) => t.deadlineId === id);
      add(
        `${base}/deadlines/${id}`,
        makeDeadline({
          ...meta,
          ...fields,
          dueDate: fields.dueDate,
          orgId: org,
          matterId: spec.id,
          assigneeUid: spec.responsible,
          ...(task ? { taskId: task.id } : {}),
          privileged: matterData.privileged,
          matter: matterCopy,
        }),
      );
    }
    for (const task of engine.tasks) {
      add(
        `${base}/tasks/${task.id}`,
        makeTask({
          ...meta,
          orgId: org,
          matterId: spec.id,
          title: task.title,
          status: 'todo',
          priority: task.critical ? 'high' : 'medium',
          assigneeUid: spec.responsible,
          dueDate: task.dueDate,
          deadlineId: task.deadlineId,
          group: task.group,
          order: 1_000_000,
          source: 'rule',
          countedOpen: true,
          matter: taskCopy,
        }),
      );
    }
    spec.notes.forEach((body, i) =>
      add(
        `${base}/notes/${spec.id}-n-${i + 1}`,
        makeNote({ ...meta, bodyMd: body, mentions: { uids: [], matterIds: [] }, pinned: i === 0 }),
      ),
    );
    timeEntries.forEach(({ daysAgo, minutes, uid, narrative, units, rate, amount, status, billable }, i) => {
      add(
        `${base}/timeEntries/${spec.id}-te-${i + 1}`,
        makeTimeEntry({
          ...meta,
          orgId: org,
          matterId: spec.id,
          uid,
          date: rel(-daysAgo),
          minutes: minutes as D.Minutes,
          units,
          rateCents: rate as D.Cents,
          amountCents: amount as D.Cents,
          narrative,
          billable,
          status,
          source: 'manual',
          // Counted into the matter's wipCents above, so time-onWrite doesn't count it again.
          wipCountedCents: domain.wipContribution({ billable, status, amountCents: amount }) as D.Cents,
        }),
      );
    });
    const documents: Record<string, Record<string, unknown>> = {};
    spec.documents.forEach((fixture, i) => {
      const id = `${spec.id}-doc-${i + 1}`;
      const storagePath = `${base}/documents/${id}/v1`;
      const info = options.fixtures[fixture];
      documents[id] = makeMatterDocument({
        ...meta,
        orgId: org,
        matterId: spec.id,
        name: FIXTURE_FILES[fixture].name,
        storagePath,
        mime: 'application/pdf',
        sizeBytes: info.sizeBytes,
        sha256: info.sha256,
        version: 1,
        versionSeq: 1,
        versions: [
          {
            version: 1,
            storagePath,
            fileName: FIXTURE_FILES[fixture].name,
            mime: 'application/pdf',
            sizeBytes: info.sizeBytes,
            sha256: info.sha256,
            uploadedAt: now,
            uploadedBy: PRIYA,
            pageCount: info.pages,
          },
        ],
        category: FIXTURE_FILES[fixture].category,
        scan: { status: 'clean' },
        // Clerk ingestion (AI-04) picks these up when the functions emulator runs: the
        // documents-onIngestChange trigger queues them as the seed writes them.
        ingest: { status: 'pending' },
        pageCount: info.pages,
        source: 'upload',
      });
      add(`${base}/documents/${id}`, documents[id]);
      // The duplicate check's hash index (CORE-12): uploading the same file again flags it.
      add(`${base}/documentHashes/${info.sha256}`, makeDocumentHash({ ...meta, documentId: id }));
      files.push({ storagePath, fixture });
    });

    (DISBURSEMENTS[spec.id] ?? []).forEach((item, i) => {
      const [daysAgo, description, payee, category, gstTreatment, , , status, receiptDoc] = item;
      const amounts = seedDisbursementAmounts(item);
      add(
        `${base}/disbursements/${spec.id}-db-${i + 1}`,
        F.makeDisbursement({
          ...meta,
          orgId: org,
          matterId: spec.id,
          date: rel(-daysAgo),
          description,
          payee,
          category,
          gstTreatment,
          amountExGstCents: amounts.amountExGstCents as D.Cents,
          gstCents: amounts.gstCents as D.Cents,
          amountIncGstCents: amounts.amountIncGstCents as D.Cents | null,
          receiptDocumentId: receiptDoc ? `${spec.id}-doc-${receiptDoc}` : null,
          status,
          // Counted into the matter's disbursementWipCents above, so disbursements-onWrite doesn't count it again.
          wipCountedCents: (status === 'unbilled' ? amounts.amountExGstCents : 0) as D.Cents,
        }),
      );
    });

    // Clerk suggestions (AI-07), stored as proposeSuggestions writes them: the basis is the one the
    // server computes from this matter and its documents, so accepting one applies it.
    for (const [i, proposal] of (SUGGESTIONS[spec.id] ?? []).entries()) {
      const { basis, parts } = domain.suggestionBasis(
        domain.suggestionBasisParts(proposal, { matter: matterData, documents }),
      );
      const expired = proposal.expired === true;
      add(
        `${base}/suggestions/${spec.id}-sg-${i + 1}`,
        F.makeSuggestion({
          ...meta,
          createdBy: 'clerk',
          updatedBy: 'clerk',
          orgId: org,
          matterId: spec.id,
          kind: proposal.kind,
          payload: proposal.payload,
          citations: proposal.citations,
          rationale: proposal.rationale,
          status: expired ? 'expired' : 'proposed',
          promptId: 'suggest-matter',
          promptVersion: '1.0.0',
          model: 'claude-sonnet-5-5',
          privileged: proposal.privileged ?? false,
          basis,
          basisParts: parts,
          dedupeKey: domain.defaultDedupeKey({ kind: proposal.kind, payload: proposal.payload } as D.SuggestionPayload),
          expiresAt: new Date(now.getTime() + (expired ? -2 : domain.SUGGESTION_TTL_DAYS) * 86_400_000),
          ...(expired ? { resolvedBy: 'system', resolvedAt: now } : {}),
        } as Partial<D.Suggestion>),
      );
    }
  });

  // Clerk threads (AI-05): a question and Clerk's cited answer, stored as the gateway writes them.
  const clerkThreads = scenario === 'demo' ? { ...CLERK_THREADS, ...DEMO_CLERK_THREADS } : CLERK_THREADS;
  for (const [matterId, threads] of Object.entries(clerkThreads)) {
    if (!matters.some((m) => m.id === matterId)) continue;
    for (const [i, thread] of threads.entries()) {
      const at = (minutes: number) => new Date(now.getTime() - (threads.length - i) * 86_400_000 + minutes * 60_000);
      const threadPath = `orgs/${org}/clerkThreads/${thread.id}`;
      add(
        threadPath,
        F.makeClerkThread({
          ...meta,
          title: thread.title,
          ownerUid: PRIYA,
          matterId,
          shared: false,
          lastMessageAt: at(1),
        } as Partial<D.ClerkThread>),
      );
      add(
        `${threadPath}/messages/${thread.id}-m-1`,
        F.makeClerkMessage({
          ...meta,
          createdAt: at(0),
          updatedAt: at(0),
          role: 'user',
          content: [{ type: 'text', text: thread.question }],
          status: 'done',
        } as Partial<D.ClerkMessage>),
      );
      add(
        `${threadPath}/messages/${thread.id}-m-2`,
        F.makeClerkMessage({
          ...meta,
          createdAt: at(1),
          updatedAt: at(1),
          createdBy: 'clerk',
          updatedBy: 'clerk',
          role: 'assistant',
          content: [{ type: 'text', text: thread.answer }],
          replyTo: `${thread.id}-m-1`,
          citations: thread.citations,
          status: 'done',
          promptId: 'chat-answer@1.0.0',
          model: 'claude-sonnet-5-5',
          privileged: false,
          usage: { inputTokens: 2400, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 },
        } as Partial<D.ClerkMessage>),
      );
    }
  }

  // The will safe custody register (CORE-17): held, out, released, and a deceased testator's will.
  if (scenario !== 'minimal') {
    const packets: {
      testator: string;
      matterId?: string;
      items: D.SafeCustodyItem[];
      slot: string;
      cabinet?: string;
      receivedDaysAgo: number;
      status?: 'out' | 'released';
      verifiedDaysAgo?: number;
      authority?: D.MatterDocumentRef;
    }[] = [
      {
        testator: 'c-harriet-okafor',
        matterId: 'm-okafor-wills',
        items: [
          { kind: 'will', date: rel(-30), description: 'Last will' },
          { kind: 'poa', date: rel(-30), description: 'Enduring power of attorney' },
        ],
        slot: '1',
        receivedDaysAgo: 28,
      },
      {
        testator: 'c-alice-whitfield',
        matterId: 'm-whitfield-poa',
        items: [
          { kind: 'will', date: domain.dateOnly('2012-05-09'), description: '' },
          { kind: 'codicil', date: domain.dateOnly('2019-08-21'), description: 'Changes the executor' },
          { kind: 'eg', date: domain.dateOnly('2019-08-21'), description: '' },
        ],
        slot: '2',
        receivedDaysAgo: 4000,
        verifiedDaysAgo: 300,
      },
      {
        testator: 'c-mei-chen',
        matterId: 'm-chen-wills',
        items: [{ kind: 'will', date: rel(-400), description: '' }],
        slot: '12',
        receivedDaysAgo: 398,
        status: 'out',
      },
      {
        testator: 'c-margaret-doyle',
        items: [{ kind: 'will', date: domain.dateOnly('2016-11-03'), description: 'Last will' }],
        cabinet: 'Strongroom',
        slot: 'B4',
        receivedDaysAgo: 3200,
      },
      {
        testator: 'c-ruth-ellis',
        items: [{ kind: 'will', date: domain.dateOnly('2011-02-17'), description: '' }],
        cabinet: 'Strongroom',
        slot: 'A1',
        receivedDaysAgo: 4500,
        status: 'released',
        authority: { matterId: 'm-ellis-estate', documentId: 'm-ellis-estate-doc-2' },
      },
    ];
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
    packets.forEach((spec, i) => {
      const packetNo = domain.formatPacketNo(i + 1);
      const testatorName = nameOf(spec.testator) ?? '';
      const location = { site: 'Geelong', cabinet: spec.cabinet ?? 'Safe A', slot: spec.slot };
      const movements: D.SafeCustodyMovement[] = [
        { at: ago(spec.receivedDaysAgo), by: DANIEL, kind: 'in', reason: 'Received into safe custody', location },
      ];
      if (spec.status === 'out') {
        movements.push({ at: ago(3), by: JORDAN, kind: 'out', reason: 'Signing a new will', to: 'Jordan Price' });
      }
      if (spec.status === 'released') {
        movements.push({
          at: ago(500),
          by: JORDAN,
          kind: 'released',
          reason: 'Executor’s request after death',
          to: 'Oliver Ellis, executor',
          toContactId: 'c-oliver-ellis',
          ...(spec.authority ? { authority: spec.authority } : {}),
        });
      }
      add(
        `orgs/${org}/safeCustody/sc-seed-${i + 1}`,
        F.makeSafeCustody({
          ...meta,
          packetNo,
          testatorContactId: spec.testator,
          testatorName,
          responsibleUid: JORDAN,
          ...(spec.matterId ? { matterId: spec.matterId } : {}),
          items: spec.items,
          location,
          receivedOn: domain.addDays(anchor, -spec.receivedDaysAgo),
          status: spec.status ?? 'held',
          movements,
          pendingDestruction: null,
          ...(spec.verifiedDaysAgo
            ? { lastVerified: { on: domain.addDays(anchor, -spec.verifiedDaysAgo), by: DANIEL } }
            : {}),
          search: domain.packetSearchTokens(packetNo, testatorName, location),
          locationKey: domain.locationKey(location),
        }),
      );
    });
    add(`orgs/${org}/counters/${domain.SAFE_CUSTODY_COUNTER}`, makeCounter({ ...meta, next: packets.length + 1 }));
  }

  // Conflict-check scenarios (CORE-02): 5 adverse and 5 benign, with their own contacts and matters.
  if (scenario !== 'minimal') {
    const conflicts = buildConflictFixture({
      orgId: org,
      uid: JORDAN,
      now,
      format: SEED_MATTER_NUMBER_FORMAT,
      year,
      firstSeq: seqs.get(year) ?? 1,
    });
    for (const doc of conflicts.docs) {
      // The demo spreads their opening over the past months, so Insights doesn't count them all in one.
      const dates = scenario === 'demo' ? DEMO_CONFLICT_DATES[doc.path.split('/')[3] ?? ''] : undefined;
      if (dates && doc.path.split('/').length === 4 && doc.path.split('/')[2] === 'matters') {
        const openedAt = daysAgoAt(dates.opened);
        add(doc.path, {
          ...doc.data,
          createdAt: openedAt,
          updatedAt: openedAt,
          ...(doc.data['closedAt'] && dates.closed !== undefined ? { closedAt: daysAgoAt(dates.closed) } : {}),
        });
      } else add(doc.path, doc.data);
    }
    seqs.set(year, conflicts.nextSeq);
  }

  if (scenario === 'load') {
    const load = buildLoadMatters({
      orgId: org,
      count: LOAD_MATTER_COUNT,
      now,
      format: SEED_MATTER_NUMBER_FORMAT,
      year,
      firstSeq: seqs.get(year) ?? 1,
      uids: [PRIYA, JORDAN, DANIEL],
      clientContactIds: contacts.filter((c) => !c.org && c.dateOfDeath === undefined).map((c) => c.id),
      contactNames: Object.fromEntries(contacts.map((c) => [c.id, nameOf(c.id) ?? ''])),
    });
    for (const doc of [...load.matters, ...load.reservations]) add(doc.path, doc.data);
    seqs.set(year, load.nextSeq);
  }
  for (const [y, next] of [...seqs].sort(([a], [b]) => a - b)) {
    add(`orgs/${org}/counters/${domain.matterCounterId(y)}`, makeCounter({ ...meta, next }));
  }

  const all = scenario === 'demo' ? applyDemo(docs, { orgId: org, anchor, now, matters }) : docs;
  return { accounts: [...SEED_ACCOUNTS], docs: withMatterRoles(all), files };
}

/**
 * Gives each contact the `matterRoles` `contacts-onPartyWrite` would (CORE-01a): the roles of its
 * live party rows on live matters in the dataset, so the "Role in matters" filter works without
 * the functions emulator too.
 */
export function withMatterRoles(docs: SeedDoc[]): SeedDoc[] {
  const byPath = new Map(docs.map((doc) => [doc.path, doc.data as Record<string, unknown>]));
  const rows = new Map<string, D.PartyRoleRow[]>();
  for (const { path, data } of docs) {
    const [, orgId, matters, matterId, parties] = path.split('/');
    if (matters !== 'matters' || parties !== 'parties' || path.split('/').length !== 6) continue;
    const party = data as Record<string, unknown>;
    const key = `orgs/${orgId}/contacts/${String(party['contactId'])}`;
    rows.set(key, [
      ...(rows.get(key) ?? []),
      { role: party['role'], matterId: matterId as string, deletedAt: party['deletedAt'] },
    ]);
  }
  return docs.map((doc) => {
    const [, orgId, contacts] = doc.path.split('/');
    if (contacts !== 'contacts' || doc.path.split('/').length !== 4) return doc;
    const matterRoles = domain.contactMatterRoles(rows.get(doc.path) ?? [], (matterId) =>
      domain.matterCountsForRoles(byPath.get(`orgs/${orgId}/matters/${matterId}`)),
    );
    return { ...doc, data: { ...doc.data, matterRoles } };
  });
}

/** Removes `undefined` values (optional fields the factories leave unset) before writing. */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, stripUndefined(v)]),
    ) as T;
  }
  return value;
}
