/**
 * The demo practice's extra content (`seed --scenario=demo`, and `demo-reset` on dev): when the
 * default practice's matters opened, the earlier work and invoices on them, and a year and a half
 * of closed matters (wills, powers of attorney and estates, with their time, invoices and
 * payments), so Insights has trends to show and the invoice and debtor screens have history.
 *
 * Everything is invented: the people, the Geelong-area suburbs, the grant numbers. Days count back
 * from the anchor, so the history moves with the day the demo is reset. Never add real client data.
 */
import type * as D from '@materia/domain';

import type { ClerkThreadSpec, ContactSpec, InvoiceSpec, MatterSpec, TimeSpec } from './dataset.ts';

const PRIYA = 'user-priya';
const JORDAN = 'user-jordan';
const DANIEL = 'user-daniel';

/** Work on a fixed-fee matter: recorded and approved, but billed as the fixed fee, not by the hour. */
const FIXED = { status: 'final', billable: false } as const;
const BILLED = { status: 'billed' } as const;
/** Approved and not yet billed: what a pre-bill can bill now (BILL-07). */
const FINAL = { status: 'final' } as const;

/** The history's clients, executors and deceased (all fictional). `dateOfDeath` is days before the anchor. */
export const DEMO_CONTACTS: ContactSpec[] = [
  { id: 'c-graham-pemberton', given: 'Graham', family: 'Pemberton', suburb: 'Highton' },
  { id: 'c-leonard-pemberton', given: 'Leonard', family: 'Pemberton', dateOfDeath: 470, suburb: 'Highton' },
  { id: 'c-sandra-murray', given: 'Sandra', family: 'Murray', suburb: 'Belmont' },
  { id: 'c-kevin-murray', given: 'Kevin', family: 'Murray', suburb: 'Belmont' },
  { id: 'c-fiona-lachlan', given: 'Fiona', family: 'Lachlan', suburb: 'Newtown' },
  { id: 'c-raj-sharma', given: 'Raj', family: 'Sharma', suburb: 'Armstrong Creek' },
  { id: 'c-anita-sharma', given: 'Anita', family: 'Sharma', suburb: 'Armstrong Creek' },
  { id: 'c-beatrice-holloway', given: 'Beatrice', family: 'Holloway', suburb: 'Queenscliff' },
  { id: 'c-tom-barnes', given: 'Tom', family: 'Barnes', suburb: 'Torquay' },
  { id: 'c-lucy-barnes', given: 'Lucy', family: 'Barnes', suburb: 'Torquay' },
  { id: 'c-henry-castellano', given: 'Henry', family: 'Castellano', suburb: 'Bell Park' },
  { id: 'c-amira-haddad', given: 'Amira', family: 'Haddad', suburb: 'Hamlyn Heights' },
  { id: 'c-sami-haddad', given: 'Sami', family: 'Haddad', suburb: 'Hamlyn Heights' },
  { id: 'c-joan-mcallister', given: 'Joan', family: 'McAllister', suburb: 'Drysdale' },
  { id: 'c-marcus-wu', given: 'Marcus', family: 'Wu', suburb: 'Waurn Ponds' },
  { id: 'c-priscilla-wu', given: 'Priscilla', family: 'Wu', suburb: 'Waurn Ponds' },
  { id: 'c-noel-fitzgerald', given: 'Noel', family: 'Fitzgerald', suburb: 'Portarlington' },
  { id: 'c-kiri-walker', given: 'Kiri', family: 'Walker', suburb: 'Jan Juc' },
  { id: 'c-ahmed-karimi', given: 'Ahmed', family: 'Karimi', suburb: 'Lara' },
  { id: 'c-leila-karimi', given: 'Leila', family: 'Karimi', suburb: 'Lara' },
  { id: 'c-valerie-pike', given: 'Valerie', family: 'Pike', suburb: 'Ocean Grove' },
  { id: 'c-ian-robertson', given: 'Ian', family: 'Robertson', suburb: 'Geelong West' },
  { id: 'c-margot-ferris', given: 'Margot', family: 'Ferris', suburb: 'Clifton Springs' },
  { id: 'c-dorothy-kane', given: 'Dorothy', family: 'Kane', dateOfDeath: 380, suburb: 'Grovedale' },
  { id: 'c-michael-kane', given: 'Michael', family: 'Kane', suburb: 'Grovedale' },
  { id: 'c-frank-morello', given: 'Frank', family: 'Morello', dateOfDeath: 300, suburb: 'Corio' },
  { id: 'c-teresa-morello', given: 'Teresa', family: 'Morello', suburb: 'Corio' },
  { id: 'c-rosemary-quinn', given: 'Rosemary', family: 'Quinn', dateOfDeath: 345, suburb: 'Leopold' },
  { id: 'c-alan-quinn', given: 'Alan', family: 'Quinn', suburb: 'Leopold' },
  { id: 'c-walter-brooks', given: 'Walter', family: 'Brooks', dateOfDeath: 260, suburb: 'East Geelong' },
  { id: 'c-helen-brooks', given: 'Helen', family: 'Brooks', suburb: 'East Geelong' },
];

/**
 * The default practice's matters in the demo: when each opened (and closed), and the work and
 * invoices before the seed's recent time. `time` replaces the matter's own when `replaceTime` is set.
 */
interface CurrentMatterHistory {
  opened: number;
  closed?: number;
  closing?: MatterSpec['closing'];
  time?: TimeSpec[];
  replaceTime?: boolean;
  invoices?: InvoiceSpec[];
}

const CURRENT: Readonly<Record<string, CurrentMatterHistory>> = {
  'm-doyle-estate': {
    opened: 74,
    time: [
      [73, 66, JORDAN, 'Initial conference with the executors; costs disclosure', BILLED],
      [70, 30, DANIEL, 'Retrieved the original will from safe custody', BILLED],
      [66, 42, DANIEL, 'Letters to asset holders for date-of-death balances', BILLED],
      [55, 54, JORDAN, 'Advised the executors on the estate register and the super nomination', BILLED],
      [41, 36, JORDAN, 'Reviewed the asset schedule and valuations', BILLED],
      [20, 48, JORDAN, 'Prepared the notice of intended application', FINAL],
      [12, 30, DANIEL, 'Searched the will bank and the probate register', FINAL],
    ],
    // An interim account, paid from the estate's money in trust (BILL-12).
    invoices: [{ issuedDaysAgo: 35, paidFromTrust: true, payments: [[28, 'trust_transfer']] }],
  },
  'm-nguyen-fp': {
    opened: 150,
    time: [
      [148, 90, PRIYA, 'First conference with the plaintiff; costs disclosure', BILLED],
      [140, 120, JORDAN, 'Reviewed the will and estate information; letter of advice', BILLED],
      [112, 60, JORDAN, 'Letter to the executor’s solicitors seeking estate information', BILLED],
      [75, 150, PRIYA, 'Settled the originating motion and supporting affidavit', BILLED],
      [62, 84, JORDAN, 'Filed and served the originating process', BILLED],
      [21, 96, JORDAN, 'Prepared for and attended the directions hearing', FINAL],
    ],
    // The first account paid; the second is overdue, so it shows in aged debtors with a reminder.
    invoices: [
      { issuedDaysAgo: 105, payments: [[92, 'eft']] },
      { issuedDaysAgo: 48, paymentTermsDays: 14 },
    ],
  },
  'm-doyle-brennan': {
    opened: 100,
    time: [
      [96, 120, PRIYA, 'Conference with the client; reviewed the caveat and grounds', FINAL],
      [81, 66, PRIYA, 'Letter to the other side on capacity evidence', FINAL],
    ],
  },
  'm-okafor-loa': { opened: 28 },
  'm-okafor-wills': { opened: 6 },
  'm-whitfield-poa': {
    opened: 16,
    replaceTime: true,
    time: [
      [15, 48, JORDAN, 'Instructions for the enduring power of attorney', FIXED],
      [2, 36, JORDAN, 'Drafted the enduring power of attorney', FIXED],
    ],
    // Billed on instructions; not due yet.
    invoices: [{ issuedDaysAgo: 3, fixedFee: 'Enduring power of attorney (fixed fee)' }],
  },
  'm-feather-admin': {
    opened: 65,
    time: [
      [64, 54, PRIYA, 'Instructions from the executor; costs disclosure', BILLED],
      [58, 36, DANIEL, 'Letters to asset holders for date-of-death balances', BILLED],
      [44, 30, DANIEL, 'Gathered the estate information for the grant', BILLED],
      [30, 48, PRIYA, 'Advised the executor on the funeral account and debts', BILLED],
    ],
    // Part paid, the rest due in a few days.
    invoices: [{ issuedDaysAgo: 25, paymentTermsDays: 30, payments: [[12, 'eft', 50_000]] }],
  },
  'm-ellis-trust': {
    opened: 330,
    time: [[205, 60, PRIYA, 'Trustee’s resolution for the annual distribution', BILLED]],
    invoices: [{ issuedDaysAgo: 200, payments: [[186, 'eft']] }],
  },
  'm-ellis-estate': {
    opened: 590,
    closed: 190,
    closing: { finalDistributionRecorded: true },
    time: [
      [588, 72, PRIYA, 'Initial conference with the executor; costs disclosure', BILLED],
      [575, 42, DANIEL, 'Death certificate and will bank search', BILLED],
      [562, 30, DANIEL, 'Published the notice of intended application', BILLED],
      [530, 96, PRIYA, 'Prepared and filed the probate application', BILLED],
      [478, 30, DANIEL, 'Collected the grant; letters to asset holders', BILLED],
      [470, 24, DANIEL, 'Published the s 33 notice', BILLED],
      [400, 60, PRIYA, 'Sale of the residence: advice and settlement', BILLED],
      [215, 84, PRIYA, 'Estate accounts and distribution statement', BILLED],
      [196, 36, PRIYA, 'Final distributions and receipts; closing letter', BILLED],
    ],
    invoices: [
      { issuedDaysAgo: 520, paidFromTrust: true, payments: [[505, 'trust_transfer']] },
      { issuedDaysAgo: 194, paidFromTrust: true, payments: [[188, 'trust_transfer']] },
    ],
  },
  'm-chen-wills': {
    opened: 420,
    closed: 395,
    time: [
      [419, 66, JORDAN, 'Instructions for mirror wills', FIXED],
      [410, 72, DANIEL, 'Prepared the draft wills', FIXED],
      [397, 42, JORDAN, 'Will signing appointment', FIXED],
    ],
    invoices: [{ issuedDaysAgo: 397, fixedFee: 'Mirror wills (fixed fee)', payments: [[397, 'card']] }],
  },
  'm-brennan-estate': { opened: 110 },
  'm-nguyen-poa': {
    opened: 320,
    closed: 290,
    replaceTime: true,
    time: [
      [318, 48, JORDAN, 'Instructions for the power of attorney', FIXED],
      [300, 42, JORDAN, 'Signing appointment', FIXED],
    ],
    invoices: [{ issuedDaysAgo: 300, fixedFee: 'Power of attorney (fixed fee)', payments: [[296, 'eft']] }],
  },
};

/** When the conflict scenarios' matters opened (CORE-02), and closed, in days before the anchor. */
export const DEMO_CONFLICT_DATES: Readonly<Record<string, { opened: number; closed?: number }>> = {
  'm-cf-halloway-estate': { opened: 60 },
  'm-cf-marchetti-will': { opened: 45 },
  'm-cf-ferrow-trust': { opened: 210 },
  'm-cf-quint-contest': { opened: 130 },
  'm-cf-stroud-fp': { opened: 90 },
  'm-cf-pell-fp': { opened: 260, closed: 150 },
};

const nguyenOrders = (quote: string): D.CitationInput => ({
  kind: 'document',
  documentId: 'm-nguyen-fp-doc-1',
  docVersion: 1,
  page: 1,
  quote,
});

/** A Clerk thread on the Nguyen claim, quoting the orders fixture (AI-05, AI-06). */
export const DEMO_CLERK_THREADS: Readonly<Record<string, readonly ClerkThreadSpec[]>> = {
  'm-nguyen-fp': [
    {
      id: 'm-nguyen-fp-ct-1',
      title: 'What the directions orders require',
      question: 'What do the directions orders require of each side, and by when?',
      answer: [
        'The plaintiff files and serves her affidavit within 21 days.[1]',
        'The defendant then has 42 days to file and serve any affidavit in reply.[2]',
        'The proceeding goes to mediation, to be completed within 60 days.[3]',
        'Costs are reserved.[4]',
      ].join(' '),
      citations: [
        nguyenOrders('The plaintiff file and serve any affidavit on which she intends to rely within 21 days.'),
        nguyenOrders('The defendant file and serve any affidavit in reply within 42 days.'),
        nguyenOrders('The proceeding be referred to mediation, to be completed within 60 days.'),
        nguyenOrders('Costs be reserved.'),
      ],
    },
  ],
};

/** A will or power of attorney, start to finish on a fixed fee. */
function fixedFeeMatter(o: {
  id: string;
  title: string;
  type: 'will' | 'poa';
  clients: string[];
  opened: number;
  closed: number;
  lawyer: string;
  referrer?: string;
  paidAfter?: number;
}): MatterSpec {
  const will = o.type === 'will';
  return {
    id: o.id,
    title: o.title,
    type: o.type,
    status: 'closed',
    priority: 'none',
    responsible: o.lawyer,
    team: [o.lawyer, DANIEL],
    clients: o.clients,
    testator: o.clients[0] as string,
    ...(o.referrer ? { referrer: o.referrer } : { referralSource: o.opened % 2 ? 'website' : 'existing_client' }),
    parties: o.clients.map((id): [string, D.PartyRole] => [id, will ? 'testator' : 'client']),
    events: [],
    tasks: [],
    deadlines: [],
    notes: [],
    time: [
      [
        o.opened,
        60,
        o.lawyer,
        `Initial conference: instructions for the ${will ? 'will' : 'power of attorney'}`,
        FIXED,
      ],
      [o.opened - 4, 66, DANIEL, `Prepared the draft ${will ? 'will' : 'power of attorney'}`, FIXED],
      [o.opened - 7, 24, o.lawyer, 'Settled the draft; letter to the client', FIXED],
      [o.closed + 2, 42, o.lawyer, 'Signing appointment', FIXED],
      [
        o.closed,
        18,
        DANIEL,
        will ? 'Reporting letter; original will to safe custody' : 'Reporting letter; copies certified',
        FIXED,
      ],
    ],
    documents: [],
    openedDaysAgo: o.opened,
    closedDaysAgo: o.closed,
    detail: { stageId: 'closed', ...(will ? { willDate: -(o.closed + 2) } : {}) },
    invoices: [
      {
        issuedDaysAgo: o.closed + 2,
        fixedFee: will
          ? o.clients.length > 1
            ? 'Mirror wills (fixed fee)'
            : 'Will (fixed fee)'
          : 'Enduring power of attorney (fixed fee)',
        payments: [[o.closed + 2 - (o.paidAfter ?? 0), o.paidAfter ? 'eft' : 'card']],
      },
    ],
  };
}

/** The work on an estate, in order; spread evenly from instructions to closing. */
const ESTATE_WORK: [minutes: number, by: 'lawyer' | 'paralegal', narrative: string][] = [
  [72, 'lawyer', 'Initial conference with the executor; costs disclosure'],
  [30, 'paralegal', 'Ordered the death certificate; will bank search'],
  [48, 'paralegal', 'Letters to asset holders for date-of-death balances'],
  [96, 'lawyer', 'Drafted the application and supporting affidavit'],
  [24, 'paralegal', 'Published the notice of intended application'],
  [36, 'lawyer', 'Filed the application through RedCrest'],
  [42, 'paralegal', 'Collected and closed the bank accounts'],
  [60, 'lawyer', 'Advised the executor on the sale of the residence'],
  [30, 'paralegal', 'Published the s 33 notice to creditors'],
  [84, 'lawyer', 'Prepared the estate accounts and distribution statement'],
  [36, 'lawyer', 'Final distributions and receipts; closing letter'],
];

/** A deceased estate from instructions to final distribution, billed by the hour in two accounts paid from trust. */
function estateMatter(o: {
  id: string;
  title: string;
  type: 'probate' | 'loa' | 'admin';
  deceased: string;
  client: string;
  opened: number;
  closed: number;
  died: number;
  granted: number;
  grantNo: string;
  grossValueCents: number;
  lawyer: string;
  referrer?: string;
}): MatterSpec {
  const span = o.opened - o.closed;
  const time: TimeSpec[] = ESTATE_WORK.map(([minutes, by, narrative], i) => [
    o.opened - Math.round((span * i) / (ESTATE_WORK.length - 1)),
    minutes,
    by === 'lawyer' ? o.lawyer : DANIEL,
    narrative,
    BILLED,
  ]);
  // The interim account bills the work up to the filing; the final account the rest.
  const interim = (time[5]?.[0] ?? o.opened) - 1;
  return {
    id: o.id,
    title: o.title,
    type: o.type,
    status: 'closed',
    priority: 'none',
    responsible: o.lawyer,
    team: [o.lawyer, DANIEL],
    clients: [o.client],
    deceased: o.deceased,
    ...(o.referrer ? { referrer: o.referrer } : { referralSource: 'existing_client' }),
    parties: [
      [o.client, o.type === 'loa' ? 'administrator' : 'executor'],
      [o.deceased, 'deceased'],
    ],
    events: [
      ['date_of_death', -o.died],
      ...(o.type === 'admin' ? [] : [['notice_published', -(o.granted + 35)] as [D.EventKind, number]]),
      ['grant_issued', -o.granted],
      ['statutory_notice_published', -(o.granted - 12), 'Section 33 notice published'],
    ],
    tasks: [],
    deadlines: [
      ['Advise beneficiaries of the grant', -(o.granted - 7), 'internal', false, 'done'],
      ['Final distribution', -(o.closed + 3), 'internal', false, 'done'],
    ],
    notes: ['Estate finalised; closing letter sent and the file closed.'],
    time,
    documents: [],
    openedDaysAgo: o.opened,
    closedDaysAgo: o.closed,
    detail: {
      stageId: 'closed',
      ...(o.type === 'loa' ? {} : { willDate: -(o.died + 2200) }),
      grantDate: -o.granted,
      grantNo: o.grantNo,
      grossValueCents: o.grossValueCents,
    },
    closing: { finalDistributionRecorded: true },
    invoices: [
      { issuedDaysAgo: interim, paidFromTrust: true, payments: [[interim - 10, 'trust_transfer']] },
      { issuedDaysAgo: o.closed, paidFromTrust: true, payments: [[o.closed, 'trust_transfer']] },
    ],
  };
}

/** A year and a half of finished work, busier lately. */
const HISTORY: MatterSpec[] = [
  estateMatter({
    id: 'm-h-pemberton-estate',
    title: 'Estate of Leonard Pemberton',
    type: 'probate',
    deceased: 'c-leonard-pemberton',
    client: 'c-graham-pemberton',
    opened: 455,
    closed: 232,
    died: 470,
    granted: 330,
    grantNo: 'S PRB 2025 90114',
    grossValueCents: 742_000_00,
    lawyer: PRIYA,
    referrer: 'c-bay-funerals',
  }),
  fixedFeeMatter({
    id: 'm-h-pemberton-will',
    title: 'Will — Graham Pemberton',
    type: 'will',
    clients: ['c-graham-pemberton'],
    opened: 440,
    closed: 412,
    lawyer: JORDAN,
  }),
  fixedFeeMatter({
    id: 'm-h-murray-wills',
    title: 'Wills — Sandra and Kevin Murray',
    type: 'will',
    clients: ['c-sandra-murray', 'c-kevin-murray'],
    opened: 400,
    closed: 371,
    lawyer: JORDAN,
    paidAfter: 9,
  }),
  fixedFeeMatter({
    id: 'm-h-pike-poa',
    title: 'Enduring power of attorney — Valerie Pike',
    type: 'poa',
    clients: ['c-valerie-pike'],
    opened: 382,
    closed: 361,
    lawyer: JORDAN,
  }),
  estateMatter({
    id: 'm-h-kane-estate',
    title: 'Estate of Dorothy Kane',
    type: 'probate',
    deceased: 'c-dorothy-kane',
    client: 'c-michael-kane',
    opened: 362,
    closed: 121,
    died: 380,
    granted: 262,
    grantNo: 'S PRB 2025 90371',
    grossValueCents: 915_400_00,
    lawyer: JORDAN,
    referrer: 'c-bay-funerals',
  }),
  fixedFeeMatter({
    id: 'm-h-lachlan-will',
    title: 'Will — Fiona Lachlan',
    type: 'will',
    clients: ['c-fiona-lachlan'],
    opened: 341,
    closed: 318,
    lawyer: JORDAN,
  }),
  estateMatter({
    id: 'm-h-quinn-estate',
    title: 'Estate of Rosemary Quinn',
    type: 'loa',
    deceased: 'c-rosemary-quinn',
    client: 'c-alan-quinn',
    opened: 331,
    closed: 96,
    died: 345,
    granted: 221,
    grantNo: 'S PRB 2025 90502',
    grossValueCents: 486_750_00,
    lawyer: PRIYA,
  }),
  fixedFeeMatter({
    id: 'm-h-sharma-wills',
    title: 'Wills — Raj and Anita Sharma',
    type: 'will',
    clients: ['c-raj-sharma', 'c-anita-sharma'],
    opened: 301,
    closed: 277,
    lawyer: JORDAN,
    referrer: 'c-lighthouse-advisers',
    paidAfter: 6,
  }),
  estateMatter({
    id: 'm-h-morello-estate',
    title: 'Estate of Frank Morello',
    type: 'probate',
    deceased: 'c-frank-morello',
    client: 'c-teresa-morello',
    opened: 282,
    closed: 61,
    died: 300,
    granted: 191,
    grantNo: 'S PRB 2026 90027',
    grossValueCents: 1_104_200_00,
    lawyer: JORDAN,
  }),
  fixedFeeMatter({
    id: 'm-h-holloway-will',
    title: 'Will — Beatrice Holloway',
    type: 'will',
    clients: ['c-beatrice-holloway'],
    opened: 251,
    closed: 227,
    lawyer: PRIYA,
  }),
  estateMatter({
    id: 'm-h-brooks-estate',
    title: 'Estate of Walter Brooks',
    type: 'admin',
    deceased: 'c-walter-brooks',
    client: 'c-helen-brooks',
    opened: 232,
    closed: 36,
    died: 260,
    granted: 214,
    grantNo: 'S PRB 2026 90090',
    grossValueCents: 655_900_00,
    lawyer: PRIYA,
    referrer: 'c-bay-funerals',
  }),
  fixedFeeMatter({
    id: 'm-h-barnes-wills',
    title: 'Wills — Tom and Lucy Barnes',
    type: 'will',
    clients: ['c-tom-barnes', 'c-lucy-barnes'],
    opened: 206,
    closed: 181,
    lawyer: JORDAN,
    referrer: 'c-lighthouse-advisers',
  }),
  fixedFeeMatter({
    id: 'm-h-robertson-poa',
    title: 'Enduring power of attorney — Ian Robertson',
    type: 'poa',
    clients: ['c-ian-robertson'],
    opened: 191,
    closed: 171,
    lawyer: JORDAN,
    paidAfter: 5,
  }),
  fixedFeeMatter({
    id: 'm-h-castellano-will',
    title: 'Will — Henry Castellano',
    type: 'will',
    clients: ['c-henry-castellano'],
    opened: 161,
    closed: 139,
    lawyer: JORDAN,
  }),
  fixedFeeMatter({
    id: 'm-h-haddad-wills',
    title: 'Wills — Amira and Sami Haddad',
    type: 'will',
    clients: ['c-amira-haddad', 'c-sami-haddad'],
    opened: 128,
    closed: 104,
    lawyer: PRIYA,
    paidAfter: 8,
  }),
  fixedFeeMatter({
    id: 'm-h-mcallister-will',
    title: 'Will — Joan McAllister',
    type: 'will',
    clients: ['c-joan-mcallister'],
    opened: 96,
    closed: 71,
    lawyer: JORDAN,
  }),
  fixedFeeMatter({
    id: 'm-h-ferris-poa',
    title: 'Enduring power of attorney — Margot Ferris',
    type: 'poa',
    clients: ['c-margot-ferris'],
    opened: 76,
    closed: 53,
    lawyer: JORDAN,
  }),
  fixedFeeMatter({
    id: 'm-h-wu-wills',
    title: 'Wills — Marcus and Priscilla Wu',
    type: 'will',
    clients: ['c-marcus-wu', 'c-priscilla-wu'],
    opened: 64,
    closed: 41,
    lawyer: JORDAN,
    referrer: 'c-lighthouse-advisers',
    paidAfter: 7,
  }),
  fixedFeeMatter({
    id: 'm-h-fitzgerald-will',
    title: 'Will — Noel Fitzgerald',
    type: 'will',
    clients: ['c-noel-fitzgerald'],
    opened: 42,
    closed: 19,
    lawyer: PRIYA,
  }),
  fixedFeeMatter({
    id: 'm-h-walker-will',
    title: 'Will — Kiri Walker',
    type: 'will',
    clients: ['c-kiri-walker'],
    opened: 31,
    closed: 9,
    lawyer: JORDAN,
  }),
  fixedFeeMatter({
    id: 'm-h-karimi-wills',
    title: 'Wills — Ahmed and Leila Karimi',
    type: 'will',
    clients: ['c-ahmed-karimi', 'c-leila-karimi'],
    opened: 27,
    closed: 6,
    lawyer: JORDAN,
    paidAfter: 3,
  }),
];

/** The demo's matters: the practice's, with when they opened and their earlier work, then the history. */
export function demoMatters(matters: readonly MatterSpec[]): MatterSpec[] {
  const current = matters.map((spec): MatterSpec => {
    const history = CURRENT[spec.id];
    if (!history) return spec;
    const earlier = history.time ?? [];
    return {
      ...spec,
      openedDaysAgo: history.opened,
      ...(history.closed !== undefined ? { closedDaysAgo: history.closed } : {}),
      ...(history.closing ? { closing: history.closing } : {}),
      time: history.replaceTime ? earlier : [...earlier, ...spec.time],
      ...(history.invoices ? { invoices: history.invoices } : {}),
    };
  });
  return [...current, ...HISTORY];
}
