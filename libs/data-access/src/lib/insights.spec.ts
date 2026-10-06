import { dateOnly, isIndexedMatterQuery } from '@materia/domain';

import {
  deadlinesDueQuery,
  INSIGHTS_DRILL_LIMIT,
  openedInPeriod,
  openedMattersQuery,
  type OpenedMatter,
} from './insights';

/** INS-02: the queries behind an Insights drill-down, and which matters count as opened in a period. */

const JULY = { start: dateOnly('2026-07-01'), end: dateOnly('2026-07-31') };

const matter = (createdAt: string, extra: Partial<OpenedMatter> = {}): OpenedMatter => ({
  number: 'M-2026-0101',
  title: 'Estate of Ivy Hale',
  type: 'probate',
  status: 'open',
  responsibleUid: 'user-jordan',
  privileged: false,
  createdAt: new Date(createdAt),
  deletedAt: null,
  ...extra,
});

describe('Insights drill-down queries', () => {
  it('reads a type’s matters a day either side of the period, on an indexed query', () => {
    const spec = openedMattersQuery('probate', JULY.start, JULY.end, { privilegedVisible: false });
    expect(spec.where).toEqual([
      ['deletedAt', '==', null],
      ['privileged', '==', false],
      ['type', '==', 'probate'],
      ['createdAt', '>=', new Date('2026-06-30T00:00:00Z')],
      ['createdAt', '<', new Date('2026-08-02T00:00:00Z')],
    ]);
    expect(spec.orderBy).toEqual([['createdAt', 'asc']]);
    expect(spec.pageSize).toBe(INSIGHTS_DRILL_LIMIT);
    // firestore.indexes.json has it, with and without the privileged filter (firebase/tests/indexes.spec.ts).
    expect(isIndexedMatterQuery(['type'], 'createdAt', 'asc')).toBe(true);
    const all = openedMattersQuery('probate', JULY.start, JULY.end, { privilegedVisible: true });
    expect(all.where?.map(([field]) => field)).not.toContain('privileged');
  });

  it('counts a matter opened on the period’s days in the firm’s time zone, not a lead or a deleted one', () => {
    const zone = 'Australia/Melbourne';
    // 1 July, 9:30 am in Melbourne.
    expect(openedInPeriod(matter('2026-06-30T23:30:00Z'), JULY.start, JULY.end, zone)).toBe(true);
    // 30 June, 9:30 am in Melbourne: the FY before.
    expect(openedInPeriod(matter('2026-06-29T23:30:00Z'), JULY.start, JULY.end, zone)).toBe(false);
    // 1 August in Melbourne, still 31 July in UTC.
    expect(openedInPeriod(matter('2026-07-31T15:00:00Z'), JULY.start, JULY.end, zone)).toBe(false);
    expect(openedInPeriod(matter('2026-07-10T01:00:00Z', { status: 'lead' }), JULY.start, JULY.end, zone)).toBe(false);
    expect(openedInPeriod(matter('2026-07-10T01:00:00Z', { deletedAt: new Date() }), JULY.start, JULY.end, zone)).toBe(
      false,
    );
  });

  it('reads deadlines in a status due in the period', () => {
    expect(deadlinesDueQuery('done', JULY.start, JULY.end)).toEqual({
      where: [
        ['status', '==', 'done'],
        ['dueDate', '>=', '2026-07-01'],
        ['dueDate', '<=', '2026-07-31'],
      ],
      orderBy: [['dueDate', 'asc']],
      pageSize: INSIGHTS_DRILL_LIMIT,
    });
  });
});
