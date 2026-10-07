/**
 * A synthetic large practice for performance work (SEC-07): Ashgrove & Finch Lawyers, fictional,
 * at the target scale (50 members, 10,000 matters, 500,000 documents, 2,000,000 time entries)
 * with the matters and their records times `scale`. The firm is always the full 50 members (the
 * target is firms of up to 50, and member lists are read whole); each matter carries the same
 * records at every scale. The first lawyer (`lg-lawyer-1`, `lawyer1@large.example`) always carries a
 * full fee earner's share of matters (target matters ÷ the 28 who run matters, about 357) when the
 * scale allows it, so one person's screens read what they would at the target scale. Clerk is on,
 * with the data-use disclosure acknowledged; the load tests (tools/load) save its key.
 *
 * Records are generated one matter at a time (a generator), so the full scale never sits in
 * memory. Each kind's prototype is built once with the libs/test-utils factory (schema-valid by
 * construction) and varied per record. Every name is invented; nothing here is real client data.
 */
import * as DeadlinesNs from '@materia/deadlines';
import * as D from '@materia/domain';
import * as TestUtilsNs from '@materia/test-utils';

import { type SeedAccount, type SeedDoc, SEED_PASSWORD, stripUndefined } from './dataset.ts';
import { unwrap } from './interop.ts';

const domain = unwrap(D);
const F = unwrap(TestUtilsNs);
const deadlines = unwrap(DeadlinesNs);

export const LARGE_ORG_ID = 'org-large';
export const LARGE_ORG_NAME = 'Ashgrove & Finch Lawyers (Fictional)';
/** Emulator-only and deliberately public, like the default seed's. */
export const LARGE_PASSWORD = SEED_PASSWORD;

/** The ticket's target firm (SEC-07). */
export const TARGET = { members: 50, matters: 10_000, documents: 500_000, timeEntries: 2_000_000 } as const;

/** Records per matter beyond the ticket's figures, from the Harbour & Vine seed's proportions. */
export const PER_MATTER = { contacts: 1.5, parties: 3, deadlines: 4, tasks: 8, events: 1, notes: 2 } as const;

/** The target firm's members by role (who runs matters: the owner, admins and lawyers). */
export const ROLE_MIX: Readonly<Record<D.Role, number>> = {
  owner: 1,
  admin: 2,
  lawyer: 25,
  paralegal: 17,
  readonly: 5,
};

/** A fee earner's full share of matters at the target scale (10,000 ÷ 28 who run matters). */
export const FULL_LOAD_MATTERS = Math.round(TARGET.matters / (ROLE_MIX.owner + ROLE_MIX.admin + ROLE_MIX.lawyer));

/** Matters open over eight years: the 2 million time entries are about 20 a day per fee earner. */
export const HISTORY_DAYS = 8 * 365;

/** Of a live matter's upcoming deadlines and open tasks, the share already overdue (a practice that keeps up). */
const OVERDUE_DEADLINE_SHARE = 0.01;
const OVERDUE_TASK_SHARE = 0.03;

export interface LargePlan {
  scale: number;
  orgId: string;
  accounts: SeedAccount[];
  matters: number;
  documents: number;
  timeEntries: number;
  contacts: number;
  parties: number;
  deadlines: number;
  tasks: number;
  events: number;
  notes: number;
  /** Matters the first lawyer is responsible for. */
  fullLoadMatters: number;
  /** About how many documents are written: the records, members, users and number reservations (plus a few
   * dozen counters, recent entries, this month's rollups and the reference calendars). */
  total: number;
}

const GIVEN = [
  'Ada', 'Bertram', 'Clementine', 'Desmond', 'Edith', 'Fergus', 'Gwendolyn', 'Horace', 'Imogen', 'Jasper',
  'Kit', 'Lavinia', 'Mortimer', 'Nell', 'Osric', 'Philippa', 'Quentin', 'Rosalind', 'Septimus', 'Theodora',
]; // prettier-ignore
const FAMILY = [
  'Quill', 'Fernsby', 'Ashcombe', 'Thistlewood', 'Marrow', 'Pennyfeather', 'Lockhart', 'Bramble', 'Wexley',
  'Oakhurst', 'Tumbleton', 'Harrowgate', 'Bellweather', 'Crabtree', 'Dunmore', 'Elderberry', 'Foxglove',
  'Gallowmere', 'Hawthorne', 'Inkwell', 'Juniper', 'Kettleby', 'Larkspur', 'Mossgrove', 'Nettlefield',
]; // prettier-ignore
const MEMBER_NAMES = [
  'Ottilie Ashgrove', 'Rupert Finch', 'Marguerite Vale', 'Barnaby Thorne', 'Cordelia Wren', 'Ambrose Hale',
  'Isadora Pike', 'Leopold Crane', 'Winifred Stone', 'Cassius Reed',
]; // prettier-ignore
const TASK_TITLES = [
  'Request the death certificate',
  'Write to the bank for date-of-death balances',
  'Prepare the inventory of assets and liabilities',
  'Draft the executor’s affidavit',
  'Advertise the notice of intended distribution',
  'Report to the executor',
  'Prepare the interim distribution statement',
  'Call the beneficiary about their share',
  'Review the will for the residuary clause',
  'File the application for the grant',
];
const DEADLINE_TITLES = [
  'Lodge the application for the grant',
  'Distribute after the notice period ends (illustrative)',
  'Respond to the caveat',
  'File the inventory with the court',
  'Serve the summons on the defendants',
  'Agreed date for the executor’s accounts',
];
const DOC_NAMES: readonly [D.MatterDocument['category'], string][] = [
  ['will', 'Will'],
  ['death_certificate', 'Death certificate'],
  ['correspondence', 'Letter to the executor'],
  ['correspondence', 'Email from the bank'],
  ['financial', 'Bank statement'],
  ['affidavit', 'Affidavit of the executor'],
  ['court_document', 'Summons'],
  ['grant', 'Grant of probate'],
  ['id', 'Driver licence'],
  ['other', 'File note'],
];
const NARRATIVES = [
  'Review the will and make a file note',
  'Telephone call with the executor',
  'Draft a letter to the bank',
  'Prepare the inventory',
  'Attend to correspondence from the beneficiary',
  'Review the title search',
  'Settle the affidavit with counsel',
];
const TITLE: Record<D.MatterType, (name: string) => string> = {
  will: (name) => `${name} — will`,
  poa: (name) => `${name} — power of attorney`,
  probate: (name) => `Estate of ${name}`,
  loa: (name) => `Estate of ${name} (administration)`,
  admin: (name) => `Estate of ${name} — administration`,
  fp: (name) => `${name} family provision claim`,
  contest: (name) => `Re the will of ${name}`,
  trust: (name) => `${name} Testamentary Trust`,
};
const DECEASED_TYPES = new Set<D.MatterType>(['probate', 'loa', 'admin', 'fp', 'contest']);
const DAY = 86_400_000;

const at = <T>(list: readonly T[], index: number): T => list[((index % list.length) + list.length) % list.length] as T;

/** A small deterministic PRNG (mulberry32), so every run writes the same practice. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` spread over `count` slots as evenly as whole numbers allow: slot `i`'s share. */
function share(n: number, count: number, i: number): number {
  return Math.floor(n / count) + (i < n % count ? 1 : 0);
}

/** The firm's 50 accounts (`ROLE_MIX`), the first lawyer being the full-load one. */
export function largeAccounts(): SeedAccount[] {
  const accounts: SeedAccount[] = [];
  let n = 0;
  for (const role of ['owner', 'admin', 'lawyer', 'paralegal', 'readonly'] as const) {
    for (let i = 1; i <= ROLE_MIX[role]; i++) {
      const suffix = role === 'owner' ? '' : String(i);
      const [first, last] = at(MEMBER_NAMES, n).split(' ') as [string, string];
      accounts.push({
        uid: role === 'owner' ? 'lg-owner' : `lg-${role}-${i}`,
        email: `${role}${suffix}@large.example`,
        displayName:
          n < MEMBER_NAMES.length ? `${first} ${last}` : `${first} ${last} ${Math.floor(n / MEMBER_NAMES.length) + 1}`,
        role,
      });
      n++;
    }
  }
  return accounts;
}

/** What `largeOrgDocs` writes at a scale (1 = the target practice). */
export function planLargeOrg(scale: number, orgId = LARGE_ORG_ID): LargePlan {
  if (!(scale > 0) || scale > 1)
    throw new Error('--scale is a number above 0 and at most 1 (1 is the target practice)');
  const accounts = largeAccounts();
  const matters = Math.max(1, Math.round(TARGET.matters * scale));
  const documents = Math.round(TARGET.documents * scale);
  const timeEntries = Math.round(TARGET.timeEntries * scale);
  const per = (k: keyof typeof PER_MATTER) => Math.round(matters * PER_MATTER[k]);
  const plan = {
    scale,
    orgId,
    accounts,
    matters,
    documents,
    timeEntries,
    contacts: Math.max(3, per('contacts')),
    parties: per('parties'),
    deadlines: per('deadlines'),
    tasks: per('tasks'),
    events: per('events'),
    notes: per('notes'),
    fullLoadMatters: Math.min(matters, FULL_LOAD_MATTERS),
  };
  return {
    ...plan,
    total:
      1 + // the org
      accounts.length * 2 + // members and users
      plan.contacts +
      matters * 2 + // matters and their number reservations
      plan.parties +
      plan.deadlines +
      plan.tasks +
      plan.events +
      plan.notes +
      documents +
      timeEntries,
  };
}

export interface LargeOptions {
  now: Date;
  /** Today in the org's time zone. */
  today: D.DateOnly;
}

type Data = Record<string, unknown>;

/**
 * The practice's documents, one matter at a time. `onMatter` is called after each matter's records
 * (for progress). Deterministic for a given plan and `now`.
 */
export function* largeOrgDocs(plan: LargePlan, options: LargeOptions): Generator<SeedDoc> {
  const { orgId, accounts } = plan;
  const { now, today } = options;
  const rand = prng(20261007);
  const meta = (at: Date, uid = 'lg-owner') => ({
    createdAt: at,
    createdBy: uid,
    updatedAt: at,
    updatedBy: uid,
    schemaVersion: 1,
  });
  const doc = (path: string, data: Data): SeedDoc => ({ path, data: stripUndefined(data) });
  const timeZone = domain.DEFAULT_ORG_TIMEZONE;
  const month = domain.metricPeriods(today).month;
  const monthStart = `${today.slice(0, 7)}-01`;

  // ---------- the org, its people and reference data ----------

  yield doc(
    `orgs/${orgId}`,
    F.makeOrg({
      ...meta(new Date(now.getTime() - HISTORY_DAYS * DAY)),
      name: LARGE_ORG_NAME,
      timezone: timeZone,
      matterNumberFormat: 'AF-{YYYY}-{seq:4}',
      flags: {
        'templates.system': true,
        'deadlines.ruleset.vic.v1': true,
        'billing.invoicing': true,
        'billing.feeBudgets': true,
        'billing.disbursements': true,
        'clerk.enabled': true,
        'clerk.features.chat': true,
      },
      settings: { clerk: { ackVersion: domain.CLERK_DISCLOSURE_VERSION } },
    } as Partial<D.Org>) as unknown as Data,
  );
  const rates: Record<string, number> = {};
  for (const [i, account] of accounts.entries()) {
    const [firstName = account.displayName, lastName = ''] = account.displayName.split(' ');
    const rate = account.role === 'paralegal' ? 22_000 : account.role === 'readonly' ? 0 : 42_000 + (i % 5) * 2_000;
    rates[account.uid] = rate;
    yield doc(
      `orgs/${orgId}/members/${account.uid}`,
      F.makeMember({
        ...meta(now),
        role: account.role,
        status: 'active',
        email: account.email,
        displayName: account.displayName,
        initials: `${firstName[0] ?? ''}${lastName[0] ?? ''}`,
        title: account.role === 'paralegal' ? 'Paralegal' : account.role === 'readonly' ? 'Accounts' : 'Lawyer',
        defaultRateCents: rate as D.Cents,
        rates: rate ? [{ effectiveFrom: domain.dateOnly('2018-07-01'), rateCents: rate as D.Cents }] : [],
        colour: at(['#346CFC', '#0E9F8E', '#D97706', '#6B7280', '#B4235A'], i),
      }) as unknown as Data,
    );
    yield doc(
      `users/${account.uid}`,
      F.makeUser({
        ...meta(now),
        email: account.email,
        displayName: account.displayName,
        firstName,
        lastName,
        orgIds: [orgId],
        activeOrgId: orgId,
        memberships: { [orgId]: { role: account.role, name: LARGE_ORG_NAME } },
      }) as unknown as Data,
    );
  }
  const system = { createdAt: now, updatedAt: now, createdBy: 'system', updatedBy: 'system', schemaVersion: 1 };
  for (const calendar of deadlines.CALENDAR_YEARS)
    yield doc(`calendars/${deadlines.calendarDocId(calendar)}`, { ...deadlines.toCalendarDoc(calendar), ...system });
  const ruleSet = deadlines.VIC_RULESET_V1;
  yield doc(`ruleSets/${ruleSet.ruleSetId}/versions/${ruleSet.version}`, {
    ...deadlines.toRuleSetDoc(ruleSet),
    ...system,
  });

  // ---------- contacts ----------

  const contactIds: string[] = [];
  const contactNames: string[] = [];
  for (let i = 0; i < plan.contacts; i++) {
    const id = `c-lg-${String(i + 1).padStart(6, '0')}`;
    const givenNames = at(GIVEN, i);
    const familyName = at(FAMILY, Math.floor(i / GIVEN.length) + i * 7);
    const contact = F.makeContact({
      ...meta(new Date(now.getTime() - ((i * 7919) % HISTORY_DAYS) * DAY)),
      kind: 'person',
      givenNames,
      familyName,
      dateOfDeath: undefined,
      sortName: `${givenNames} ${familyName}`.toLowerCase(),
      dedupeKey: `person:${givenNames} ${familyName}|${i}`.toLowerCase(),
    });
    contactIds.push(id);
    contactNames.push(`${givenNames} ${familyName}`);
    yield doc(`orgs/${orgId}/contacts/${id}`, { ...contact, search: domain.contactSearchTokens(contact) });
  }

  // ---------- matters and their records ----------

  const runners = accounts.filter((a) => a.role === 'owner' || a.role === 'admin' || a.role === 'lawyer');
  const fullLoad = runners.find((a) => a.role === 'lawyer') ?? at(runners, 0);
  const others = runners.filter((a) => a !== fullLoad);
  const paralegals = accounts.filter((a) => a.role === 'paralegal');
  const types = domain.MatterTypeSchema.options;
  const seqByYear = new Map<number, number>();
  const recentByUid = new Map<string, { matterId: string; at: Date }[]>();
  const monthEntries: Data[] = [];

  const docProto = F.makeMatterDocument({ ...meta(now) });
  const timeProto = F.makeTimeEntry({ ...meta(now) });
  const taskProto = F.makeTask({ ...meta(now) });
  const deadlineProto = F.makeDeadline({ ...meta(now), computed: undefined, kind: 'internal' });
  const noteProto = F.makeNote({ ...meta(now), mentions: { uids: [], matterIds: [] } });

  for (let i = 0; i < plan.matters; i++) {
    const matterId = `m-lg-${String(i + 1).padStart(5, '0')}`;
    const path = `orgs/${orgId}/matters/${matterId}`;
    // Spread across the matters, whatever the order: every (matters ÷ full load)th is the first lawyer's.
    const mine = (i * 7919) % plan.matters < plan.fullLoadMatters || !others.length;
    const responsible = mine ? fullLoad : at(others, i);
    const paralegal = paralegals.length ? at(paralegals, i) : responsible;
    const ageDays = Math.floor(rand() * HISTORY_DAYS);
    const createdAt = new Date(now.getTime() - ageDays * DAY - Math.floor(rand() * DAY));
    const r = rand();
    const status: D.MatterStatus =
      ageDays < 30 && r < 0.1
        ? 'lead'
        : ageDays < 365
          ? r < 0.85
            ? 'open'
            : r < 0.9
              ? 'on_hold'
              : 'closed'
          : ageDays < 730
            ? r < 0.5
              ? 'open'
              : 'closed'
            : r < 0.1
              ? 'open'
              : r < 0.6
                ? 'closed'
                : 'archived';
    const live = status === 'open' || status === 'lead' || status === 'on_hold';
    const closedAt = live
      ? undefined
      : new Date(createdAt.getTime() + Math.floor(rand() * Math.min(ageDays, 400)) * DAY);
    const endAt = closedAt ?? now;
    const lastActivityAt = live ? new Date(now.getTime() - Math.floor(rand() * 30 * DAY) - i) : endAt;
    const type = at(types, i * 3 + Math.floor(i / 7));
    const year = Number(domain.dateOnlyAt(createdAt, timeZone).slice(0, 4));
    const seq = (seqByYear.get(year) ?? 0) + 1;
    seqByYear.set(year, seq);
    const number = domain.formatMatterNumber('AF-{YYYY}-{seq:4}', year, seq);
    const clientIndex = (i * 11) % contactIds.length;
    const clientId = at(contactIds, clientIndex);
    const clientName = at(contactNames, clientIndex);
    const otherIndex = (clientIndex + 1 + (i % 5)) % contactIds.length;
    const title = TITLE[type](clientName);
    const privileged = i % 25 === 0;
    const createdDay = domain.dateOnlyAt(createdAt, timeZone);
    const endDay = domain.dateOnlyAt(endAt, timeZone);
    const spanDays = Math.max(1, domain.daysBetween(createdDay, endDay));
    const by = responsible.uid;

    // Parties: the client, an executor and a beneficiary.
    for (const [role, contactId] of [
      ['client', clientId],
      ['executor', at(contactIds, otherIndex)],
      ['beneficiary', at(contactIds, otherIndex + 1)],
    ] as const) {
      yield doc(
        `${path}/parties/${domain.partyDocId(role, contactId)}`,
        F.makeParty({ ...meta(createdAt, by), orgId, matterId, contactId, role }) as unknown as Data,
      );
    }
    for (let e = 0; e < share(plan.events, plan.matters, i); e++) {
      yield doc(
        `${path}/events/ev-${e + 1}`,
        F.makeMatterEvent({
          ...meta(createdAt, by),
          kind: DECEASED_TYPES.has(type) ? 'date_of_death' : 'custom',
          ...(DECEASED_TYPES.has(type) ? {} : { label: 'Instructions received' }),
          date: domain.addDays(createdDay, -14),
          privileged,
        } as Partial<D.MatterEvent>) as unknown as Data,
      );
    }

    // Deadlines: upcoming on live matters (a few overdue), done on the rest.
    let next: { id: string; dueDate: D.DateOnly; title: string; critical: boolean } | undefined;
    for (let k = 0; k < share(plan.deadlines, plan.matters, i); k++) {
      const id = `dl-${k + 1}`;
      const critical = k === 0;
      const title = at(DEADLINE_TITLES, i + k);
      const dueDate = live
        ? domain.addDays(
            today,
            rand() < OVERDUE_DEADLINE_SHARE ? -1 - Math.floor(rand() * 20) : Math.floor(rand() * 200),
          )
        : domain.addDays(createdDay, Math.floor(rand() * spanDays));
      const deadline: Data = {
        ...deadlineProto,
        ...meta(createdAt, by),
        orgId,
        matterId,
        title,
        dueDate,
        kind: at(['internal', 'contractual', 'court'] as const, k),
        critical,
        status: live ? 'upcoming' : 'done',
        ...(live ? {} : { resolution: { on: dueDate, by, at: endAt } }),
        assigneeUid: by,
        privileged,
        deletedAt: null,
      };
      if (live && (!next || dueDate < next.dueDate)) next = { id, dueDate, title, critical };
      yield doc(`${path}/deadlines/${id}`, deadline);
    }

    // Tasks: on live matters about half open, due over the next four months (a few overdue).
    let openTasks = 0;
    for (let k = 0; k < share(plan.tasks, plan.matters, i); k++) {
      const open = live && rand() < 0.5;
      if (open) openTasks++;
      const title = at(TASK_TITLES, i * 3 + k);
      const dueDate = open
        ? domain.addDays(today, rand() < OVERDUE_TASK_SHARE ? -1 - Math.floor(rand() * 10) : Math.floor(rand() * 120))
        : domain.addDays(createdDay, Math.floor(rand() * spanDays));
      yield doc(`${path}/tasks/tk-${k + 1}`, {
        ...taskProto,
        ...meta(createdAt, by),
        orgId,
        matterId,
        title,
        status: open ? (k % 3 ? 'todo' : 'in_progress') : 'done',
        priority: at(['none', 'low', 'medium', 'high'] as const, k),
        dueDate,
        order: k + 1,
        assigneeUid: k % 2 ? paralegal.uid : by,
        countedOpen: open,
        ...(open ? {} : { completedAt: endAt }),
        search: domain.taskSearchTokens(title),
        deletedAt: null,
      });
    }

    for (let k = 0; k < share(plan.notes, plan.matters, i); k++) {
      yield doc(`${path}/notes/nt-${k + 1}`, {
        ...noteProto,
        ...meta(new Date(createdAt.getTime() + k * DAY), by),
        bodyMd: k ? 'Spoke with the executor about the timetable (fictional).' : 'Instructions received (fictional).',
      });
    }

    // Documents, uploaded over the matter's life.
    for (let k = 0; k < share(plan.documents, plan.matters, i); k++) {
      const id = `doc-${String(k + 1).padStart(4, '0')}`;
      const [category, label] = at(DOC_NAMES, i + k);
      const name = `${label} ${k + 1} (fictional).pdf`;
      const uploadedAt = new Date(createdAt.getTime() + Math.floor(rand() * spanDays) * DAY);
      const storagePath = `orgs/${orgId}/matters/${matterId}/documents/${id}/v1`;
      const sizeBytes = 20_000 + Math.floor(rand() * 2_000_000);
      const sha256 = (i * 1_000_003 + k).toString(16).padStart(64, '0');
      const pages = 1 + (k % 12);
      yield doc(`${path}/documents/${id}`, {
        ...docProto,
        ...meta(uploadedAt, by),
        orgId,
        matterId,
        name,
        category,
        storagePath,
        sizeBytes,
        sha256,
        pageCount: pages,
        privileged: privileged || undefined,
        versions: [
          {
            version: 1,
            storagePath,
            fileName: name,
            mime: 'application/pdf',
            sizeBytes,
            sha256,
            uploadedAt,
            uploadedBy: by,
            pageCount: pages,
          },
        ],
        ingest: { status: 'done', pages },
        search: domain.documentSearchTokens(name),
        deletedAt: null,
      });
    }

    // Time: mostly the responsible lawyer's, some the paralegal's, over the matter's life.
    let wipCents = 0;
    for (let k = 0; k < share(plan.timeEntries, plan.matters, i); k++) {
      const author = rand() < 0.7 ? responsible : paralegal;
      const date = domain.addDays(createdDay, Math.floor(rand() * (spanDays + 1)));
      const age = domain.daysBetween(date, today);
      const minutes = 6 * (1 + Math.floor(rand() * 15));
      const units = minutes / 6;
      const rateCents = rates[author.uid] ?? 0;
      const amountCents = Math.round((rateCents * units) / 10);
      const billable = rand() < 0.9;
      const s = rand();
      const status: D.TimeEntry['status'] = !live
        ? s < 0.9
          ? 'billed'
          : 'written_off'
        : age > 60
          ? s < 0.7
            ? 'billed'
            : s < 0.9
              ? 'final'
              : 'draft'
          : s < 0.5
            ? 'draft'
            : 'final';
      const wip = billable && (status === 'draft' || status === 'final') ? amountCents : 0;
      wipCents += wip;
      const entry: Data = {
        ...timeProto,
        ...meta(new Date(Math.min(now.getTime(), Date.parse(`${date}T06:00:00Z`))), author.uid),
        orgId,
        matterId,
        uid: author.uid,
        date,
        minutes,
        units,
        rateCents,
        amountCents,
        narrative: at(NARRATIVES, i + k),
        billable,
        status,
        wipCountedCents: wip,
        deletedAt: null,
      };
      if (date >= monthStart) monthEntries.push(entry);
      yield doc(`${path}/timeEntries/te-${String(k + 1).padStart(5, '0')}`, entry);
    }

    const matter = F.makeMatter({
      ...meta(createdAt, by),
      updatedAt: lastActivityAt,
      number,
      title,
      type,
      status,
      priority: at(['none', 'none', 'low', 'medium', 'high', 'urgent'] as const, i * 3),
      jurisdiction: 'VIC',
      responsibleUid: by,
      teamUids: paralegal === responsible ? [by] : [by, paralegal.uid],
      clientContactIds: [clientId],
      deceased: DECEASED_TYPES.has(type)
        ? {
            contactId: at(contactIds, clientIndex + 2),
            dateOfDeath: domain.addDays(createdDay, -14),
            domicile: 'VIC',
            lastAddress: '1 Example Street, Geelong VIC 3220',
          }
        : undefined,
      fee: { arrangement: type === 'will' || type === 'poa' ? 'fixed' : 'hourly', history: [] },
      costsDisclosure: { status: type === 'will' ? 'not_required' : 'sent' },
      conflictCheck: { status: status === 'lead' ? 'pending' : 'clear' },
      privileged,
      labels: i % 9 === 0 ? ['referral'] : [],
      search: domain.matterSearchTokens({ number, title, clientNames: [clientName] }),
      nextDeadline: next,
      openTaskCount: openTasks,
      wipCents: wipCents as D.Cents,
      lastActivityAt,
      ...(closedAt ? { closedAt, closeReason: 'Matter completed' } : {}),
      ...(status === 'archived' ? { archivedAt: new Date(endAt.getTime() + 90 * DAY) } : {}),
    });
    yield doc(path, { ...matter, deletedAt: null });
    yield doc(
      `orgs/${orgId}/matterNumbers/${domain.matterNumberKey(number)}`,
      F.makeMatterNumber({ ...meta(createdAt, by), number, matterId, year }) as unknown as Data,
    );
    for (const uid of new Set([by, paralegal.uid])) {
      const list = recentByUid.get(uid) ?? [];
      if (live) list.push({ matterId, at: lastActivityAt });
      list.sort((a, b) => b.at.getTime() - a.at.getTime());
      recentByUid.set(uid, list.slice(0, 10));
    }
  }

  // ---------- counters, recent matters and this month's rollups ----------

  for (const [year, seq] of seqByYear) {
    yield doc(
      `orgs/${orgId}/counters/${domain.matterCounterId(year)}`,
      F.makeCounter({ ...meta(now), next: seq + 1 }) as unknown as Data,
    );
  }
  for (const [uid, list] of recentByUid) {
    for (const entry of list) {
      yield doc(`users/${uid}/recent/${domain.recentEntryId(orgId, { kind: 'matter', matterId: entry.matterId })}`, {
        ...meta(entry.at, uid),
        orgId,
        kind: 'matter',
        matterId: entry.matterId,
        expireAt: domain.recentMatterExpireAt(entry.at),
      });
    }
  }
  // INS-01's rollups for this month (what the metrics triggers would have written): the org's and
  // each member's time figures, so screens that read them see the generated time.
  const rollups = domain.rollupMetrics(
    monthEntries.map((entry) => domain.timeEntryMetrics(entry)),
    7,
    (period) => period === month,
  );
  for (const [key, values] of rollups) {
    const { period, uid } = domain.splitMetricsKey(key);
    yield doc(`orgs/${orgId}/metrics/${key}`, { ...meta(now, 'system'), period, ...(uid ? { uid } : {}), values });
  }
}

/** The plan as a table, for the console. */
export function describePlan(plan: LargePlan): string {
  const row = (label: string, value: number) => `  ${label.padEnd(22)}${value.toLocaleString('en-AU').padStart(12)}`;
  return [
    `Large practice "${LARGE_ORG_NAME}" (${plan.orgId}) at scale ${plan.scale}:`,
    row('members', plan.accounts.length),
    row('matters', plan.matters),
    row('documents (records)', plan.documents),
    row('time entries', plan.timeEntries),
    row('contacts', plan.contacts),
    row('parties', plan.parties),
    row('deadlines', plan.deadlines),
    row('tasks', plan.tasks),
    row('events', plan.events),
    row('notes', plan.notes),
    row('first lawyer’s matters', plan.fullLoadMatters),
    row('documents written', plan.total),
  ].join('\n');
}
