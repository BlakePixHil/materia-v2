import {
  describeTimerElapsed,
  estimateServerOffset,
  formatTimerElapsed,
  forgottenReason,
  needsSkewReview,
  pausePatch,
  splitTimerByDay,
  StopTimerInput,
  Timer,
  TIMER_FORGOTTEN_MS,
  TIMER_MAX_MS,
  timerElapsedMs,
  timerEntries,
  timerEntryDate,
  timerMinutes,
  withoutIdle,
} from './timer';

/** The global timer (BILL-02): elapsed time, clock skew, idle time, forgotten timers and splitting. */

const MIN = 60_000;
const HOUR = 60 * MIN;
const MEL = 'Australia/Melbourne';
const at = (iso: string) => new Date(iso);

describe('timerElapsedMs', () => {
  const started = at('2026-10-06T00:00:00Z');

  it('adds the running segment to the accumulated time', () => {
    const timer = { startedAt: started, accumulatedMs: 5 * MIN, running: true };
    expect(timerElapsedMs(timer, started.getTime() + 90_000)).toBe(5 * MIN + 90_000);
  });

  it('is only the accumulated time while paused (or never started)', () => {
    expect(timerElapsedMs({ startedAt: started, accumulatedMs: 7 * MIN, running: false }, Date.now())).toBe(7 * MIN);
    expect(timerElapsedMs({ startedAt: null, accumulatedMs: 7 * MIN, running: true }, Date.now())).toBe(7 * MIN);
    expect(timerElapsedMs({ startedAt: new Date(Number.NaN), accumulatedMs: 1, running: true }, 0)).toBe(1);
  });

  it('corrects the device clock with the server offset', () => {
    const timer = { startedAt: started, accumulatedMs: 0, running: true };
    // The device runs 3 minutes slow: its "now" is 2 minutes after the start, the server's is 5.
    const deviceNow = started.getTime() + 2 * MIN;
    expect(timerElapsedMs(timer, deviceNow, 3 * MIN)).toBe(5 * MIN);
    // A device 3 minutes fast would see 5 minutes without the correction.
    expect(timerElapsedMs(timer, started.getTime() + 5 * MIN, -3 * MIN)).toBe(2 * MIN);
  });

  it('never goes negative when the start is ahead of a skewed clock', () => {
    const timer = { startedAt: started, accumulatedMs: 4 * MIN, running: true };
    expect(timerElapsedMs(timer, started.getTime() - 10 * MIN)).toBe(4 * MIN);
  });

  it('uses absolute time across a DST change (Melbourne, 5 April 2026: 3:00 becomes 2:00)', () => {
    // 01:30 AEDT to 02:30 AEST is one hour on the wall clock, but two real hours.
    const start = at('2026-04-04T14:30:00Z'); // 01:30 AEDT
    const end = at('2026-04-04T16:30:00Z'); // 02:30 AEST, after the clocks went back
    expect(timerElapsedMs({ startedAt: start, accumulatedMs: 0, running: true }, end.getTime())).toBe(2 * HOUR);
    // And forward in October (4 October 2026: 2:00 becomes 3:00): 01:30 to 03:30 is one hour.
    const spring = at('2026-10-03T15:30:00Z'); // 01:30 AEST
    const later = at('2026-10-03T16:30:00Z'); // 03:30 AEDT
    expect(timerElapsedMs({ startedAt: spring, accumulatedMs: 0, running: true }, later.getTime())).toBe(HOUR);
  });
});

describe('estimateServerOffset', () => {
  it('takes the server time as stamped halfway through a quick round trip', () => {
    // Sent at 1000, seen at 1400: stamped about 1200 local. Server said 61200: 60 s ahead.
    expect(estimateServerOffset(1000, 1400, 61_200)).toBe(60_000);
    expect(estimateServerOffset(1000, 1000, 1000)).toBe(0);
    // A device clock 90 s fast.
    expect(estimateServerOffset(100_000, 100_200, 10_100)).toBe(-90_000);
  });

  it('falls back to the receipt for a write queued offline (a long round trip)', () => {
    expect(estimateServerOffset(0, 600_000, 600_500)).toBe(500);
    expect(estimateServerOffset(5000, 4000, 4000)).toBe(0);
  });

  it('marks more than 2 minutes either way for review', () => {
    expect(needsSkewReview(2 * MIN)).toBe(false);
    expect(needsSkewReview(2 * MIN + 1)).toBe(true);
    expect(needsSkewReview(-3 * MIN)).toBe(true);
    expect(needsSkewReview(-1000)).toBe(false);
  });
});

describe('formatting', () => {
  it('shows mm:ss under an hour, then h:mm', () => {
    expect(formatTimerElapsed(0)).toBe('00:00');
    expect(formatTimerElapsed(-5)).toBe('00:00');
    expect(formatTimerElapsed(65_999)).toBe('01:05');
    expect(formatTimerElapsed(59 * MIN + 59_000)).toBe('59:59');
    expect(formatTimerElapsed(HOUR)).toBe('1:00');
    expect(formatTimerElapsed(10 * HOUR + 7 * MIN + 30_000)).toBe('10:07');
  });

  it('describes it in words for announcements', () => {
    expect(describeTimerElapsed(30_000)).toBe('0 minutes');
    expect(describeTimerElapsed(MIN)).toBe('1 minute');
    expect(describeTimerElapsed(HOUR)).toBe('1 hour');
    expect(describeTimerElapsed(2 * HOUR + 5 * MIN)).toBe('2 hours 5 minutes');
    expect(describeTimerElapsed(HOUR + MIN)).toBe('1 hour 1 minute');
  });

  it('rounds to whole minutes, at least one', () => {
    expect(timerMinutes(0)).toBe(1);
    expect(timerMinutes(29_999)).toBe(1);
    expect(timerMinutes(90_000)).toBe(2);
    expect(timerMinutes(24 * MIN + 29_000)).toBe(24);
    expect(timerMinutes(-1)).toBe(1);
  });
});

describe('pause and idle time', () => {
  const started = at('2026-10-06T00:00:00Z');
  const timer = { startedAt: started, accumulatedMs: 10 * MIN, running: true };

  it('pausing folds the running segment into accumulatedMs', () => {
    expect(pausePatch(timer, started.getTime() + 5 * MIN)).toEqual({ running: false, accumulatedMs: 15 * MIN });
    expect(pausePatch({ ...timer, accumulatedMs: TIMER_MAX_MS }, started.getTime() + HOUR).accumulatedMs).toBe(
      TIMER_MAX_MS,
    );
  });

  it('discarding idle time keeps only the time up to the idle start', () => {
    // Idle from 20 minutes in: 10 accumulated + 20.
    expect(withoutIdle(timer, started.getTime() + 20 * MIN)).toEqual({ accumulatedMs: 30 * MIN });
  });
});

describe('forgottenReason', () => {
  // 09:00 Melbourne (AEDT, +11) on 6 October 2026.
  const nine = at('2026-10-05T22:00:00Z');

  it('flags a timer over 10 hours', () => {
    const timer = { startedAt: nine, accumulatedMs: 0, running: true };
    expect(forgottenReason(timer, new Date(nine.getTime() + TIMER_FORGOTTEN_MS), MEL)).toBeNull();
    expect(forgottenReason(timer, new Date(nine.getTime() + TIMER_FORGOTTEN_MS + 1000), MEL)).toBe('long');
    // Accumulated time counts too.
    expect(forgottenReason({ ...timer, accumulatedMs: 9 * HOUR }, new Date(nine.getTime() + 2 * HOUR), MEL)).toBe(
      'long',
    );
  });

  it('flags a timer that ran across midnight in the org time zone', () => {
    const evening = at('2026-10-06T12:00:00Z'); // 23:00 Melbourne
    const timer = { startedAt: evening, accumulatedMs: 0, running: true };
    expect(forgottenReason(timer, at('2026-10-06T12:50:00Z'), MEL)).toBeNull(); // 23:50
    expect(forgottenReason(timer, at('2026-10-06T13:05:00Z'), MEL)).toBe('midnight'); // 00:05
    // Not midnight in UTC terms: 23:00 Melbourne is noon UTC, and 00:05 is still the same UTC day.
    expect(forgottenReason(timer, at('2026-10-06T13:05:00Z'), 'UTC')).toBeNull();
  });

  it('ignores paused, unstarted and already flagged timers', () => {
    const now = new Date(nine.getTime() + 20 * HOUR);
    expect(forgottenReason({ startedAt: nine, accumulatedMs: 0, running: false }, now, MEL)).toBeNull();
    expect(forgottenReason({ startedAt: null, accumulatedMs: 0, running: true }, now, MEL)).toBeNull();
    expect(
      forgottenReason({ startedAt: nine, accumulatedMs: 0, running: true, forgotten: { reason: 'long' } }, now, MEL),
    ).toBeNull();
  });
});

describe('splitting by day', () => {
  it('cuts a 26-hour timer at each Melbourne midnight, adding up to the whole', () => {
    // 22:00 on 6 Oct to 00:00 on 8 Oct (Melbourne, +11): 2 hours on the 6th, 24 on the 7th.
    const end = at('2026-10-07T13:00:00Z'); // 00:00 8 Oct
    const days = splitTimerByDay(end.getTime(), 26 * HOUR, MEL);
    expect(days).toEqual([
      { date: '2026-10-06', minutes: 120 },
      { date: '2026-10-07', minutes: 1440 },
    ]);
  });

  it('spreads rounding with the largest remainder', () => {
    // 23:59:30 to 00:01:00 the next day: 30 s and 60 s, 2 minutes in all (rounded once).
    const end = at('2026-10-06T13:01:00Z'); // 00:01 7 Oct
    const days = splitTimerByDay(end.getTime(), 90_000, MEL);
    expect(days.reduce((sum, day) => sum + day.minutes, 0)).toBe(2);
    expect(days.map((day) => day.date)).toEqual(['2026-10-06', '2026-10-07']);
  });

  it('keeps a same-day timer whole, and drops days with no whole minute', () => {
    const end = at('2026-10-06T03:00:00Z');
    expect(splitTimerByDay(end.getTime(), 45 * MIN, MEL)).toEqual([{ date: '2026-10-06', minutes: 45 }]);
    expect(splitTimerByDay(end.getTime(), 0, MEL)).toEqual([{ date: '2026-10-06', minutes: 1 }]);
    // 10 s before midnight and 5 minutes after: the first day rounds to nothing.
    const after = at('2026-10-06T13:05:00Z');
    expect(splitTimerByDay(after.getTime(), 5 * MIN + 10_000, MEL)).toEqual([{ date: '2026-10-07', minutes: 5 }]);
  });

  it('crosses a DST change by absolute time (5 April 2026 has 25 hours in Melbourne)', () => {
    // 00:00 on 5 April (AEDT) to 00:00 on 6 April (AEST) is 25 real hours on one date.
    const end = at('2026-04-05T14:00:00Z');
    expect(splitTimerByDay(end.getTime(), 25 * HOUR, MEL)).toEqual([{ date: '2026-04-05', minutes: 1500 }]);
  });

  it('dates a single entry on the day its time began, or splits on request', () => {
    const end = at('2026-10-06T13:30:00Z'); // 00:30 7 Oct
    expect(timerEntryDate(end.getTime(), HOUR, MEL)).toBe('2026-10-06');
    expect(timerEntries(end.getTime(), HOUR, MEL, false)).toEqual([{ date: '2026-10-06', minutes: 60 }]);
    expect(timerEntries(end.getTime(), HOUR, MEL, true)).toEqual([
      { date: '2026-10-06', minutes: 30 },
      { date: '2026-10-07', minutes: 30 },
    ]);
  });
});

describe('schemas', () => {
  it('keeps forgotten server-owned and the matter fixed', () => {
    expect(Object.keys(Timer.create.shape)).not.toContain('forgotten');
    expect(Object.keys(Timer.update.shape)).not.toContain('matterId');
    expect(Object.keys(Timer.update.shape)).not.toContain('orgId');
    expect(Timer.path).toBe('users/{uid}/timer');
  });

  it('validates the stop input', () => {
    const requestId = '6f1f8f0e-7b1a-4c55-9a1e-3d6f5a2b9c10';
    expect(StopTimerInput.parse({ requestId, narrative: 'Drafting' })).toEqual({
      requestId,
      narrative: 'Drafting',
      split: false,
    });
    expect(StopTimerInput.safeParse({ requestId, narrative: 'x'.repeat(2001) }).success).toBe(false);
    expect(StopTimerInput.safeParse({ requestId: 'nope', narrative: '' }).success).toBe(false);
  });
});
