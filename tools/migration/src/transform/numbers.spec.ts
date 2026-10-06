import { domain } from '../domain.ts';
import { FIXTURE_DIR, FIXTURE_UIDS } from '../legacy/fixtures.ts';
import { loadProfile, type MappingProfile } from '../profile.ts';
import { migId, Warnings, type TransformContext, type TransformedRecord, type WarningCode } from './context.ts';
import { allocateNumbers, type NumberBase, type NumberCard } from './numbers.ts';

const AS_OF = new Date('2026-10-06T21:00:00.123Z');
const BOARD = 'workflows/0b6f1c2e-5d4a-4c3b-9a8e-111111111111/cards';

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadProfile(`${FIXTURE_DIR}mapping-profile.json`);
});

function makeCtx(over: Partial<TransformContext> = {}): TransformContext {
  return {
    runId: 'run1',
    uid: FIXTURE_UIDS.subject,
    orgId: 'org1',
    profile,
    timeZone: 'Australia/Melbourne',
    asOf: AS_OF,
    people: new Map(),
    members: new Set([FIXTURE_UIDS.subject]),
    warnings: new Warnings(),
    ...over,
  };
}

const allocating = () => makeCtx({ profile: { ...profile, matterNumbers: 'allocate' } });

function warned(ctx: TransformContext): Partial<Record<WarningCode, string[]>> {
  return Object.fromEntries(
    Object.entries(ctx.warnings.summary())
      .filter(([, entry]) => entry.count > 0)
      .map(([code, entry]) => [code, entry.paths]),
  );
}

function numberCard(id: string, createdAt: string, reference = ''): NumberCard {
  const path = `${BOARD}/${id}`;
  return { path, matterId: migId(path), createdAt: new Date(createdAt), reference };
}

/** Card id → its number. */
function numbersById(cards: readonly NumberCard[], numbers: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries(cards.map((card) => [card.path.slice(BOARD.length + 1), numbers.get(card.matterId) ?? '']));
}

const byEntity = (records: readonly TransformedRecord[], entity: TransformedRecord['entity']) =>
  records.filter((record) => record.entity === entity);

const plain = {
  createdAt: AS_OF,
  createdBy: 'migration',
  updatedAt: AS_OF,
  updatedBy: 'migration',
  schemaVersion: 1,
};

describe('allocateNumbers', () => {
  it('numbers matters M-{YYYY}-{seq:4} by the year they were opened, in the order they were created', () => {
    const ctx = allocating();
    const cards = [
      numberCard('C', '2025-03-01T00:00:00Z'),
      numberCard('A', '2025-01-10T00:30:00Z'),
      numberCard('B', '2024-06-01T00:00:00Z'),
      numberCard('D', '2025-02-01T00:00:00Z'),
    ];
    const { numbers } = allocateNumbers(ctx, cards);
    expect(numbersById(cards, numbers)).toEqual({
      C: 'M-2025-0003',
      A: 'M-2025-0001',
      B: 'M-2024-0001',
      D: 'M-2025-0002',
    });
    expect(warned(ctx)).toEqual({});
  });

  it('reads the year in Melbourne: a card created 2024-12-31T14:00:00Z opened in 2025', () => {
    const cards = [numberCard('A', '2024-12-31T14:00:00Z'), numberCard('B', '2024-12-31T12:59:59Z')];
    const { numbers } = allocateNumbers(allocating(), cards);
    expect(numbersById(cards, numbers)).toEqual({ A: 'M-2025-0001', B: 'M-2024-0001' });
  });

  it('orders cards created at the same instant by path', () => {
    const cards = [
      numberCard('Zeta', '2025-01-10T00:30:00Z'),
      numberCard('Alpha', '2025-01-10T00:30:00Z'),
      numberCard('Mid', '2025-01-10T00:30:00Z'),
    ];
    const { numbers } = allocateNumbers(allocating(), cards);
    expect(numbersById(cards, numbers)).toEqual({ Alpha: 'M-2025-0001', Mid: 'M-2025-0002', Zeta: 'M-2025-0003' });
  });

  it('gives the same numbers whatever order the cards come in', () => {
    const cards = [
      numberCard('A', '2025-01-10T00:30:00Z', 'HV-1'),
      numberCard('B', '2025-01-10T00:30:00Z'),
      numberCard('C', '2024-01-10T00:30:00Z'),
    ];
    const forward = allocateNumbers(makeCtx(), cards).numbers;
    const backward = allocateNumbers(makeCtx(), [...cards].reverse()).numbers;
    expect(Object.fromEntries(backward)).toEqual(Object.fromEntries(forward));
  });

  it('writes a reservation per number and a counter per year', () => {
    const ctx = allocating();
    const cards = [
      numberCard('A', '2025-01-10T00:30:00Z'),
      numberCard('B', '2024-06-01T00:00:00Z'),
      numberCard('C', '2025-03-01T00:00:00Z'),
    ];
    const { records } = allocateNumbers(ctx, cards);
    expect(byEntity(records, 'matter-numbers')).toEqual([
      {
        entity: 'matter-numbers',
        path: 'orgs/org1/matterNumbers/M-2025-0001',
        legacyPath: cards[0]?.path,
        data: { number: 'M-2025-0001', matterId: cards[0]?.matterId, year: 2025, ...plain },
      },
      {
        entity: 'matter-numbers',
        path: 'orgs/org1/matterNumbers/M-2024-0001',
        legacyPath: cards[1]?.path,
        data: { number: 'M-2024-0001', matterId: cards[1]?.matterId, year: 2024, ...plain },
      },
      {
        entity: 'matter-numbers',
        path: 'orgs/org1/matterNumbers/M-2025-0002',
        legacyPath: cards[2]?.path,
        data: { number: 'M-2025-0002', matterId: cards[2]?.matterId, year: 2025, ...plain },
      },
    ]);
    expect(byEntity(records, 'counters')).toEqual([
      {
        entity: 'counters',
        path: 'orgs/org1/counters/matter-2024',
        legacyPath: 'numbers#matter-2024',
        data: { next: 2, ...plain },
      },
      {
        entity: 'counters',
        path: 'orgs/org1/counters/matter-2025',
        legacyPath: 'numbers#matter-2025',
        data: { next: 3, ...plain },
      },
    ]);
    for (const record of byEntity(records, 'matter-numbers')) {
      expect(domain.MatterNumberSchema.parse(record.data)).toEqual(record.data);
    }
    for (const record of byEntity(records, 'counters')) {
      expect(domain.CounterSchema.parse(record.data)).toEqual(record.data);
    }
  });

  it('gives nothing for no cards', () => {
    expect(allocateNumbers(makeCtx(), [])).toEqual({ numbers: new Map(), records: [] });
  });

  describe('adopt_reference_when_unique', () => {
    it('adopts a reference used once as the number', () => {
      const ctx = makeCtx();
      const cards = [numberCard('A', '2025-01-10T00:30:00Z', 'EST/77'), numberCard('B', '2025-01-11T00:30:00Z')];
      const { numbers, records } = allocateNumbers(ctx, cards);
      expect(numbersById(cards, numbers)).toEqual({ A: 'EST/77', B: 'M-2025-0001' });
      const [adopted] = byEntity(records, 'matter-numbers');
      // The key is case-folded and URI-encoded, so a `/` still makes a document id.
      expect(adopted?.path).toBe('orgs/org1/matterNumbers/EST%2F77');
      expect(adopted?.data).toMatchObject({ number: 'EST/77', matterId: cards[0]?.matterId, year: 2025 });
      expect(byEntity(records, 'counters').map((record) => record.data?.['next'])).toEqual([2]);
      expect(warned(ctx)).toEqual({});
    });

    it('allocates both of a reference that repeats in another case, with a warning', () => {
      const ctx = makeCtx();
      const cards = [
        numberCard('A', '2025-01-10T00:30:00Z', 'HV-1'),
        numberCard('B', '2025-01-11T00:30:00Z', 'hv-1'),
        numberCard('C', '2025-01-12T00:30:00Z', 'HV-2'),
      ];
      const { numbers } = allocateNumbers(ctx, cards);
      expect(numbersById(cards, numbers)).toEqual({ A: 'M-2025-0001', B: 'M-2025-0002', C: 'HV-2' });
      expect(warned(ctx)).toEqual({ MIG_W_MATTER_REFERENCE_DUPLICATE: [cards[0]?.path, cards[1]?.path] });
    });

    it('skips a format number an adopted reference already holds', () => {
      const cards = [
        numberCard('A', '2025-01-10T00:30:00Z'),
        numberCard('B', '2025-01-11T00:30:00Z', 'm-2025-0002'),
        numberCard('C', '2025-01-12T00:30:00Z'),
        numberCard('D', '2025-01-13T00:30:00Z'),
      ];
      const { numbers, records } = allocateNumbers(makeCtx(), cards);
      expect(numbersById(cards, numbers)).toEqual({
        A: 'M-2025-0001',
        B: 'm-2025-0002',
        C: 'M-2025-0003',
        D: 'M-2025-0004',
      });
      expect(byEntity(records, 'counters').map((record) => record.data?.['next'])).toEqual([5]);
      const paths = byEntity(records, 'matter-numbers').map((record) => record.path);
      expect(new Set(paths).size).toBe(paths.length);
    });

    it.each([
      ['a control character', 'HV\u0001-7'],
      ['more than 40 characters', 'R'.repeat(41)],
    ])('allocates a reference with %s', (_, reference) => {
      const ctx = makeCtx();
      const cards = [numberCard('A', '2025-01-10T00:30:00Z', reference)];
      expect(numbersById(cards, allocateNumbers(ctx, cards).numbers)).toEqual({ A: 'M-2025-0001' });
      expect(warned(ctx)).toEqual({});
    });

    it('allocates a card with no reference', () => {
      const cards = [numberCard('A', '2025-01-10T00:30:00Z', '')];
      expect(numbersById(cards, allocateNumbers(makeCtx(), cards).numbers)).toEqual({ A: 'M-2025-0001' });
    });

    it("takes the adopted number's year from when the card was opened", () => {
      const cards = [numberCard('A', '2024-12-31T14:00:00Z', 'OLD-9')];
      const [reservation] = byEntity(allocateNumbers(makeCtx(), cards).records, 'matter-numbers');
      expect(reservation?.data).toMatchObject({ number: 'OLD-9', year: 2025 });
      // Nothing was allocated, so no counter moves.
      expect(byEntity(allocateNumbers(makeCtx(), cards).records, 'counters')).toEqual([]);
    });
  });

  describe('allocate', () => {
    it('never adopts a reference, and still reports repeats', () => {
      const ctx = allocating();
      const cards = [
        numberCard('A', '2025-01-10T00:30:00Z', 'EST/77'),
        numberCard('B', '2025-01-11T00:30:00Z', 'HV-1'),
        numberCard('C', '2025-01-12T00:30:00Z', 'hv-1'),
      ];
      const { numbers } = allocateNumbers(ctx, cards);
      expect(numbersById(cards, numbers)).toEqual({ A: 'M-2025-0001', B: 'M-2025-0002', C: 'M-2025-0003' });
      expect(warned(ctx)).toEqual({ MIG_W_MATTER_REFERENCE_DUPLICATE: [cards[1]?.path, cards[2]?.path] });
    });
  });

  describe('a delta on a base run', () => {
    const kept = numberCard('Kept', '2025-01-10T00:30:00Z', 'HV-1');
    const keptAllocated = numberCard('KeptAllocated', '2025-01-11T00:30:00Z');
    const base: NumberBase = {
      numbers: new Map([
        [kept.matterId, { number: 'HV-1', year: 2025 }],
        [keptAllocated.matterId, { number: 'M-2025-0001', year: 2025 }],
      ]),
      counters: new Map([
        [2025, 2],
        [2024, 4],
      ]),
    };

    it("keeps the base run's numbers, without writing their reservations again", () => {
      const fresh = numberCard('New', '2025-03-01T00:00:00Z');
      const { numbers, records } = allocateNumbers(makeCtx(), [kept, keptAllocated, fresh], base);
      expect(numbersById([kept, keptAllocated, fresh], numbers)).toEqual({
        Kept: 'HV-1',
        KeptAllocated: 'M-2025-0001',
        New: 'M-2025-0002',
      });
      expect(byEntity(records, 'matter-numbers').map((record) => record.legacyPath)).toEqual([fresh.path]);
    });

    it("continues the base run's counters, and leaves out the ones that didn't move", () => {
      const fresh = numberCard('New', '2025-03-01T00:00:00Z');
      const newYear = numberCard('NewYear', '2026-03-01T00:00:00Z');
      const { records } = allocateNumbers(makeCtx(), [kept, fresh, newYear], base);
      expect(byEntity(records, 'counters').map((record) => [record.path, record.data?.['next']])).toEqual([
        ['orgs/org1/counters/matter-2025', 3],
        ['orgs/org1/counters/matter-2026', 2],
      ]);
    });

    it("never reuses a base number's key, adopting or allocating", () => {
      const ctx = makeCtx();
      const cards = [
        numberCard('Takes', '2025-03-01T00:00:00Z', 'm-2025-0001'),
        numberCard('Next', '2025-03-02T00:00:00Z'),
      ];
      // A base whose counter lags behind its own numbers still can't give one out twice.
      const lagging: NumberBase = { numbers: base.numbers, counters: new Map([[2025, 1]]) };
      const { numbers } = allocateNumbers(ctx, cards, lagging);
      expect(numbersById(cards, numbers)).toEqual({ Takes: 'M-2025-0002', Next: 'M-2025-0003' });
      expect(warned(ctx)).toEqual({});
    });

    it("treats a new card repeating a kept card's reference as a repeat", () => {
      const ctx = makeCtx();
      const fresh = numberCard('Again', '2025-03-01T00:00:00Z', 'hv-1');
      const { numbers } = allocateNumbers(ctx, [kept, fresh], base);
      expect(numbers.get(fresh.matterId)).toBe('M-2025-0002');
      expect(warned(ctx)).toEqual({ MIG_W_MATTER_REFERENCE_DUPLICATE: [fresh.path] });
    });

    it('writes nothing when every card was numbered by the base run', () => {
      const { numbers, records } = allocateNumbers(makeCtx(), [kept, keptAllocated], base);
      expect(numbers.size).toBe(2);
      expect(records).toEqual([]);
    });
  });
});
