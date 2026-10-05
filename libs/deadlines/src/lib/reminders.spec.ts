import { describe, expect, it } from 'vitest';

import { dateOnly } from '@materia/domain';

import { VIC_CALENDARS } from './data';
import { DEFAULT_LOCALITY } from './engine';
import {
  businessDayOnOrBefore,
  dueInWords,
  dueReminder,
  escalationAt,
  instantAt,
  nextReminderAt,
  reminderOffsets,
  reminderSlots,
  type ReminderCalendar,
} from './reminders';

const cal: ReminderCalendar = { timeZone: 'Australia/Melbourne', calendars: VIC_CALENDARS, locality: DEFAULT_LOCALITY };
const d = dateOnly;

describe('reminderOffsets', () => {
  it('uses the defaults for the deadline’s criticality when it names none', () => {
    expect(reminderOffsets({ critical: true })).toEqual([30, 14, 7, 3, 1]);
    expect(reminderOffsets({ critical: false, reminders: [] })).toEqual([7, 1]);
  });

  it('uses the deadline’s own offsets, largest first, without repeats', () => {
    expect(
      reminderOffsets({ critical: true, reminders: [{ offsetDays: 2 }, { offsetDays: 10 }, { offsetDays: 2 }] }),
    ).toEqual([10, 2]);
  });
});

describe('instantAt', () => {
  it('is 08:00 Melbourne time on both sides of daylight saving', () => {
    expect(instantAt(d('2026-07-01'), 480, 'Australia/Melbourne').toISOString()).toBe('2026-06-30T22:00:00.000Z');
    expect(instantAt(d('2026-12-01'), 480, 'Australia/Melbourne').toISOString()).toBe('2026-11-30T21:00:00.000Z');
  });

  it('lands on the day daylight saving starts (2026-10-04, 02:00 → 03:00)', () => {
    expect(instantAt(d('2026-10-04'), 480, 'Australia/Melbourne').toISOString()).toBe('2026-10-03T21:00:00.000Z');
    // 02:30 doesn't exist that day: it becomes 03:30 AEDT.
    expect(instantAt(d('2026-10-04'), 150, 'Australia/Melbourne').toISOString()).toBe('2026-10-03T16:30:00.000Z');
  });
});

describe('reminderSlots', () => {
  it('moves reminders on weekends and public holidays to the previous business day', () => {
    // Due Thursday 2026-11-05: 2 days before is Tuesday 3 November (Melbourne Cup), so Monday.
    const slots = reminderSlots(
      { dueDate: d('2026-11-05'), critical: false, reminders: [{ offsetDays: 2 }, { offsetDays: 4 }] },
      cal,
    );
    expect(slots.map((s) => [s.offsetDays, s.date])).toEqual([
      [4, '2026-10-30'], // Sunday 1 November → Friday
      [2, '2026-11-02'],
    ]);
    expect(slots[1]?.at.toISOString()).toBe('2026-11-01T21:00:00.000Z');
  });

  it('matches the engine’s golden reminder dates for a Melbourne firm', () => {
    // golden scenario "fp: Melbourne firm reminders follow the Melbourne calendar"
    const slots = reminderSlots(
      {
        dueDate: d('2026-11-04'),
        critical: true,
        reminders: [30, 14, 7, 5, 1].map((offsetDays) => ({ offsetDays })),
      },
      cal,
    );
    expect(slots.map((s) => s.date)).toEqual(['2026-10-05', '2026-10-21', '2026-10-28', '2026-10-30', '2026-11-02']);
  });

  it('falls back to skipping weekends past the calendar data', () => {
    expect(businessDayOnOrBefore(cal, d('2040-06-03'))).toBe('2040-06-01');
    expect(escalationAt(d('2040-06-06'), cal).toISOString()).toBe('2040-05-31T22:00:00.000Z');
  });

  it('keeps sent reminders sent', () => {
    const sentAt = new Date('2026-10-05T00:00:00Z');
    const slots = reminderSlots(
      { dueDate: d('2026-11-04'), critical: false, reminders: [{ offsetDays: 7, sentAt }] },
      cal,
    );
    expect(slots.find((s) => s.offsetDays === 7)?.sentAt).toBe(sentAt);
  });
});

describe('nextReminderAt and dueReminder', () => {
  const deadline = { dueDate: d('2026-12-10'), critical: true };

  it('schedules only reminders still ahead: a deadline created 5 days out gets the 3- and 1-day ones', () => {
    const slots = reminderSlots(deadline, cal);
    const created = new Date('2026-12-05T01:00:00Z');
    expect(nextReminderAt(slots, created)?.toISOString()).toBe(
      instantAt(d('2026-12-07'), 480, cal.timeZone).toISOString(),
    );
  });

  it('is undefined when every reminder is sent or past', () => {
    expect(nextReminderAt(reminderSlots(deadline, cal), new Date('2026-12-10T00:00:00Z'))).toBeUndefined();
  });

  it('sends the one reminder due, on time', () => {
    const slots = reminderSlots(deadline, cal);
    const at = instantAt(d('2026-12-03'), 480, cal.timeZone);
    const due = dueReminder(slots, at, new Date(at.getTime() + 10 * 60_000));
    expect(due).toEqual({ slot: expect.objectContaining({ offsetDays: 7 }), covered: [7], late: false });
  });

  it('catches up once, marked late, when the scheduler missed several', () => {
    const slots = reminderSlots(deadline, cal);
    const from = instantAt(d('2026-11-10'), 480, cal.timeZone); // the 30-day reminder
    const due = dueReminder(slots, from, new Date('2026-12-04T00:00:00Z'));
    expect(due?.slot.offsetDays).toBe(7);
    expect(due?.covered).toEqual([30, 14, 7]);
    expect(due?.late).toBe(true);
  });

  it('marks a single reminder sent over an hour after its time late', () => {
    const slots = reminderSlots(deadline, cal);
    const at = instantAt(d('2026-12-09'), 480, cal.timeZone);
    expect(dueReminder(slots, at, new Date(at.getTime() + 2 * 3_600_000))?.late).toBe(true);
  });

  it('never sends a reminder that was already due when it was scheduled, or one already sent', () => {
    const at = instantAt(d('2026-12-09'), 480, cal.timeZone);
    const slots = reminderSlots({ ...deadline, reminders: [{ offsetDays: 1, sentAt: at }, { offsetDays: 3 }] }, cal);
    expect(dueReminder(slots, at, new Date(at.getTime() + 60_000))).toBeNull();
  });
});

describe('escalationAt', () => {
  it('is 08:00 three business days before the due date', () => {
    // Due Thursday 2026-11-05; Tuesday 3 November is Melbourne Cup: Wed 4, Mon 2, Fri 30 October.
    expect(escalationAt(d('2026-11-05'), cal).toISOString()).toBe('2026-10-29T21:00:00.000Z');
  });
});

describe('dueInWords', () => {
  it('says when a deadline is due', () => {
    expect(dueInWords(d('2026-10-05'), d('2026-10-05'))).toBe('today');
    expect(dueInWords(d('2026-10-05'), d('2026-10-06'))).toBe('tomorrow');
    expect(dueInWords(d('2026-10-05'), d('2026-10-08'))).toBe('in 3 days');
    expect(dueInWords(d('2026-10-05'), d('2026-10-03'))).toBe('2 days ago');
  });
});
