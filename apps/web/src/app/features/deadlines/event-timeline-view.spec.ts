import type { DeadlineItem, MatterEventItem, WithId } from '@materia/data-access/repository';
import type { DateOnly } from '@materia/domain';

import { dayMonth, eventAxis, linkedTimeline, rememberEventsView, storedEventsView } from './event-timeline-view';

/** The matter events timeline helpers. Fictional data only. */

const event = (id: string, kind: MatterEventItem['kind'], date: string): WithId<MatterEventItem> =>
  ({ id, kind, date, meta: {}, deletedAt: null }) as WithId<MatterEventItem>;

const deadline = (
  id: string,
  data: Omit<Partial<DeadlineItem>, 'dueDate'> & { anchor?: string; dueDate?: string },
): WithId<DeadlineItem> =>
  ({
    id,
    title: id,
    kind: 'statutory',
    critical: false,
    status: 'upcoming',
    assigneeUid: 'u-1',
    reminders: [],
    pastOnCreation: false,
    deletedAt: null,
    ...(data.anchor
      ? {
          computed: {
            ruleId: id,
            ruleSetId: 'vic',
            ruleSetVersion: 1,
            anchorEventId: data.anchor,
            inputs: {},
            trace: [],
          },
        }
      : {}),
    ...data,
  }) as WithId<DeadlineItem>;

const TODAY = '2026-10-05' as DateOnly;

describe('linkedTimeline', () => {
  const death = event('ev-death', 'date_of_death', '2026-03-14');
  const grant = event('ev-grant', 'grant_issued', '2026-08-18');
  const hearing = event('ev-hearing', 'hearing', '2026-11-12');
  const deadlines = [
    deadline('fp', { anchor: 'ev-grant', dueDate: '2027-02-18', critical: true }),
    deadline('filed', { anchor: 'ev-grant', dueDate: '2026-09-01', status: 'done' }),
    deadline('old', { anchor: 'ev-grant', dueDate: '2026-09-02', status: 'superseded' }),
    deadline('waiting', { anchor: 'ev-grant', status: 'blocked' }),
    deadline('manual', { dueDate: '2026-12-01', kind: 'internal' }),
    deadline('due-today', { dueDate: TODAY }),
  ];

  it('puts events, today and upcoming deadlines on one line, oldest first', () => {
    const entries = linkedTimeline([grant, hearing, death], deadlines, TODAY);
    expect(entries.map((e) => e.key)).toEqual([
      'event:ev-death',
      'event:ev-grant',
      'today',
      'event:ev-hearing',
      'deadline:manual',
      'deadline:fp',
    ]);
  });

  it('lists the dated, live deadlines computed from each event', () => {
    const entries = linkedTimeline([death, grant], deadlines, TODAY);
    const grantEntry = entries.find((e) => e.key === 'event:ev-grant');
    expect(grantEntry?.type === 'event' && grantEntry.linked.map((d) => d.id)).toEqual(['filed', 'fp']);
    const fp = entries.find((e) => e.key === 'deadline:fp');
    expect(fp?.type === 'deadline' && fp.anchor?.id).toBe('ev-grant');
    const manual = entries.find((e) => e.key === 'deadline:manual');
    expect(manual?.type === 'deadline' && manual.anchor).toBeUndefined();
  });

  it('marks future events and puts a same-day event before today', () => {
    const entries = linkedTimeline([event('ev-now', 'hearing', TODAY), hearing], [], TODAY);
    expect(entries.map((e) => e.key)).toEqual(['event:ev-now', 'today', 'event:ev-hearing']);
    expect(entries.map((e) => e.type === 'event' && e.future)).toEqual([false, false, true]);
  });
});

describe('eventAxis', () => {
  it('has no axis without events', () => {
    expect(eventAxis([], TODAY)).toBeUndefined();
  });

  it('scales decades of events with year ticks, alternating labels and edge alignment', () => {
    const axis = eventAxis(
      [
        event('a', 'date_of_death', '1996-07-20'),
        event('b', 'hearing', '2007-12-20'),
        event('c', 'will_located', '2021-12-20'),
      ],
      TODAY,
    );
    expect(axis?.ticks.map((t) => t.label)).toEqual(['2000', '2005', '2010', '2015', '2020', '2025']);
    expect(axis?.pins.map((p) => p.side)).toEqual(['above', 'below', 'above']);
    expect(axis?.pins[0]?.align).toBe('start');
    expect(axis?.pins[1]?.align).toBe('center');
    const at = axis?.pins.map((p) => p.at) ?? [];
    expect(at[0]).toBeLessThan(at[1] as number);
    expect(at[1]).toBeLessThan(at[2] as number);
    expect(axis?.today).toBeGreaterThan(at[2] as number);
    expect(axis?.today).toBeLessThan(100);
  });

  it('uses month ticks for a short matter, with the year on the first tick', () => {
    const axis = eventAxis(
      [event('a', 'date_of_death', '2026-03-14'), event('b', 'grant_issued', '2026-08-18')],
      TODAY,
    );
    expect(axis?.ticks.map((t) => t.label)).toEqual(['Mar 2026', 'May', 'Jul', 'Sep']);
    expect(axis?.pins[1]?.align).toBe('center');
  });

  it('ends at the last event when it is after today', () => {
    const axis = eventAxis([event('a', 'hearing', '2026-09-01'), event('b', 'hearing', '2027-09-01')], TODAY);
    expect(axis?.pins[1]?.align).toBe('end');
    expect(axis?.today).toBeLessThan(axis?.pins[1]?.at as number);
  });
});

describe('events view memory', () => {
  it('defaults to linked and remembers scale', () => {
    expect(storedEventsView()).toBe('linked');
    rememberEventsView('scale');
    expect(storedEventsView()).toBe('scale');
  });

  it('words a short date', () => {
    expect(dayMonth('1996-07-20' as DateOnly)).toBe('20 Jul');
  });
});
