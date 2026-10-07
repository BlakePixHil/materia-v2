/**
 * The load model for SEC-07: a 50-member firm's busiest minute, per flow, and the 10× peak the
 * k6 scripts run at (the ticket's target: p95 under 1 s at 10× peak, with no errors). The
 * arithmetic is here, and in docs/ops/perf-report-2026-10.md, so a run can be checked against it.
 *
 * Peak (busiest minute, a 50-member firm on a month-end morning):
 *
 * - matters-createMatter: 2 a minute. The firm opens about 1,250 matters a year (10,000 over eight
 *   years), about 5 a working day; two intakes finishing in the same minute is the busy case.
 * - clerk-sendMessage: 20 a minute. Ten people in a Clerk chat at once, a message every 30 s each.
 * - billing-issueInvoice: 9 a minute. Month-end billing: 3 people issuing an invoice every 20 s.
 * - deadlines-recompute: 5 a minute. Event edits and explicit recomputes across the firm.
 * - Notification fan-out (notes-create mentioning colleagues): 5 notes a minute, each mentioning
 *   10 people here (a team-wide mention), so 50 notifications a minute plus their deliveries.
 * - Search (the palette's four queries): 50 a minute, every member searching once.
 *
 * Counters: matter and invoice numbering are one transaction on one document per org. Firestore
 * sustains about one write a second on a document under contention, and more with short
 * transactions; the ticket accepts matter numbering as one transaction per org at 5 creates a
 * second, so both counters also run a contention step at 5 a second.
 */
export const PEAK_PER_MINUTE = {
  createMatter: 2,
  sendMessage: 20,
  issueInvoice: 9,
  recompute: 5,
  mentionNotes: 5,
  search: 50,
};

/**
 * The ticket's multiple of peak. `MULTIPLIER=1` runs at peak, to find where the emulator (not
 * production) gives out.
 */
export const MULTIPLIER = Number(__ENV.MULTIPLIER || 10);

/** Mentions in each fan-out note. */
export const MENTIONS_PER_NOTE = 10;

/** The counters' contention step: 5 a second, the ticket's bound for matter numbering. */
export const CONTENTION_PER_SECOND = 5;

/** A flow's rate at 10× peak, per minute. */
export function tenTimesPeak(flow) {
  return PEAK_PER_MINUTE[flow] * MULTIPLIER;
}

/**
 * A constant-arrival-rate scenario at 10× peak (per minute), measured for `DURATION` (default 2
 * minutes) after the setup's warm-up.
 */
export function peakScenario(flow, extra = {}) {
  return {
    executor: 'constant-arrival-rate',
    rate: tenTimesPeak(flow),
    timeUnit: '1m',
    duration: __ENV.DURATION || '2m',
    preAllocatedVUs: 10,
    maxVUs: 60,
    gracefulStop: '60s',
    tags: { step: 'peak10x' },
    ...extra,
  };
}

/**
 * The counters' contention step: `CONTENTION_PER_SECOND` for 30 s, once the 10× peak scenario and
 * its graceful stop are over (`CONTENTION_START` when `DURATION` changes it).
 */
export function contentionScenario() {
  return {
    executor: 'constant-arrival-rate',
    rate: CONTENTION_PER_SECOND,
    timeUnit: '1s',
    duration: __ENV.CONTENTION_DURATION || '30s',
    startTime: __ENV.CONTENTION_START || '3m10s',
    preAllocatedVUs: 20,
    maxVUs: 100,
    // Let the calls still waiting on the counter finish, so they are measured.
    gracefulStop: '120s',
    tags: { step: 'contention' },
  };
}
