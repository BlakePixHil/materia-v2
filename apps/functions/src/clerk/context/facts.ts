import {
  formatCents,
  NOT_THE_TRUST_LEDGER,
  trustSnapshotOutOfDate,
  type Cents,
  type ContextManifest,
  type DateOnly,
} from '@materia/domain';

import { FACT_LIMITS } from './policy';
import type { Row } from './ports';

/**
 * The matter facts block (AI-03): the matter summary, key facts, parties, events, upcoming
 * deadlines with their traces, open tasks and the fee summary, as compact JSON. Field picks are
 * explicit, so server-only fields (search tokens, email tokens, legacy billing) never reach the
 * model. Dates stay `YYYY-MM-DD`; money is formatted as dollars.
 */

type Data = Record<string, unknown>;
type ManifestRecord = ContextManifest['records'][number];

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
const money = (value: unknown): string | undefined =>
  typeof value === 'number' ? formatCents(value as Cents) : undefined;
const obj = (value: unknown): Data | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : undefined;

/** Drops undefined values and empty objects or arrays, so the JSON stays compact. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Data = {};
    for (const [key, inner] of Object.entries(value as Data)) {
      const next = compact(inner);
      if (next === undefined || next === null) continue;
      if (Array.isArray(next) && next.length === 0) continue;
      if (typeof next === 'object' && !Array.isArray(next) && Object.keys(next as Data).length === 0) continue;
      out[key] = next;
    }
    return out as T;
  }
  return value;
}

/** An instant (Firestore Timestamp or Date) as ISO 8601, for the manifest. */
export function isoOf(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  const toDate = (value as { toDate?: () => Date } | undefined)?.toDate;
  return typeof toDate === 'function' ? toDate.call(value).toISOString() : undefined;
}

/** A manifest entry for a record: its kind, id and `updatedAt` when it has one. */
export function recordOf(kind: ManifestRecord['kind'], row: Row): ManifestRecord {
  const at = isoOf(row.data['updatedAt']);
  return { kind, id: row.id, ...(at ? { at } : {}) };
}

const isDeleted = (data: Data) => data['deletedAt'] !== undefined && data['deletedAt'] !== null;
const live = (rows: readonly Row[]) => rows.filter((row) => !isDeleted(row.data));

/** Ascending by an optional date; rows without one go last. */
const byDate = (field: string) => (a: Row, b: Row) => {
  const left = str(a.data[field]) ?? '9999-99-99';
  const right = str(b.data[field]) ?? '9999-99-99';
  return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
};

export interface FactsInput {
  matter: Row;
  parties: readonly Row[];
  contactNames: ReadonlyMap<string, string>;
  events: readonly Row[];
  deadlines: readonly Row[];
  tasks: readonly Row[];
  /** The trust balance snapshot, only for roles with `billing.view` while the display is on (BILL-11). */
  trust?: { snapshot: Row; staleAfterDays: number; today: DateOnly } | null;
  /** The matter's responsible lawyer (`responsibleUid`), when they are an active member. */
  responsible?: { name: string; title?: string | undefined } | null;
}

export interface Facts {
  json: Data;
  records: ManifestRecord[];
}

/** The facts block's JSON and the records it includes. */
export function matterFacts(input: FactsInput): Facts {
  const m = input.matter.data;
  const records: ManifestRecord[] = [recordOf('matter', input.matter)];
  const name = (contactId: unknown) => (typeof contactId === 'string' ? input.contactNames.get(contactId) : undefined);

  const deceased = obj(m['deceased']);
  const estate = obj(m['estate']);
  const dispute = obj(m['dispute']);
  const disclosure = obj(m['costsDisclosure']);
  const nextDeadline = obj(m['nextDeadline']);
  const summary = {
    id: input.matter.id,
    number: str(m['number']),
    title: str(m['title']),
    type: str(m['type']),
    status: str(m['status']),
    stage: str(m['stageId']),
    jurisdiction: str(m['jurisdiction']),
    priority: m['priority'] === 'none' ? undefined : str(m['priority']),
    privileged: m['privileged'] === true ? true : undefined,
    responsibleLawyer: input.responsible ? { name: input.responsible.name, title: input.responsible.title } : undefined,
    labels: Array.isArray(m['labels']) ? m['labels'].filter((label) => typeof label === 'string') : undefined,
    clients: Array.isArray(m['clientContactIds']) ? m['clientContactIds'].map(name).filter(Boolean) : undefined,
    deceased: deceased && {
      name: name(deceased['contactId']),
      dateOfDeath: str(deceased['dateOfDeath']) ?? 'unknown',
      domicile: str(deceased['domicile']),
      lastAddress: str(deceased['lastAddress']),
    },
    testator: name(obj(m['testator'])?.['contactId']),
    estate: estate && {
      grossValue: money(estate['grossValueCents']),
      netValue: money(estate['netValueCents']),
      grantType: str(estate['grantType']),
      grantDate: str(estate['grantDate']),
      grantNo: str(estate['grantNo']),
      hasMainResidence: typeof estate['hasMainResidence'] === 'boolean' ? estate['hasMainResidence'] : undefined,
    },
    keyFacts: obj(m['facts']) && {
      willDate: str(obj(m['facts'])?.['willDate']),
      courtFileNo: str(obj(m['facts'])?.['courtFileNo']),
      trustName: str(obj(m['facts'])?.['trustName']),
    },
    dispute: dispute && { kind: str(dispute['kind']) },
    costsDisclosure: disclosure && {
      status: str(disclosure['status']),
      sentOn: str(disclosure['sentOn']),
      estimate: money(disclosure['estimateCents']),
    },
    nextDeadline: nextDeadline && { title: str(nextDeadline['title']), dueDate: str(nextDeadline['dueDate']) },
    openTaskCount: num(m['openTaskCount']),
  };

  const parties = live(input.parties)
    .slice(0, FACT_LIMITS.parties)
    .map((row) => {
      records.push(recordOf('party', row));
      return {
        id: row.id,
        name: name(row.data['contactId']) ?? 'Unknown contact',
        role: str(row.data['role']),
        share: str(row.data['share']),
      };
    });

  const events = live(input.events)
    .sort((a, b) => -byDate('date')(a, b))
    .slice(0, FACT_LIMITS.events)
    .map((row) => {
      records.push(recordOf('event', row));
      return { id: row.id, kind: str(row.data['kind']), date: str(row.data['date']), label: str(row.data['label']) };
    });

  const deadlines = live(input.deadlines)
    .filter((row) => row.data['status'] === 'upcoming' || row.data['status'] === 'blocked')
    .sort(byDate('dueDate'))
    .slice(0, FACT_LIMITS.deadlines)
    .map((row) => {
      records.push(recordOf('deadline', row));
      const computed = obj(row.data['computed']);
      const override = obj(row.data['override']);
      return {
        id: row.id,
        title: str(row.data['title']),
        dueDate: str(row.data['dueDate']),
        status: str(row.data['status']),
        critical: row.data['critical'] === true ? true : undefined,
        kind: str(row.data['kind']),
        blockedReason: str(row.data['blockedReason']),
        overriddenTo: override ? str(override['dueDate']) : undefined,
        rule: computed && {
          citation: str(computed['citation']),
          explain: str(computed['explain']),
          trace: Array.isArray(computed['trace'])
            ? computed['trace'].filter((line) => typeof line === 'string')
            : undefined,
          approximate: computed['approximate'] === true ? true : undefined,
        },
      };
    });

  const tasks = live(input.tasks)
    .filter((row) => ['todo', 'in_progress', 'blocked'].includes(row.data['status'] as string))
    .sort(byDate('dueDate'))
    .slice(0, FACT_LIMITS.tasks)
    .map((row) => {
      records.push(recordOf('task', row));
      return {
        id: row.id,
        title: str(row.data['title']),
        status: str(row.data['status']),
        dueDate: str(row.data['dueDate']),
        duePending: str(row.data['duePending']),
        priority: row.data['priority'] === 'none' ? undefined : str(row.data['priority']),
      };
    });

  const trust = input.trust ? trustFacts(input.trust) : undefined;
  if (trust && input.trust) records.push(recordOf('trust', input.trust.snapshot));

  return {
    json: compact({
      matter: summary,
      fee: feeSummary(m),
      trustBalance: trust,
      parties,
      events,
      deadlines,
      openTasks: tasks,
    }) as Data,
    records,
  };
}

/**
 * The trust balance as Clerk may quote it (ADR-035): only with its as-at date and source, and the
 * reminder that it is a copy, not the trust ledger. Never a basis for a withdrawal or transfer.
 */
export function trustFacts(input: { snapshot: Row; staleAfterDays: number; today: DateOnly }): Data | undefined {
  const s = input.snapshot.data;
  const asAt = str(s['asAt']);
  const held = money(s['amountCents']);
  if (!asAt || !held) return undefined;
  return {
    held,
    asAt,
    from: str(s['sourceSystemName']) ?? 'the firm’s trust records',
    outOfDate: trustSnapshotOutOfDate(asAt as DateOnly, input.today, input.staleAfterDays) ? true : undefined,
    note: `${NOT_THE_TRUST_LEDGER}: a balance copied by hand from the firm's trust records as at that date. Quote the as-at date and source with it, say it isn't the trust ledger, and never suggest a withdrawal or transfer.`,
  };
}

/** The fee arrangement and money position, or undefined when the matter records none. */
export function feeSummary(m: Data): Data | undefined {
  const fee = obj(m['fee']);
  const budget = obj(m['budget']);
  const summary = compact({
    arrangement: str(fee?.['arrangement']),
    amount: money(fee?.['amountCents']),
    cap: money(fee?.['capCents']),
    estimate: money(fee?.['estimateCents']),
    rateOverride: money(fee?.['rateOverrideCents']),
    conditionalUpliftPct: num(obj(fee?.['conditional'])?.['upliftPct']),
    workInProgress: m['wipCents'] ? money(m['wipCents']) : undefined,
    budgetUsedPct: num(budget?.['pct']),
  });
  return Object.keys(summary).length ? summary : undefined;
}
