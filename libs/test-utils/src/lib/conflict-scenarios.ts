import * as D from '@materia/domain';

import { makeContact, makeMatter, makeMatterNumber, makeParty } from './factories';

/**
 * Conflict-check scenarios (CORE-02): fictional contacts, matters and party rows, and ten checks
 * with the hits they must produce. Five are adverse (a hit whose role is adverse to the subject's
 * once `conflicts.enforced` is on) and five benign (no hits, or hits with no adverse role). The
 * seed's default scenario writes them into Harbour & Vine Legal, and the functions integration
 * test writes them into its own orgs and runs every check through `conflicts-run`. Every name,
 * ABN and matter here is invented.
 */
export interface ConflictFixtureOptions {
  orgId: string;
  /** Responsible lawyer and author of every document. */
  uid: string;
  now: Date;
  /** Number format (default the org default) and the year and first sequence number to use. */
  format?: string;
  year: number;
  firstSeq?: number;
}

export interface ConflictFixtureDoc {
  path: string;
  data: Record<string, unknown>;
}

export interface ExpectedConflictHit {
  contactId: string;
  viaMergedContactId?: string;
  matters: { matterId: string; role: D.PartyRole; status: D.MatterStatus; adverse: boolean }[];
}

export interface ConflictScenario {
  name: string;
  kind: 'adverse' | 'benign';
  subjects: D.ConflictSubject[];
  /** With `conflicts.enforced` on. With it off, the same hits and no `adverse`. */
  expected: ExpectedConflictHit[];
}

export interface ConflictFixture {
  docs: ConflictFixtureDoc[];
  scenarios: ConflictScenario[];
  /** The counter's `next` after these matters' numbers. */
  nextSeq: number;
}

type ContactSpec = { id: string; given?: string; family?: string; org?: string; abn?: string; mergedInto?: string };

/** Contact ids, all prefixed `c-cf-` so they never collide with the rest of the seed. */
export const CONFLICT_CONTACTS = {
  juniper: 'c-cf-juniper-ashdown',
  wren: 'c-cf-wren-halloway',
  ingrid: 'c-cf-ingrid-marchetti',
  lucan: 'c-cf-lucan-ferrow',
  dorothea: 'c-cf-dorothea-quint',
  fenella: 'c-cf-fenella-ames',
  fenellaOld: 'c-cf-fenella-brightwater',
  barnaby: 'c-cf-barnaby-stroud',
  cosima: 'c-cf-cosima-pell',
  tidewater: 'c-cf-tidewater-lawyers',
} as const;

export const CONFLICT_MATTERS = {
  probate: 'm-cf-halloway-estate',
  will: 'm-cf-marchetti-will',
  trust: 'm-cf-ferrow-trust',
  contest: 'm-cf-quint-contest',
  fp: 'm-cf-stroud-fp',
  fpClosed: 'm-cf-pell-fp',
} as const;

const C = CONFLICT_CONTACTS;
const M = CONFLICT_MATTERS;
const TIDEWATER_ABN = '51824753556';

const CONTACTS: ContactSpec[] = [
  { id: C.juniper, given: 'Juniper', family: 'Ashdown' },
  { id: C.wren, given: 'Wren', family: 'Halloway' },
  { id: C.ingrid, given: 'Ingrid', family: 'Marchetti' },
  { id: C.lucan, given: 'Lucan', family: 'Ferrow' },
  { id: C.dorothea, given: 'Dorothea', family: 'Quint' },
  { id: C.fenella, given: 'Fenella', family: 'Ames' },
  // Fenella's earlier record, merged into her current one (CORE-01 merge tombstone).
  { id: C.fenellaOld, given: 'Fenella', family: 'Brightwater', mergedInto: C.fenella },
  { id: C.barnaby, given: 'Barnaby', family: 'Stroud' },
  { id: C.cosima, given: 'Cosima', family: 'Pell' },
  { id: C.tidewater, org: 'Tidewater Lawyers Pty Ltd (fictional)', abn: TIDEWATER_ABN },
];

interface MatterSpec {
  id: string;
  title: string;
  type: D.MatterType;
  status: D.MatterStatus;
  client: string;
  parties: [contactId: string, role: D.PartyRole][];
}

const MATTERS: MatterSpec[] = [
  {
    id: M.probate,
    title: 'Estate of Ambrose Halloway',
    type: 'probate',
    status: 'open',
    client: C.juniper,
    parties: [
      [C.juniper, 'client'],
      [C.wren, 'beneficiary'],
    ],
  },
  {
    id: M.will,
    title: 'Ingrid Marchetti — will',
    type: 'will',
    status: 'open',
    client: C.ingrid,
    parties: [[C.ingrid, 'client']],
  },
  {
    id: M.trust,
    title: 'Ferrow Family Trust',
    type: 'trust',
    status: 'open',
    client: C.juniper,
    parties: [
      [C.juniper, 'client'],
      [C.lucan, 'plaintiff'],
    ],
  },
  {
    id: M.contest,
    title: 'Ames v Quint',
    type: 'contest',
    status: 'open',
    client: C.juniper,
    parties: [
      [C.juniper, 'client'],
      [C.dorothea, 'defendant'],
      [C.fenella, 'plaintiff'],
    ],
  },
  {
    id: M.fp,
    title: 'Stroud family provision claim',
    type: 'fp',
    status: 'on_hold',
    client: C.juniper,
    parties: [
      [C.juniper, 'client'],
      [C.barnaby, 'plaintiff'],
      [C.tidewater, 'other_side_solicitor'],
    ],
  },
  {
    id: M.fpClosed,
    title: 'Pell family provision claim',
    type: 'fp',
    status: 'closed',
    client: C.juniper,
    parties: [
      [C.juniper, 'client'],
      [C.cosima, 'plaintiff'],
    ],
  },
];

export const CONFLICT_SCENARIOS: readonly ConflictScenario[] = [
  // Benign
  {
    name: 'a stranger has no hits',
    kind: 'benign',
    subjects: [{ name: 'Peregrine Oakhollow', role: 'client' }],
    expected: [],
  },
  {
    name: 'a beneficiary of another estate named executor is not adverse',
    kind: 'benign',
    subjects: [{ name: 'Wren Halloway', role: 'executor' }],
    expected: [
      { contactId: C.wren, matters: [{ matterId: M.probate, role: 'beneficiary', status: 'open', adverse: false }] },
    ],
  },
  {
    name: 'an existing client coming back is not adverse',
    kind: 'benign',
    subjects: [{ name: 'Ingrid Marchetti', role: 'client' }],
    expected: [
      { contactId: C.ingrid, matters: [{ matterId: M.will, role: 'client', status: 'open', adverse: false }] },
    ],
  },
  {
    name: 'a relative with the same family name is not a hit',
    kind: 'benign',
    subjects: [{ name: 'Ottilie Halloway', role: 'client' }],
    expected: [],
  },
  {
    name: 'executor against a plaintiff outside a claim matter is not adverse',
    kind: 'benign',
    subjects: [{ name: 'Lucan Ferrow', role: 'executor' }],
    expected: [
      { contactId: C.lucan, matters: [{ matterId: M.trust, role: 'plaintiff', status: 'open', adverse: false }] },
    ],
  },
  // Adverse
  {
    name: 'a new client who is a defendant in a contest',
    kind: 'adverse',
    subjects: [{ name: 'Dorothea Quint', role: 'client' }],
    expected: [
      { contactId: C.dorothea, matters: [{ matterId: M.contest, role: 'defendant', status: 'open', adverse: true }] },
    ],
  },
  {
    name: 'a new client under a former name who is a plaintiff (merged contact)',
    kind: 'adverse',
    subjects: [{ name: 'Fenella Brightwater', role: 'client' }],
    expected: [
      {
        contactId: C.fenella,
        viaMergedContactId: C.fenellaOld,
        matters: [{ matterId: M.contest, role: 'plaintiff', status: 'open', adverse: true }],
      },
    ],
  },
  {
    name: 'an executor against a family provision plaintiff',
    kind: 'adverse',
    subjects: [{ name: 'Barnaby Stroud', role: 'executor' }],
    expected: [
      { contactId: C.barnaby, matters: [{ matterId: M.fp, role: 'plaintiff', status: 'on_hold', adverse: true }] },
    ],
  },
  {
    name: 'a beneficiary who was a plaintiff on a closed claim',
    kind: 'adverse',
    subjects: [{ name: 'Cosima Pell', role: 'beneficiary' }],
    expected: [
      { contactId: C.cosima, matters: [{ matterId: M.fpClosed, role: 'plaintiff', status: 'closed', adverse: true }] },
    ],
  },
  {
    name: 'a new client firm that is the other side’s solicitor',
    kind: 'adverse',
    subjects: [
      { kind: 'organisation', name: 'Tidewater Lawyers Pty Ltd (fictional)', abn: '51 824 753 556', role: 'client' },
    ],
    expected: [
      {
        contactId: C.tidewater,
        matters: [{ matterId: M.fp, role: 'other_side_solicitor', status: 'on_hold', adverse: true }],
      },
    ],
  },
];

/** Removes `undefined` values (optional fields the factories leave unset), which Firestore rejects. */
function strip<T>(value: T): T {
  if (Array.isArray(value)) return value.map(strip) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, strip(v)]),
    ) as T;
  }
  return value;
}

export function buildConflictFixture(options: ConflictFixtureOptions): ConflictFixture {
  const { orgId, uid, now, year } = options;
  const format = options.format ?? D.DEFAULT_MATTER_NUMBER_FORMAT;
  let seq = options.firstSeq ?? 1;
  const meta = { createdAt: now, createdBy: uid, updatedAt: now, updatedBy: uid };
  const docs: ConflictFixtureDoc[] = [];
  const add = (path: string, data: unknown) => docs.push({ path, data: strip(data) as Record<string, unknown> });
  const names = new Map<string, string>();

  for (const spec of CONTACTS) {
    const person = !spec.org;
    const fields = {
      kind: person ? ('person' as const) : ('organisation' as const),
      givenNames: spec.given,
      familyName: spec.family,
      orgName: spec.org,
      abn: spec.abn,
    };
    names.set(spec.id, D.contactDisplayName(fields));
    add(`orgs/${orgId}/contacts/${spec.id}`, {
      ...makeContact({
        ...meta,
        ...fields,
        dateOfDeath: undefined,
        emails: [],
        phones: [],
        addresses: [],
        tags: ['conflict scenario'],
        ...D.contactDerivedFields(fields),
        ...(spec.mergedInto ? { mergedInto: spec.mergedInto } : {}),
      }),
      deletedAt: null,
    });
  }

  for (const spec of MATTERS) {
    const number = D.formatMatterNumber(format, year, seq++);
    const closed = spec.status === 'closed' || spec.status === 'archived';
    const clientName = names.get(spec.client);
    add(
      `orgs/${orgId}/matterNumbers/${D.matterNumberKey(number)}`,
      makeMatterNumber({ ...meta, number, matterId: spec.id, year }),
    );
    add(`orgs/${orgId}/matters/${spec.id}`, {
      ...makeMatter({
        ...meta,
        number,
        title: spec.title,
        type: spec.type,
        status: spec.status,
        jurisdiction: 'VIC',
        responsibleUid: uid,
        teamUids: [uid],
        clientContactIds: [spec.client],
        deceased: undefined,
        fee: { arrangement: 'hourly', history: [] },
        costsDisclosure: { status: 'sent' },
        conflictCheck: { status: 'clear', checkedAt: now, checkedBy: uid },
        search: D.matterSearchTokens({ number, title: spec.title, clientNames: clientName ? [clientName] : [] }),
        lastActivityAt: now,
        ...(closed ? { closedAt: now, closeReason: 'Matter completed' } : {}),
      }),
      deletedAt: null,
    });
    spec.parties.forEach(([contactId, role], i) =>
      add(
        `orgs/${orgId}/matters/${spec.id}/parties/${spec.id}-p-${i + 1}`,
        makeParty({ ...meta, orgId, matterId: spec.id, contactId, role }),
      ),
    );
  }
  return { docs, scenarios: [...CONFLICT_SCENARIOS], nextSeq: seq };
}
