import type { DeadlineItem, MatterEventItem, WithId } from '@materia/data-access/repository';
import { addDays, daysBetween, type DateOnly } from '@materia/domain';

/**
 * The matter's events as a timeline (the Deadlines tab): pure helpers for its two views. `linked`
 * puts events, today and the upcoming deadlines on one line, each event with the computed deadlines
 * anchored on it (`computed.anchorEventId`). `scale` places the events on an axis drawn to scale.
 */

export type EventsView = 'linked' | 'scale';
export const EVENTS_VIEW_KEY = 'materia.matter.eventsView';

export function storedEventsView(): EventsView {
  try {
    return localStorage.getItem(EVENTS_VIEW_KEY) === 'scale' ? 'scale' : 'linked';
  } catch {
    return 'linked';
  }
}

export function rememberEventsView(view: EventsView): void {
  try {
    localStorage.setItem(EVENTS_VIEW_KEY, view);
  } catch {
    // Not remembered (private window); the linked view stands next time.
  }
}

type Event = WithId<MatterEventItem>;
type Deadline = WithId<DeadlineItem>;

export type TimelineEntry =
  | { type: 'event'; key: string; date: DateOnly; event: Event; linked: Deadline[]; future: boolean }
  | { type: 'today'; key: 'today'; date: DateOnly }
  | { type: 'deadline'; key: string; date: DateOnly; deadline: Deadline; anchor: Event | undefined };

const ORDER: Record<TimelineEntry['type'], number> = { event: 0, today: 1, deadline: 2 };

/**
 * Events (with the dated, not superseded deadlines computed from each), a Today marker, and the
 * upcoming deadlines due after today, oldest first. On the same day an event comes before Today.
 */
export function linkedTimeline(events: readonly Event[], deadlines: readonly Deadline[], today: DateOnly) {
  const byAnchor = new Map<string, Deadline[]>();
  for (const deadline of deadlines) {
    const anchor = deadline.computed?.anchorEventId;
    if (!anchor || !deadline.dueDate || deadline.status === 'superseded') continue;
    byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), deadline]);
  }
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const entries: TimelineEntry[] = [
    ...events.map((event) => ({
      type: 'event' as const,
      key: `event:${event.id}`,
      date: event.date,
      event,
      linked: [...(byAnchor.get(event.id) ?? [])].sort(byDue),
      future: event.date > today,
    })),
    { type: 'today', key: 'today', date: today },
    ...deadlines
      .filter((d): d is Deadline & { dueDate: DateOnly } => d.status === 'upcoming' && !!d.dueDate && d.dueDate > today)
      .map((deadline) => ({
        type: 'deadline' as const,
        key: `deadline:${deadline.id}`,
        date: deadline.dueDate,
        deadline,
        anchor: eventsById.get(deadline.computed?.anchorEventId ?? ''),
      })),
  ];
  return entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : ORDER[a.type] - ORDER[b.type]));
}

function byDue(a: Deadline, b: Deadline): number {
  return (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.title.localeCompare(b.title);
}

export interface AxisPin {
  event: Event;
  /** Left edge offset, 0–100. */
  at: number;
  side: 'above' | 'below';
  align: 'start' | 'center' | 'end';
}
export interface AxisTick {
  at: number;
  label: string;
}
export interface EventAxis {
  pins: AxisPin[];
  ticks: AxisTick[];
  today: number;
}

const YEAR_STEPS = [1, 2, 5, 10, 20, 25, 50, 100];
const MONTH_STEPS = [1, 2, 3, 6];
const MAX_TICKS = 7;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The events on an axis from the first event to today (or the last event, if later), padded a
 * little each side. Ticks fall on years (or months, under two years) at a step that keeps them to
 * seven or fewer. Labels alternate above and below the line; near an edge they align to it.
 */
export function eventAxis(events: readonly Event[], today: DateOnly): EventAxis | undefined {
  if (!events.length) return undefined;
  const dates = events.map((e) => e.date).sort();
  const first = dates[0] as DateOnly;
  const last = [dates[dates.length - 1] as DateOnly, today].sort()[1] as DateOnly;
  const pad = Math.max(15, Math.round(daysBetween(first, last) * 0.04));
  const start = addDays(first, -pad);
  const end = addDays(last, pad);
  const total = daysBetween(start, end);
  const at = (date: DateOnly) => round((daysBetween(start, date) / total) * 100);

  const pins = [...events]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((event, i): AxisPin => {
      const x = at(event.date);
      return { event, at: x, side: i % 2 ? 'below' : 'above', align: x < 12 ? 'start' : x > 88 ? 'end' : 'center' };
    });
  return { pins, ticks: axisTicks(start, end, at), today: at(today) };
}

function axisTicks(start: DateOnly, end: DateOnly, at: (date: DateOnly) => number): AxisTick[] {
  const [startYear, startMonth] = start.split('-').map(Number) as [number, number];
  const [endYear] = end.split('-').map(Number) as [number];
  const ticks: AxisTick[] = [];
  const years = daysBetween(start, end) / 365.25;
  if (years >= 2) {
    const step = YEAR_STEPS.find((s) => years / s <= MAX_TICKS) ?? 100;
    for (let y = Math.ceil(startYear / step) * step; y <= endYear; y += step) {
      const date = `${y}-01-01` as DateOnly;
      if (date >= start && date <= end) ticks.push({ at: at(date), label: String(y) });
    }
    return ticks;
  }
  const step = MONTH_STEPS.find((s) => (years * 12) / s <= MAX_TICKS) ?? 6;
  for (let i = 0; ; i++) {
    const index = startYear * 12 + startMonth + i; // from start's month on, 1-based
    const year = Math.floor((index - 1) / 12);
    const month = index - year * 12;
    const date = `${year}-${String(month).padStart(2, '0')}-01` as DateOnly;
    if (date > end) break;
    if (date < start || (month - 1) % step) continue;
    const label = month === 1 || !ticks.length ? `${MONTHS[month - 1]} ${year}` : (MONTHS[month - 1] as string);
    ticks.push({ at: at(date), label });
  }
  return ticks;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `20 Jul` (the year goes on its own line). */
export function dayMonth(date: DateOnly): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]}`;
}
