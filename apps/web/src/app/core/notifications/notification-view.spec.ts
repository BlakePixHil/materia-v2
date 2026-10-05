import type { DateOnly } from '@materia/domain';

import { dayKey, dayLabel, notificationGlyph, notificationTime } from './notification-view';

/** How notifications read in the Inbox and the bell (CORE-22). */

const MEL = 'Australia/Melbourne';
const d = (s: string) => s as DateOnly;

describe('notification view', () => {
  it('labels days: today, yesterday, then the weekday and date, with the year once it changes', () => {
    const today = d('2026-10-05');
    expect(dayLabel(d('2026-10-05'), today)).toBe('Today · Mon 5 Oct');
    expect(dayLabel(d('2026-10-04'), today)).toBe('Yesterday');
    expect(dayLabel(d('2026-09-30'), today)).toBe('Wednesday 30 Sep');
    expect(dayLabel(d('2025-12-31'), today)).toBe('Wednesday 31 Dec 2025');
  });

  it('groups by the local day and gives the local time', () => {
    const at = new Date('2026-10-04T22:14:00Z');
    expect(dayKey(at, MEL)).toBe('2026-10-05');
    expect(notificationTime(at, MEL)).toBe('9:14 am');
    expect(notificationTime(at, MEL, d('2026-10-05'))).toBe('9:14 am');
    expect(notificationTime(at, MEL, d('2026-10-06'))).toBe('Yesterday');
    expect(notificationTime(at, MEL, d('2026-10-09'))).toBe('Mon 5 Oct');
  });

  it('picks a glyph and tint by kind, and the inbox glyph for a burst', () => {
    expect(notificationGlyph({ kind: 'mention' })).toEqual({ icon: 'at-sign', tone: 'mention' });
    expect(notificationGlyph({ kind: 'deadline_escalation' })).toEqual({ icon: 'alert', tone: 'overdue' });
    expect(notificationGlyph({ kind: 'suggestion' })).toEqual({ icon: 'sparkle', tone: 'clerk' });
    expect(notificationGlyph({ kind: 'system', collapsedCount: 120 })).toEqual({ icon: 'inbox', tone: null });
  });
});
