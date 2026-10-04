import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { dateOnly } from '@materia/domain';

import { groupByDay, MtTimeline, type TimelineItemVm, timeOfDay } from './timeline';
import { MT_TODAY } from '../pipes/format';

const TZ = 'Australia/Melbourne';
// 2026-10-02T23:30Z is 3 Oct 9:30 am in Melbourne (AEST+10, before daylight saving starts on 4 Oct).
const ITEMS: TimelineItemVm[] = [
  {
    id: '1',
    kind: 'email',
    title: 'Email from executor',
    at: new Date('2026-10-02T23:30:00Z'),
    detail: 'Catherine Whitfield',
  },
  { id: '2', kind: 'clerk', title: 'Clerk drafted the notice', at: new Date('2026-10-02T22:00:00Z') },
  {
    id: '3',
    kind: 'deadline',
    title: 'File probate summons',
    at: '2026-10-16',
    state: 'next',
    code: 'UCPR r 78.3',
    deadline: { due: dateOnly('2026-10-16') },
  },
  { id: '4', kind: 'note', title: 'Undated note', at: null },
];

describe('timeline helpers', () => {
  it('groups consecutive items by org-timezone day', () => {
    const groups = groupByDay(ITEMS, TZ);
    expect(groups.map((g) => [g.day, g.items.map((i) => i.id)])).toEqual([
      ['2026-10-03', ['1', '2']],
      ['2026-10-16', ['3']],
      [null, ['4']],
    ]);
  });

  it('formats the time of day for instants only', () => {
    expect(timeOfDay(new Date('2026-10-02T23:30:00Z'), TZ)).toBe('9:30 am');
    expect(timeOfDay({ toDate: () => new Date('2026-10-02T23:30:00Z') }, TZ)).toBe('9:30 am');
    expect(timeOfDay('2026-10-16', TZ)).toBe('');
    expect(timeOfDay(null, TZ)).toBe('');
    expect(timeOfDay(new Date('nope'), TZ)).toBe('');
  });
});

describe('MtTimeline', () => {
  const providers = [{ provide: MT_TODAY, useValue: () => dateOnly('2026-10-03') }];

  it('renders day groups, kinds, rule codes and deadlines, and emits loadMore', async () => {
    const loadMore = vi.fn();
    const { container } = await render(MtTimeline, {
      inputs: { items: ITEMS, hasMore: true },
      providers,
      on: { loadMore },
    });
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Undated' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Today' })).toHaveTextContent('Email: Email from executor');
    expect(screen.getByText('UCPR r 78.3').tagName).toBe('CODE');
    expect(container.querySelector('[data-kind="clerk"]')).not.toBeNull();
    expect(container.querySelector('[data-state="next"]')).not.toBeNull();
    expect(screen.getByText(/Catherine Whitfield · 9:30 am/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(loadMore).toHaveBeenCalled();
  });

  it('can render ungrouped, and shows the empty slot', async () => {
    const { rerender } = await render(MtTimeline, { inputs: { items: ITEMS.slice(2, 3), grouped: false }, providers });
    expect(screen.queryByRole('heading')).toBeNull();
    await rerender({ inputs: { items: [], grouped: false }, partialUpdate: true });
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
