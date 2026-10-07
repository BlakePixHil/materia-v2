import * as z from 'zod';

import { DocIdSchema, InstantSchema, withMeta } from './schemas/common';
import { TIME_ENTRY_MAX_MINUTES, TIME_NARRATIVE_MAX } from './schemas/matter-records';
import { dateOnlyAt, type DateOnly } from './values/date-only';

/**
 * The global timer (BILL-02): one per person at `users/{uid}/timer/current`. The running segment
 * started at `startedAt` (server time); earlier segments are summed in `accumulatedMs`. Elapsed
 * time is always absolute milliseconds (so a DST change never adds or loses an hour), corrected
 * for the device's clock skew against the server. Stopping it (`time-stopTimer`) creates a draft
 * time entry with `source: 'timer'`.
 */

// ---------- limits ----------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** No input in the app for this long while the timer runs asks whether to keep the idle time. */
export const TIMER_IDLE_MINUTES = 15;
/** A timer running longer than this is "forgotten": the server job tells its owner. */
export const TIMER_FORGOTTEN_MS = 10 * HOUR;
/** Started offline on a clock off by more than this: the start time is marked for review. */
export const TIMER_SKEW_REVIEW_MS = 2 * MINUTE;
/** Over this, saving offers one entry per day. */
export const TIMER_SPLIT_MS = 24 * HOUR;
/** The longest a timer can hold (accumulated): 100 hours a day for a fortnight. */
export const TIMER_MAX_MS = 14 * TIME_ENTRY_MAX_MINUTES * MINUTE;
/** The one timer document's id. */
export const TIMER_DOC_ID = 'current';
/** Longest matter number the timer keeps for the shell. */
export const TIMER_MATTER_NUMBER_MAX = 64;

export const TimerForgottenReasonSchema = z.enum(['long', 'midnight']);
export type TimerForgottenReason = z.infer<typeof TimerForgottenReasonSchema>;

/**
 * `users/{uid}/timer/current`. Written by its owner (start, pause, resume, heartbeat, idle
 * corrections, the narrative draft) except `forgotten`, which only `time-flagForgottenTimers`
 * writes. `time-stopTimer` deletes it when it saves the entry.
 */
export const Timer = withMeta(
  () => ({
    /** The org the matter is in (the owner's org when the timer started). */
    orgId: DocIdSchema,
    matterId: DocIdSchema,
    /** The matter's number, for the shell (no reads needed to show it). */
    matterNumber: z.string().min(1).max(TIMER_MATTER_NUMBER_MAX),
    taskId: DocIdSchema.optional(),
    /** When the running segment started (server time); while paused, when the last one started. */
    startedAt: InstantSchema,
    /** Time already run in earlier segments. */
    accumulatedMs: z.number().int().min(0).max(TIMER_MAX_MS),
    running: z.boolean(),
    narrativeDraft: z.string().max(TIME_NARRATIVE_MAX),
    /** The server time of the owner's last write (each device measures its clock skew from it). */
    lastHeartbeatAt: InstantSchema,
    /** Started offline: `startedAt` is the device's clock, not the server's. */
    clientStarted: z.boolean().optional(),
    /** Started offline on a clock more than `TIMER_SKEW_REVIEW_MS` out: check the start time. */
    needsReview: z.boolean().optional(),
    /** Server-owned: running over 10 hours or across midnight (org time), and the owner was told. */
    forgotten: z.object({ reason: TimerForgottenReasonSchema, at: InstantSchema }).optional(),
    /** The owner dismissed the forgotten-timer banner (server time). */
    forgottenSeenAt: InstantSchema.optional(),
  }),
  {
    path: 'users/{uid}/timer',
    migratable: false,
    serverOwned: ['forgotten'],
    // The matter and org are fixed: switching matters stops (or discards) this timer and starts another.
    updatable: [
      'taskId',
      'startedAt',
      'accumulatedMs',
      'running',
      'narrativeDraft',
      'lastHeartbeatAt',
      'clientStarted',
      'needsReview',
      'forgottenSeenAt',
    ],
  },
);
export type Timer = z.infer<typeof Timer.schema>;
export const TimerSchema = Timer.schema;
export const TimerCreateSchema = Timer.create;
export const TimerUpdateSchema = Timer.update;

/** The timer fields the maths needs. */
export interface TimerClock {
  startedAt: Date | null | undefined;
  accumulatedMs: number;
  running: boolean;
}

// ---------- elapsed time and clock skew ----------

/**
 * Elapsed milliseconds at `nowMs` (the device's clock) with `offsetMs` added to reach server time:
 * `accumulatedMs`, plus the running segment from `startedAt`. Absolute time throughout, so a DST
 * change doesn't move it. A start in the "future" (a skewed clock) counts as zero, never negative.
 */
export function timerElapsedMs(timer: TimerClock, nowMs: number, offsetMs = 0): number {
  const base = Math.max(0, Math.floor(timer.accumulatedMs));
  if (!timer.running || !timer.startedAt) return base;
  const started = timer.startedAt.getTime();
  if (!Number.isFinite(started)) return base;
  return base + Math.max(0, Math.floor(nowMs + offsetMs - started));
}

/**
 * The device clock's offset from server time, from one write: sent at `sentMs`, its server time
 * (`serverMs`, a resolved `serverTimestamp()`) seen at `receivedMs`. The server stamped it about
 * halfway through the round trip, so `offset = server − (sent + received) / 2`. A slow round trip
 * (queued offline) doesn't say when it was stamped: then the receipt is used. Add the offset to
 * `Date.now()` to get server time.
 */
export function estimateServerOffset(
  sentMs: number,
  receivedMs: number,
  serverMs: number,
  maxRoundTripMs = 10_000,
): number {
  const roundTrip = receivedMs - sentMs;
  const local = roundTrip >= 0 && roundTrip <= maxRoundTripMs ? sentMs + roundTrip / 2 : receivedMs;
  return Math.round(serverMs - local);
}

/** Whether an offline start's clock was off by enough to check the start time (over 2 minutes). */
export function needsSkewReview(offsetMs: number): boolean {
  return Math.abs(offsetMs) > TIMER_SKEW_REVIEW_MS;
}

/** `mm:ss` under an hour, then `h:mm` (the shell's display). */
export function formatTimerElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

/** The spoken form ("1 hour 5 minutes"), for announcements on request. */
export function describeTimerElapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (!h) return part(m, 'minute');
  return m ? `${part(h, 'hour')} ${part(m, 'minute')}` : part(h, 'hour');
}

/** Whole minutes for an entry: rounded to the nearest minute, at least one. */
export function timerMinutes(ms: number): number {
  return Math.max(1, Math.round(Math.max(0, ms) / MINUTE));
}

// ---------- pause, resume and idle time ----------

/** The patch that pauses the timer at `nowMs` (server time): the running segment joins `accumulatedMs`. */
export function pausePatch(timer: TimerClock, serverNowMs: number): { running: false; accumulatedMs: number } {
  return { running: false, accumulatedMs: Math.min(TIMER_MAX_MS, timerElapsedMs(timer, serverNowMs)) };
}

/**
 * Leaves out the time since `idleSinceMs` (server time): the elapsed time then becomes
 * `accumulatedMs`. The caller restarts the running segment from now (`startedAt` = server time),
 * or keeps it paused (stop at the idle time).
 */
export function withoutIdle(timer: TimerClock, idleSinceMs: number): { accumulatedMs: number } {
  return { accumulatedMs: Math.min(TIMER_MAX_MS, timerElapsedMs(timer, idleSinceMs)) };
}

// ---------- forgotten timers ----------

/**
 * Why a running timer counts as forgotten at `now`: it has run more than 10 hours, or its running
 * segment started on an earlier day in the org's time zone (it ran across midnight). `null` when
 * it's fine, paused, or already flagged.
 */
export function forgottenReason(
  timer: TimerClock & { forgotten?: unknown },
  now: Date,
  timeZone: string,
): TimerForgottenReason | null {
  if (!timer.running || !timer.startedAt || timer.forgotten) return null;
  if (timerElapsedMs(timer, now.getTime()) > TIMER_FORGOTTEN_MS) return 'long';
  if (timer.startedAt.getTime() < now.getTime() && dateOnlyAt(timer.startedAt, timeZone) < dateOnlyAt(now, timeZone))
    return 'midnight';
  return null;
}

// ---------- saving ----------

export interface TimerDay {
  date: DateOnly;
  minutes: number;
}

/** The first instant in (`fromMs`, `toMs`] on a later date than `fromMs` (org time), by bisection. */
function nextDayStart(fromMs: number, toMs: number, timeZone: string): number {
  const day = dateOnlyAt(new Date(fromMs), timeZone);
  let lo = fromMs;
  let hi = toMs;
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (dateOnlyAt(new Date(mid), timeZone) === day) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * The timer's time as one entry per day (org time), as if it ran without a break up to `endMs`:
 * from `endMs − elapsedMs` to `endMs`, cut at each midnight. Minutes are rounded once overall (the
 * days add up to `timerMinutes(elapsedMs)`), and days with no whole minute are left out. Pauses
 * aren't recorded, so a paused timer's days are an estimate the person can edit.
 */
export function splitTimerByDay(endMs: number, elapsedMs: number, timeZone: string): TimerDay[] {
  const total = timerMinutes(elapsedMs);
  const startMs = endMs - Math.max(0, elapsedMs);
  const cuts: { date: DateOnly; ms: number }[] = [];
  let at = startMs;
  while (at < endMs) {
    const date = dateOnlyAt(new Date(at), timeZone);
    const next = dateOnlyAt(new Date(endMs), timeZone) === date ? endMs : nextDayStart(at, endMs, timeZone);
    cuts.push({ date, ms: next - at });
    at = next;
  }
  if (!cuts.length) return [{ date: dateOnlyAt(new Date(endMs), timeZone), minutes: total }];
  // Largest remainder, so the parts add up to the whole.
  const span = cuts.reduce((sum, cut) => sum + cut.ms, 0) || 1;
  const exact = cuts.map((cut) => (cut.ms / span) * total);
  const days = cuts.map((cut, i) => ({ date: cut.date, minutes: Math.floor(exact[i] ?? 0) }));
  let left = total - days.reduce((sum, day) => sum + day.minutes, 0);
  const order = exact.map((value, i) => ({ i, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest);
  for (const { i } of order) {
    if (left <= 0) break;
    const day = days[i];
    if (day) day.minutes += 1;
    left -= 1;
  }
  return days.filter((day) => day.minutes > 0);
}

/** The date a single entry from the timer gets: the day its time began (org time). */
export function timerEntryDate(endMs: number, elapsedMs: number, timeZone: string): DateOnly {
  return dateOnlyAt(new Date(endMs - Math.max(0, elapsedMs)), timeZone);
}

/** The entries saving the timer creates: one, or one per day when `split` (minutes, date each). */
export function timerEntries(endMs: number, elapsedMs: number, timeZone: string, split: boolean): TimerDay[] {
  if (split) return splitTimerByDay(endMs, elapsedMs, timeZone);
  return [{ date: timerEntryDate(endMs, elapsedMs, timeZone), minutes: timerMinutes(elapsedMs) }];
}

// ---------- the callable ----------

export const TIMER_CALLABLES = {
  stop: 'time-stopTimer',
} as const;

/**
 * `time-stopTimer` (`time.record`, idempotent): saves my timer as draft time entries
 * (`source: 'timer'`) and deletes it, in one transaction. `matterId` moves the time to another
 * matter (the timer's matter was deleted, or I lost access to it); `split` saves one entry per day
 * (a timer over 24 hours). `billable` defaults to the matter's (`defaultBillable`).
 */
export const StopTimerInput = /* @__PURE__ */ z.object({
  requestId: z.uuid(),
  narrative: z.string().max(TIME_NARRATIVE_MAX),
  billable: z.boolean().optional(),
  split: z.boolean().default(false),
  matterId: DocIdSchema.optional(),
});
export type StopTimerInput = z.input<typeof StopTimerInput>;

export interface StopTimerResult {
  matterId: string;
  entryIds: string[];
  minutes: number;
}

/** `details.reason` of the FAILED_PRECONDITION `time-stopTimer` throws when the matter can't take time. */
export const TIMER_MATTER_UNAVAILABLE = 'timer_matter_unavailable';
