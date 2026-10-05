import {
  canRestoreMatter,
  canTransition,
  ChangeMatterStatusInput,
  CreateMatterInput,
  DEFAULT_MATTER_TYPE_CODES,
  DEFAULT_MATTER_VIEWS,
  formatMatterNumber,
  initialMatterStatus,
  isIndexedMatterQuery,
  isMatterLink,
  isMatterNumberFormat,
  MATTER_INDEXED_QUERIES,
  MATTER_RESTORE_WINDOW_DAYS,
  MATTER_SORT_ORDER_FIELD,
  MATTER_TRANSITIONS,
  matterCounterId,
  matterIndexFields,
  matterNumberFormatProblem,
  matterNumberKey,
  matterNumberProblem,
  matterNumberYear,
  matterSearchTokens,
  matterTypeCode,
  normaliseMatterLink,
  RenumberMatterInput,
  RestoreMatterInput,
  transitionRequirements,
} from './matters';
import { Matter } from './schemas/contacts-matters';
import { MatterStatusSchema } from './schemas/enums';
import { SavedView } from './schemas/views';

describe('matter numbers', () => {
  it.each([
    ['M-{YYYY}-{seq:4}', 2026, 7, 'M-2026-0007'],
    ['M-{YYYY}-{seq:4}', 2026, 12345, 'M-2026-12345'],
    ['{YY}/{seq:3}', 2027, 42, '27/042'],
    ['HP{seq}', 2026, 3, 'HP3'],
    ['no sequence', 2026, 5, 'M-2026-0005'],
    ['{seq}-{bogus}', 2026, 5, 'M-2026-0005'],
  ])('%s, %i, %i → %s', (format, year, seq, expected) => {
    expect(formatMatterNumber(format, year, seq)).toBe(expected);
  });

  it('validates formats', () => {
    expect(isMatterNumberFormat('M-{YYYY}-{seq:4}')).toBe(true);
    expect(isMatterNumberFormat('M-{YYYY}')).toBe(false);
    expect(isMatterNumberFormat('{seq}{x}')).toBe(false);
  });

  it('fills {TYPE} with the type code (CORE-21a)', () => {
    expect(formatMatterNumber('{TYPE}{YY}-{seq:3}', 2026, 7, 'PRB')).toBe('PRB26-007');
    expect(formatMatterNumber('{TYPE}-{seq}', 2026, 7)).toBe('-7');
    expect(isMatterNumberFormat('{TYPE}/{YYYY}/{seq:4}')).toBe(true);
    expect(matterTypeCode('probate')).toBe(DEFAULT_MATTER_TYPE_CODES.probate);
    expect(matterTypeCode('probate', { probate: 'PROB' })).toBe('PROB');
    expect(matterTypeCode('probate', { probate: 'not valid!' })).toBe('PRB');
    expect(matterTypeCode('will', { probate: 'PROB' })).toBe('WIL');
  });

  it('explains what is wrong with a format', () => {
    expect(matterNumberFormatProblem('{TYPE}-{YYYY}-{seq:4}')).toBeNull();
    expect(matterNumberFormatProblem('  ')).toMatch(/Enter/);
    expect(matterNumberFormatProblem('M-{YYYY}')).toMatch(/\{seq\}/);
    expect(matterNumberFormatProblem('{seq}{CLIENT}')).toMatch(/Use only/);
    expect(matterNumberFormatProblem('{seq}}')).toMatch(/Use only/);
    expect(matterNumberFormatProblem(`${'x'.repeat(40)}{seq}`)).toMatch(/longer/);
  });

  it('checks typed numbers', () => {
    expect(matterNumberProblem('3E-104233')).toBeNull();
    expect(matterNumberProblem(' ')).toMatch(/Enter/);
    expect(matterNumberProblem('x'.repeat(41))).toMatch(/40/);
    expect(matterNumberProblem('a\nb')).toMatch(/letters/);
    const requestId = '00000000-0000-4000-8000-000000000000';
    expect(RenumberMatterInput.parse({ requestId, matterId: 'm1', number: ' A-1 ' }).number).toBe('A-1');
    expect(RenumberMatterInput.safeParse({ requestId, matterId: 'm1', number: '' }).success).toBe(false);
  });

  it('accepts only http(s) matter links', () => {
    expect(isMatterLink('https://3e.example.com/matters/104233')).toBe(true);
    expect(isMatterLink('http://intranet/3e?m=1')).toBe(true);
    expect(isMatterLink('javascript:alert(1)')).toBe(false);
    expect(isMatterLink('https://a b')).toBe(false);
    expect(isMatterLink('')).toBe(false);
    expect(isMatterLink(undefined)).toBe(false);
    expect(normaliseMatterLink(' 3e.example.com/m/1 ')).toBe('https://3e.example.com/m/1');
    expect(normaliseMatterLink('https://3e.example.com/m/1')).toBe('https://3e.example.com/m/1');
    expect(normaliseMatterLink('javascript:alert(1)')).toBeNull();
    expect(normaliseMatterLink('not a link')).toBeNull();
    expect(normaliseMatterLink('')).toBeNull();
  });

  it('rolls the year over at midnight in Melbourne, not UTC', () => {
    // 2026-12-31T13:00Z is 00:00 on 1 January 2027 in Melbourne (AEDT, UTC+11).
    expect(matterNumberYear(new Date('2026-12-31T12:59:59Z'))).toBe(2026);
    expect(matterNumberYear(new Date('2026-12-31T13:00:00Z'))).toBe(2027);
    expect(matterNumberYear(new Date('2026-12-31T13:00:00Z'), 'Australia/Perth')).toBe(2026);
    expect(matterCounterId(2027)).toBe('matter-2027');
  });
});

describe('status machine', () => {
  const statuses = MatterStatusSchema.options;
  const allowed = new Set([
    'lead→open',
    'open→on_hold',
    'on_hold→open',
    'open→closed',
    'closed→open',
    'closed→archived',
  ]);

  it.each(statuses.flatMap((from) => statuses.map((to) => [from, to] as const)))('%s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(allowed.has(`${from}→${to}`));
  });

  it('lists exactly the six allowed transitions', () => {
    const count = Object.values(MATTER_TRANSITIONS).reduce((sum, targets) => sum + targets.length, 0);
    expect(count).toBe(allowed.size);
  });

  it('needs an openable conflict determination to open a lead and a reason to reopen', () => {
    expect(transitionRequirements('lead', 'open')).toEqual(['conflict_openable']);
    expect(transitionRequirements('closed', 'open')).toEqual(['reason']);
    expect(transitionRequirements('open', 'closed')).toEqual([]);
    expect(initialMatterStatus('clear')).toBe('open');
    expect(initialMatterStatus('potential')).toBe('open');
    expect(initialMatterStatus('conflict')).toBe('lead');
    expect(initialMatterStatus('pending')).toBe('lead');
    expect(initialMatterStatus(undefined)).toBe('lead');
  });
});

describe('matter search tokens', () => {
  it('indexes the number with and without separators, title, names and external ref', () => {
    const tokens = matterSearchTokens({
      number: 'M-2026-0007',
      title: 'Estate of Nguyễn',
      clientNames: ["Patrick O'Brien"],
      deceasedName: 'Thi Mai Nguyễn',
      externalRef: 'LEG/481',
    });
    expect(tokens).toEqual(
      expect.arrayContaining(['m2026', 'm20260007', '2026', '0007', 'estate', 'nguyen', 'obrien', 'leg', 'leg481']),
    );
  });
});

describe('matter inputs and views', () => {
  it('lets clients edit only the whitelisted fields', () => {
    expect(Object.keys(Matter.update.shape).sort()).toEqual(
      [
        'deceased',
        'estate',
        'externalRef',
        'externalUrl',
        'facts',
        'labels',
        'priority',
        'privileged',
        'responsibleUid',
        'teamUids',
        'title',
      ].sort(),
    );
  });

  it('keeps number and status out of the create input', () => {
    expect(Object.keys(CreateMatterInput.shape.matter.shape)).not.toContain('status');
    expect(Object.keys(CreateMatterInput.shape.matter.shape)).not.toContain('number');
    expect(
      ChangeMatterStatusInput.safeParse({ requestId: crypto.randomUUID(), matterId: 'm1', to: 'paused' }).success,
    ).toBe(false);
  });

  it('defines the five default views, with My open matters first', () => {
    expect(DEFAULT_MATTER_VIEWS.map((view) => view.name)).toEqual([
      'My open matters',
      'All open',
      'Leads',
      'On hold',
      'Recently closed',
    ]);
    for (const view of DEFAULT_MATTER_VIEWS) {
      const { filters, sort, groupBy, name } = view;
      expect(SavedView.create.safeParse({ orgId: 'o1', list: 'matters', name, filters, sort, groupBy }).success).toBe(
        true,
      );
    }
  });
});

describe('matter number keys', () => {
  it('are case-insensitive and always valid document ids', () => {
    expect(matterNumberKey('M-2026-0007')).toBe('M-2026-0007');
    expect(matterNumberKey(' m-2026-0007 ')).toBe('M-2026-0007');
    expect(matterNumberKey('27/042')).toBe('27%2F042');
    expect(matterNumberKey('..')).toBe('%2E%2E');
    expect(matterNumberKey('__X__')).toBe('%5F%5FX%5F%5F');
    expect(matterNumberKey('27/042')).not.toContain('/');
  });
});

describe('indexed list queries', () => {
  it('matches filters in any order, with the order field and direction', () => {
    expect(isIndexedMatterQuery([], 'lastActivityAt', 'desc')).toBe(true);
    expect(isIndexedMatterQuery(['responsibleUid', 'status'], 'lastActivityAt', 'desc')).toBe(true);
    expect(isIndexedMatterQuery(['status', 'status'], 'number', 'asc')).toBe(true);
    expect(isIndexedMatterQuery(['jurisdiction', 'status'], 'lastActivityAt', 'desc')).toBe(true);
    expect(isIndexedMatterQuery(['labels'], 'lastActivityAt', 'desc')).toBe(true);
    expect(isIndexedMatterQuery(['labels', 'search'], 'lastActivityAt', 'desc')).toBe(false);
    expect(isIndexedMatterQuery(['responsibleUid'], 'title', 'asc')).toBe(false);
    expect(isIndexedMatterQuery(['status'], 'lastActivityAt', 'asc')).toBe(false);
  });

  it('covers the combinations the ticket asks for, with no duplicates', () => {
    for (const [filters, orderBy] of [
      [['status'], 'lastActivityAt'],
      [['status', 'responsibleUid'], 'lastActivityAt'],
      [['status', 'type'], 'lastActivityAt'],
      [['responsibleUid'], 'lastActivityAt'],
      [['status'], 'number'],
      [['status'], 'title'],
      [['labels'], 'lastActivityAt'],
      [['jurisdiction', 'status'], 'lastActivityAt'],
    ] as const) {
      expect(isIndexedMatterQuery(filters, orderBy, orderBy === 'lastActivityAt' ? 'desc' : 'asc')).toBe(true);
    }
    const keys = MATTER_INDEXED_QUERIES.map((q) => `${[...q.filters].sort().join(',')}|${q.orderBy}|${q.dir}`);
    expect(new Set(keys).size).toBe(keys.length);
    // At most one array-contains per query (a Firestore limit).
    for (const query of MATTER_INDEXED_QUERIES) {
      expect(query.filters.filter((f) => f === 'labels' || f === 'search').length).toBeLessThanOrEqual(1);
    }
  });

  it('builds index fields: deletedAt, optional privileged, filters, then the order field', () => {
    expect(matterIndexFields({ filters: ['labels', 'status'], orderBy: 'lastActivityAt', dir: 'desc' }, true)).toEqual([
      { fieldPath: 'deletedAt', order: 'ASCENDING' },
      { fieldPath: 'privileged', order: 'ASCENDING' },
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: 'labels', arrayConfig: 'CONTAINS' },
      { fieldPath: 'lastActivityAt', order: 'DESCENDING' },
    ]);
    expect(matterIndexFields({ filters: [], orderBy: 'title', dir: 'asc' }, false)).toEqual([
      { fieldPath: 'deletedAt', order: 'ASCENDING' },
      { fieldPath: 'title', order: 'ASCENDING' },
    ]);
  });

  it('maps saved-view sorts to order fields', () => {
    expect(MATTER_SORT_ORDER_FIELD.lastActivity).toBe('lastActivityAt');
    expect(MATTER_SORT_ORDER_FIELD.wip).toBeUndefined();
  });
});

describe('restore', () => {
  it(`allows a restore for ${MATTER_RESTORE_WINDOW_DAYS} days after the delete`, () => {
    const deletedAt = new Date('2026-10-01T00:00:00Z');
    expect(canRestoreMatter(deletedAt, new Date('2026-10-31T00:00:00Z'))).toBe(true);
    expect(canRestoreMatter(deletedAt, new Date('2026-10-31T00:00:01Z'))).toBe(false);
  });

  it('validates the input', () => {
    expect(RestoreMatterInput.safeParse({ requestId: crypto.randomUUID(), matterId: 'm1' }).success).toBe(true);
    expect(RestoreMatterInput.safeParse({ requestId: 'x', matterId: 'm1' }).success).toBe(false);
  });
});
