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
  makeContact,
  makeDeadline,
  makeMatter,
  makeMatterDocument,
  makeMatterEvent,
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

export type SeedScenario = 'default' | 'minimal' | 'empty';
export const SEED_SCENARIOS: readonly SeedScenario[] = ['default', 'minimal', 'empty'];

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
};

/** About 25 fictional contacts. `dateOfDeath` is days before the anchor. */
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
  { id: 'c-bay-funerals', org: 'Bayside Funerals Pty Ltd (fictional)', tags: ['supplier'] },
  { id: 'c-corio-bank', org: 'Corio Savings Bank (fictional)', tags: ['institution'] },
  { id: 'c-lighthouse-advisers', org: 'Lighthouse Financial Advisers (fictional)', referrer: true, tags: ['referrer'] },
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
}

/** Twelve matters: every type and every status. Offsets are days from the anchor. */
const MATTERS: MatterSpec[] = [
  {
    id: 'm-doyle-estate',
    title: 'Estate of Margaret Doyle',
    type: 'probate',
    status: 'open',
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
    deadlines: [
      ['File probate application (14 days after notice)', 13, 'statutory', true, 'upcoming'],
      ['Family provision claim period ends (illustrative)', 100, 'statutory', true, 'upcoming'],
      ['Send costs disclosure update', 0, 'internal', false, 'upcoming'],
    ],
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
    deadlines: [['Signing appointment', 2, 'internal', false, 'upcoming']],
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
      ['grant_issued', -480],
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

const FIXTURE_FILES: Record<FixtureName, { name: string; category: D.MatterDocument['category'] }> = {
  will: { name: 'Will (fictional sample).pdf', category: 'will' },
  'death-certificate': { name: 'Death certificate (SAMPLE).pdf', category: 'death_certificate' },
  'court-order': { name: 'Orders (fictional sample).pdf', category: 'court_document' },
};

/** Prefix search tokens (2–10 characters) for each word, as the server would write them. */
export function searchTokens(...values: (string | undefined)[]): string[] {
  const tokens = new Set<string>();
  for (const value of values) {
    for (const word of (value ?? '').toLowerCase().split(/[^a-z0-9-]+/)) {
      for (let n = 3; n <= Math.min(word.length, 10); n++) tokens.add(word.slice(0, n));
    }
  }
  return [...tokens].slice(0, 200);
}

function contactName(spec: ContactSpec): string {
  return spec.org ?? `${spec.given} ${spec.family}`;
}

/** Builds the dataset for a scenario. Pure: the same anchor and fixtures give the same output. */
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
  const add = (path: string, data: object) => docs.push({ path, data: data as Record<string, unknown> });

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
      matterNumberFormat: 'HV-{YYYY}-{seq:4}',
      security: { mfaRequired: false, sessionIdleMinutes: 60 },
      settings: { clerk: { enabled: true } },
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
      status: 'todo',
      priority: 'medium',
      dueDate: rel(2),
      order: 1,
    }),
  );

  if (scenario === 'empty') return { accounts: [...SEED_ACCOUNTS], docs, files };

  const matters = scenario === 'minimal' ? MATTERS.filter((m) => m.minimal) : MATTERS;
  const contactIds = new Set(
    matters.flatMap((m) => [...m.clients, ...m.parties.map(([id]) => id), ...(m.deceased ? [m.deceased] : [])]),
  );
  const contacts = scenario === 'minimal' ? CONTACTS.filter((c) => contactIds.has(c.id)) : CONTACTS;
  const contactById = new Map(CONTACTS.map((c) => [c.id, c]));

  for (const spec of contacts) {
    const name = contactName(spec);
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
        search: searchTokens(name),
        dedupeKey: `${(spec.family ?? spec.org ?? '').toLowerCase()}|${(spec.given ?? '').toLowerCase()}|`,
      }),
    );
  }

  matters.forEach((spec, index) => {
    const base = `orgs/${org}/matters/${spec.id}`;
    const number = `HV-2026-${String(index + 1).padStart(4, '0')}`;
    const deceased = spec.deceased ? contactById.get(spec.deceased) : undefined;
    const openTasks = spec.tasks.filter(([, status]) => status !== 'done' && status !== 'cancelled');
    const upcoming = spec.deadlines
      .map(([title, due, , critical, status], i) => ({
        id: `${spec.id}-dl-${i + 1}`,
        title,
        dueDate: rel(due),
        critical,
        status,
      }))
      .filter((d) => d.status === 'upcoming')
      .sort((a, b) => domain.compareDates(a.dueDate, b.dueDate))[0];
    const wip = spec.time.reduce((sum, [, minutes, uid]) => {
      const units = Math.ceil(minutes / 6);
      return sum + Math.round((units * (MEMBERS[uid]?.rate ?? 0)) / 10);
    }, 0);
    const closed = spec.status === 'closed' || spec.status === 'archived';

    add(
      base,
      makeMatter({
        ...meta,
        number,
        title: spec.title,
        type: spec.type,
        status: spec.status,
        priority: spec.priority,
        jurisdiction: 'VIC',
        responsibleUid: spec.responsible,
        teamUids: spec.team,
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
        dispute: spec.dispute ? { kind: spec.dispute, proceedingIds: [] } : undefined,
        fee:
          spec.type === 'will' || spec.type === 'poa'
            ? { arrangement: 'fixed', amountCents: 165_000 as D.Cents, history: [] }
            : { arrangement: 'hourly', history: [] },
        costsDisclosure: {
          status: spec.type === 'will' ? 'not_required' : 'sent',
          ...(spec.type === 'will' ? {} : { sentOn: rel(-30) }),
        },
        conflictCheck: { status: spec.status === 'lead' ? 'pending' : 'clear' },
        search: searchTokens(spec.title, number),
        nextDeadline: upcoming
          ? { id: upcoming.id, dueDate: upcoming.dueDate, title: upcoming.title, critical: upcoming.critical }
          : undefined,
        openTaskCount: openTasks.length,
        wipCents: wip as D.Cents,
        lastActivityAt: now,
        closedAt: closed ? new Date(now.getTime() - 30 * 86_400_000) : undefined,
        closeReason: closed ? 'Matter completed' : undefined,
        labels: [],
      }),
    );

    spec.parties.forEach(([contactId, role], i) =>
      add(`${base}/parties/${spec.id}-p-${i + 1}`, makeParty({ ...meta, contactId, role })),
    );
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
        }),
      ),
    );
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
          // Static until the deadline engine (CORE-09) computes them.
          computed: undefined,
          reminders: [{ offsetDays: -7 }, { offsetDays: -1 }],
          pastOnCreation: false,
        }),
      ),
    );
    spec.notes.forEach((body, i) =>
      add(
        `${base}/notes/${spec.id}-n-${i + 1}`,
        makeNote({ ...meta, bodyMd: body, mentions: { uids: [], matterIds: [] }, pinned: i === 0 }),
      ),
    );
    spec.time.forEach(([daysAgo, minutes, uid, narrative], i) => {
      const units = Math.ceil(minutes / 6);
      const rate = MEMBERS[uid]?.rate ?? 0;
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
          amountCents: Math.round((units * rate) / 10) as D.Cents,
          narrative,
          billable: true,
          status: closed ? 'billed' : 'draft',
        }),
      );
    });
    spec.documents.forEach((fixture, i) => {
      const id = `${spec.id}-doc-${i + 1}`;
      const storagePath = `${base}/documents/${id}/v1`;
      const info = options.fixtures[fixture];
      add(
        `${base}/documents/${id}`,
        makeMatterDocument({
          ...meta,
          orgId: org,
          matterId: spec.id,
          name: FIXTURE_FILES[fixture].name,
          storagePath,
          mime: 'application/pdf',
          sizeBytes: info.sizeBytes,
          sha256: info.sha256,
          version: 1,
          category: FIXTURE_FILES[fixture].category,
          scan: { status: 'clean' },
          ingest: { status: 'done', pages: info.pages },
          pageCount: info.pages,
          source: 'upload',
        }),
      );
      files.push({ storagePath, fixture });
    });
  });

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
