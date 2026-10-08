import * as D from '@materia/domain';

import { makeMatter, makeMatterNumber } from './factories';

/**
 * A deterministic load of fictional matters for performance work (CORE-03: "500 seeded matters,
 * first paint under 1 s"): varied type, status, responsible, labels, priority, jurisdiction and
 * last activity, each schema-valid, with its number reservation. Used by the seed's `load`
 * scenario and by e2e tests that write it into their own org. Every name is invented.
 */
export interface LoadMattersOptions {
  orgId: string;
  /** How many matters (default 500). */
  count?: number;
  /** The newest last activity; the rest spread over the 180 days before it. */
  now: Date;
  /** Number format (default the org default) and the year and first sequence number to use. */
  format?: string;
  year: number;
  firstSeq?: number;
  /** Who the matters are spread across (responsible and team). */
  uids: readonly string[];
  /** Existing contacts to use as clients (at least one). */
  clientContactIds: readonly string[];
  /** Display names of those contacts, for the search tokens (optional). */
  contactNames?: Readonly<Record<string, string>>;
  /** Document id prefix (default `m-load-`). */
  idPrefix?: string;
}

export interface LoadDoc {
  path: string;
  data: Record<string, unknown>;
}

export interface LoadMatters {
  matters: LoadDoc[];
  reservations: LoadDoc[];
  /** The counter's `next` after these numbers. */
  nextSeq: number;
}

const GIVEN = ['Ada', 'Bertram', 'Clementine', 'Desmond', 'Edith', 'Fergus', 'Gwendolyn', 'Horace', 'Imogen', 'Jasper'];
const FAMILY = [
  'Quill',
  'Fernsby',
  'Ashcombe',
  'Thistlewood',
  'Marrow',
  'Pennyfeather',
  'Lockhart',
  'Bramble',
  'Wexley',
  'Oakhurst',
  'Tumbleton',
  'Harrowgate',
];
const LABELS = ['urgent', 'referral', 'interstate', 'court', 'vip'];
/** Weighted: most matters are open. */
const STATUSES: readonly D.MatterStatus[] = [
  'open',
  'open',
  'open',
  'open',
  'open',
  'lead',
  'on_hold',
  'closed',
  'closed',
  'archived',
];
const PRIORITIES: readonly D.Priority[] = ['none', 'none', 'low', 'medium', 'high', 'urgent'];
const JURISDICTIONS: readonly D.Jurisdiction[] = ['VIC', 'VIC', 'VIC', 'VIC', 'NSW', 'QLD'];
const HOUR = 3_600_000;

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

const at = <T>(list: readonly T[], index: number): T => list[index % list.length] as T;

export function buildLoadMatters(options: LoadMattersOptions): LoadMatters {
  const count = options.count ?? 500;
  const format = options.format ?? D.DEFAULT_MATTER_NUMBER_FORMAT;
  const firstSeq = options.firstSeq ?? 1;
  const prefix = options.idPrefix ?? 'm-load-';
  if (!options.uids.length || !options.clientContactIds.length)
    throw new Error('uids and clientContactIds are required');
  const types = D.MatterTypeSchema.options;
  const matters: LoadDoc[] = [];
  const reservations: LoadDoc[] = [];

  for (let i = 0; i < count; i++) {
    const id = `${prefix}${String(i + 1).padStart(4, '0')}`;
    const number = D.formatMatterNumber(format, options.year, firstSeq + i);
    const type = at(types, i * 3 + Math.floor(i / 7));
    const status = at(STATUSES, i * 7 + 3);
    const name = `${at(GIVEN, i)} ${at(FAMILY, Math.floor(i / GIVEN.length) + i)}`;
    const title = TITLE[type](name);
    const responsibleUid = at(options.uids, i * 5 + 1);
    const clientId = at(options.clientContactIds, i * 11);
    const labels = LABELS.filter((_, l) => (i * 13 + l * 7) % 9 === 0);
    // Spread over 180 days, newest first for low i, with no two the same.
    const lastActivityAt = new Date(options.now.getTime() - ((i * 7919) % (180 * 24)) * HOUR - i * 1000);
    const createdAt = new Date(lastActivityAt.getTime() - 30 * 24 * HOUR);
    const closed = status === 'closed' || status === 'archived';
    const clientName = options.contactNames?.[clientId];
    const meta = { createdAt, createdBy: responsibleUid, updatedAt: lastActivityAt, updatedBy: responsibleUid };
    const data = makeMatter({
      ...meta,
      number,
      title,
      type,
      status,
      priority: at(PRIORITIES, i * 3),
      jurisdiction: at(JURISDICTIONS, i),
      responsibleUid,
      teamUids: [responsibleUid],
      clientContactIds: [clientId],
      deceased: undefined,
      fee: { arrangement: type === 'will' || type === 'poa' ? 'fixed' : 'hourly', history: [] },
      costsDisclosure: { status: type === 'will' ? 'not_required' : 'sent' },
      conflictCheck: { status: status === 'lead' ? 'pending' : 'clear' },
      privileged: i % 25 === 0,
      labels,
      // Without names, the Matters list reads the contacts, as for a matter written before SEC-07d.
      ...(options.contactNames ? { clientNames: clientName ? [clientName] : [] } : {}),
      search: D.matterSearchTokens({ number, title, clientNames: clientName ? [clientName] : [] }),
      lastActivityAt,
      ...(closed ? { closedAt: lastActivityAt, closeReason: 'Matter completed' } : {}),
    });
    // Live matters carry deletedAt: null, as matters-createMatter writes them (the list filters on it).
    matters.push({ path: `orgs/${options.orgId}/matters/${id}`, data: { ...data, deletedAt: null } });
    reservations.push({
      path: `orgs/${options.orgId}/matterNumbers/${D.matterNumberKey(number)}`,
      data: makeMatterNumber({ ...meta, number, matterId: id, year: options.year }) as unknown as Record<
        string,
        unknown
      >,
    });
  }
  return { matters, reservations, nextSeq: firstSeq + count };
}
