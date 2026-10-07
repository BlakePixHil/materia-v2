import { domain } from '../domain.ts';
import { plainMeta, type TransformContext, type TransformedRecord } from './context.ts';
import { byCodeUnit } from '../export/jsonl.ts';

const {
  DEFAULT_MATTER_NUMBER_FORMAT,
  formatMatterNumber,
  matterCounterId,
  matterNumberKey,
  matterNumberProblem,
  matterNumberYear,
} = domain;

/**
 * Matter numbers (D-08, CORE-03). Every matter gets a v2 number: `M-{YYYY}-{seq:4}` by the year
 * it was opened (in the org's time zone), in the order the cards were created, so re-running a
 * run gives every matter the same number. Under `adopt_reference_when_unique` a card's legacy
 * reference becomes its number when no other card shares it (case aside) and it is a valid
 * number; a shared one is allocated (`MIG_W_MATTER_REFERENCE_DUPLICATE`). Either way the reference
 * stays the matter's `externalRef`.
 *
 * The numbers come with what `matters-createMatter` keeps beside them: a reservation per number
 * (`orgs/{O}/matterNumbers/{key}`) and each year's counter (`orgs/{O}/counters/matter-{YYYY}`),
 * so matters created in v2 after the load continue the sequence. A delta run keeps the numbers its
 * base run gave (`base`) and continues after its counters.
 */

export interface NumberCard {
  /** The card's legacy path. */
  path: string;
  matterId: string;
  createdAt: Date;
  /** The legacy `matterReference`, trimmed; empty for none. */
  reference: string;
}

/** What a base run allocated, for a delta: numbers by matter id, and each year's counter. */
export interface NumberBase {
  numbers: ReadonlyMap<string, { number: string; year: number }>;
  counters: ReadonlyMap<number, number>;
}

export interface NumbersResult {
  /** Matter id → number. */
  numbers: Map<string, string>;
  /** The reservations and counters for the numbers this run gave. */
  records: TransformedRecord[];
}

export function allocateNumbers(
  ctx: TransformContext,
  cards: readonly NumberCard[],
  base: NumberBase = { numbers: new Map(), counters: new Map() },
): NumbersResult {
  const numbers = new Map<string, string>();
  const years = new Map<string, number>();
  const taken = new Set<string>();
  for (const { number } of base.numbers.values()) taken.add(matterNumberKey(number));

  const fresh: NumberCard[] = [];
  for (const card of cards) {
    const kept = base.numbers.get(card.matterId);
    if (kept) {
      numbers.set(card.matterId, kept.number);
      years.set(card.matterId, kept.year);
    } else fresh.push(card);
  }

  // References that occur once (case aside) may become numbers.
  const uses = new Map<string, number>();
  for (const card of cards) {
    if (card.reference) uses.set(matterNumberKey(card.reference), (uses.get(matterNumberKey(card.reference)) ?? 0) + 1);
  }
  const ordered = [...fresh].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || byCodeUnit(a.path, b.path),
  );
  const toAllocate: NumberCard[] = [];
  for (const card of ordered) {
    const key = card.reference ? matterNumberKey(card.reference) : '';
    const repeated = key !== '' && (uses.get(key) ?? 0) > 1;
    if (repeated) ctx.warnings.add('MIG_W_MATTER_REFERENCE_DUPLICATE', card.path);
    const adopt =
      ctx.profile.matterNumbers === 'adopt_reference_when_unique' &&
      key !== '' &&
      !repeated &&
      !taken.has(key) &&
      matterNumberProblem(card.reference) === null;
    if (adopt) {
      numbers.set(card.matterId, card.reference);
      years.set(card.matterId, matterNumberYear(card.createdAt, ctx.timeZone));
      taken.add(key);
    } else toAllocate.push(card);
  }

  // The rest: the next free number in the year each was opened, skipping adopted ones.
  const next = new Map<number, number>(base.counters);
  for (const card of toAllocate) {
    const year = matterNumberYear(card.createdAt, ctx.timeZone);
    let seq = next.get(year) ?? 1;
    let number = formatMatterNumber(DEFAULT_MATTER_NUMBER_FORMAT, year, seq);
    while (taken.has(matterNumberKey(number))) number = formatMatterNumber(DEFAULT_MATTER_NUMBER_FORMAT, year, ++seq);
    numbers.set(card.matterId, number);
    years.set(card.matterId, year);
    taken.add(matterNumberKey(number));
    next.set(year, seq + 1);
  }

  const records: TransformedRecord[] = [];
  for (const card of cards) {
    if (base.numbers.has(card.matterId)) continue;
    const number = numbers.get(card.matterId) as string;
    const key = matterNumberKey(number);
    records.push({
      entity: 'matter-numbers',
      path: `orgs/${ctx.orgId}/matterNumbers/${key}`,
      legacyPath: card.path,
      data: { number, matterId: card.matterId, year: years.get(card.matterId) as number, ...plainMeta(ctx) },
    });
  }
  for (const [year, value] of next) {
    if (base.counters.get(year) === value) continue;
    const id = matterCounterId(year);
    records.push({
      entity: 'counters',
      path: `orgs/${ctx.orgId}/counters/${id}`,
      legacyPath: `numbers#${id}`,
      data: { next: value, ...plainMeta(ctx) },
    });
  }
  return { numbers, records };
}
