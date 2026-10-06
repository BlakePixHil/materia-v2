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

import { unwrap } from './interop.ts';

const domain = unwrap(D);
const F = unwrap(TestUtilsNs);
const deadlines = unwrap(DeadlinesNs);

const {
  buildConflictFixture,
  buildLoadMatters,
  makeContact,
  makeChecklistTemplate,
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
  makeUser,
} = F;

export const SEED_ORG_ID = 'org-harbour-vine';

/** Password for every seeded account. Emulator-only and deliberately public. */
export const SEED_PASSWORD = 'materia-local-dev';

/**
 * `default` (the practice), `minimal` (2 matters), `empty` (org and accounts only), and `load`:
 * the default practice plus LOAD_MATTER_COUNT generated matters for list performance (CORE-03).
 */
export type SeedScenario = 'default' | 'minimal' | 'empty' | 'load';
export const SEED_SCENARIOS: readonly SeedScenario[] = ['default', 'minimal', 'empty', 'load'];

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

type ContactSpec = {
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

type Offset = number;

interface MatterSpec {
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
  time: [daysAgo: number, minutes: number, uid: string, narrative: string][];
  documents: FixtureName[];
  minimal?: boolean;
  /** Its deadlines also come from the engine (CORE-10), as deadlines-recompute would write them. */
  computeDeadlines?: boolean;
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
interface MatterDetailSpec {
  stageId: string;
  willDate?: Offset;
  courtFileNo?: string;
  grantDate?: Offset;
  grantNo?: string;
  grossValueCents?: number;
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
  citations: { documentId: string; page?: number; quote: string }[];
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
      citations: [{ documentId: 'm-doyle-estate-doc-1', page: 1, quote: 'my accounts with any bank' }],
      rationale: 'The will deals with bank accounts and the asset schedule has no balance yet.',
    },
    {
      kind: 'key_fact',
      payload: { field: 'grossValue', value: 1_291_300_00 },
      citations: [{ documentId: 'm-doyle-estate-doc-1', page: 2, quote: 'the residue of my estate' }],
      rationale: 'The updated valuation of the residence adds $6,800.00 to the estate.',
    },
    {
      kind: 'note',
      payload: {
        bodyMd: 'Thomas Doyle is a beneficiary under the will, so he is entitled to a copy of it.',
        pinned: false,
      },
      citations: [{ documentId: 'm-doyle-estate-doc-1', page: 2, quote: 'to my son Thomas' }],
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
      settings: { clerk: { enabled: true, model: 'claude-sonnet-5-5' } },
      // Conflict checks mark adverse roles here, so the conflict scenarios show them (CORE-02), and
      // matters follow their templates' stages and tasks (CORE-07), and the illustrative Victorian
      // statutory deadline rules apply (CORE-10), Clerk's suggestions show on the Overview (AI-07)
      // and so does the fee panel (BILL-05).
      flags: {
        'conflicts.enforced': true,
        'templates.system': true,
        'deadlines.ruleset.vic.v1': true,
        'clerk.features.suggestions': true,
        // Fee arrangements, budgets and budget alerts on the Overview (BILL-05).
        'billing.feeBudgets': true,
      },
    }),
  );

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

  const matters = scenario === 'minimal' ? MATTERS.filter((m) => m.minimal) : MATTERS;
  const contactIds = new Set(
    matters.flatMap((m) => [...m.clients, ...m.parties.map(([id]) => id), ...(m.deceased ? [m.deceased] : [])]),
  );
  const contacts = scenario === 'minimal' ? CONTACTS.filter((c) => contactIds.has(c.id)) : CONTACTS;
  const contactById = new Map(CONTACTS.map((c) => [c.id, c]));
  const nameOf = (id: string) => {
    const c = contactById.get(id);
    return c ? domain.contactDisplayName({ givenNames: c.given, familyName: c.family, orgName: c.org }) : undefined;
  };
  // Numbers as matters-createMatter allocates them: this year (in Melbourne) from 1, reserved, with
  // the counter past them so new matters don't collide.
  const year = domain.matterNumberYear(now, 'Australia/Melbourne');
  const HOUR = 3_600_000;
  let nextSeq = 1;

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

  matters.forEach((spec, index) => {
    const base = `orgs/${org}/matters/${spec.id}`;
    const number = domain.formatMatterNumber(SEED_MATTER_NUMBER_FORMAT, year, nextSeq++);
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
    // Unbilled time is work in progress (BILL-01): a closed matter's time is all billed.
    const wip = closed
      ? 0
      : spec.time.reduce((sum, [, minutes, uid]) => {
          const units = Math.ceil(minutes / 6);
          return sum + domain.timeAmountCents(units, MEMBERS[uid]?.rate ?? 0);
        }, 0);
    // The fee (BILL-05): fixed for wills and powers of attorney, a cap on the trust, hourly with a
    // Victorian-style estimate range elsewhere. The budget is what the fees triggers would compute.
    const fee = seedFee(spec.type, spec.id === 'm-doyle-estate' ? { at: now, by: JORDAN } : undefined);
    const recorded = spec.time.reduce((sum, [, minutes, uid]) => {
      const units = Math.ceil(minutes / 6);
      return sum + domain.timeAmountCents(units, MEMBERS[uid]?.rate ?? 0);
    }, 0);
    const budget = domain.planBudget({
      fee,
      previous: null,
      sums: { timeCents: recorded, disbursementsCents: 0, billedCents: closed ? recorded : 0 },
      pcts: domain.DEFAULT_BUDGET_ALERT_PCTS,
      alertsOn: false,
    }).budget;
    const detail = MATTER_DETAILS[spec.id];
    const estate =
      detail && (detail.grantDate !== undefined || detail.grantNo || detail.grossValueCents !== undefined)
        ? {
            ...(detail.grantDate !== undefined ? { grantDate: rel(detail.grantDate) } : {}),
            ...(detail.grantNo ? { grantNo: detail.grantNo } : {}),
            ...(detail.grossValueCents !== undefined ? { grossValueCents: detail.grossValueCents as D.Cents } : {}),
          }
        : undefined;
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
    const stageEnteredOn = rel(-7);
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
      ...makeMatterNumber({ ...meta, number, matterId: spec.id, year }),
    });
    const matterData = {
      ...makeMatter({
        ...meta,
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
          ...(spec.type === 'will' ? {} : { sentOn: rel(-30) }),
        },
        conflictCheck: { status: spec.status === 'lead' ? 'pending' : 'clear' },
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
        // Most recent first in the order above, a few hours apart.
        lastActivityAt: new Date(now.getTime() - index * 5 * HOUR),
        closedAt: closed ? new Date(now.getTime() - 30 * 86_400_000) : undefined,
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
    spec.events.forEach(([kind, offset, label], i) =>
      add(
        `${base}/events/${spec.id}-ev-${i + 1}`,
        makeMatterEvent({ ...meta, kind, date: rel(offset), ...(label ? { label } : {}) }),
      ),
    );
    spec.tasks.forEach(([title, status, priority, due, assignee], i) =>
      add(
        `${base}/tasks/${spec.id}-t-${i + 1}`,
        makeTask({
          ...meta,
          orgId: org,
          matterId: spec.id,
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
          ...(task.done ? { status: 'done' as const, completedAt: now } : {}),
          countedOpen: !task.done,
        }),
      );
    }
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
        }),
      );
    }
    spec.notes.forEach((body, i) =>
      add(
        `${base}/notes/${spec.id}-n-${i + 1}`,
        makeNote({ ...meta, bodyMd: body, mentions: { uids: [], matterIds: [] }, pinned: i === 0 }),
      ),
    );
    spec.time.forEach(([daysAgo, minutes, uid, narrative], i) => {
      const units = Math.ceil(minutes / 6);
      const rate = MEMBERS[uid]?.rate ?? 0;
      const amount = domain.timeAmountCents(units, rate);
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
          billable: true,
          status: closed ? 'billed' : 'draft',
          source: 'manual',
          // Counted into the matter's wipCents above, so time-onWrite doesn't count it again.
          wipCountedCents: (closed ? 0 : amount) as D.Cents,
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
      firstSeq: nextSeq,
    });
    for (const doc of conflicts.docs) add(doc.path, doc.data);
    nextSeq = conflicts.nextSeq;
  }

  if (scenario === 'load') {
    const load = buildLoadMatters({
      orgId: org,
      count: LOAD_MATTER_COUNT,
      now,
      format: SEED_MATTER_NUMBER_FORMAT,
      year,
      firstSeq: nextSeq,
      uids: [PRIYA, JORDAN, DANIEL],
      clientContactIds: contacts.filter((c) => !c.org && c.dateOfDeath === undefined).map((c) => c.id),
      contactNames: Object.fromEntries(contacts.map((c) => [c.id, nameOf(c.id) ?? ''])),
    });
    for (const doc of [...load.matters, ...load.reservations]) add(doc.path, doc.data);
    nextSeq = load.nextSeq;
  }
  add(`orgs/${org}/counters/${domain.matterCounterId(year)}`, makeCounter({ ...meta, next: nextSeq }));

  return { accounts: [...SEED_ACCOUNTS], docs, files };
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
