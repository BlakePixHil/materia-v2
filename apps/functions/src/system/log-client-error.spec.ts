import type { Firestore } from 'firebase-admin/firestore';

import { CLIENT_ERRORS_PER_MINUTE } from '@materia/domain';

import {
  createLogClientError,
  errorEvent,
  FULL_REPORTS_PER_MINUTE,
  LogClientErrorInputSchema,
  STORM_SAMPLE_RATE,
  StormSampler,
} from './log-client-error';

/** Just enough Firestore for takeSlots: one transaction at a time over an in-memory map. */
function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const db = {
    doc: (path: string) => ({ path }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({
        get: async (ref: { path: string }) => ({ data: () => docs.get(ref.path) }),
        set: (ref: { path: string }, data: Record<string, unknown>) => docs.set(ref.path, data),
      }),
  };
  return { db: db as unknown as Firestore, docs };
}

// Fictional data only.
const report = (message = 'Failed for jane.citizen@example.test, ring 0412 345 678') => ({
  message,
  stack: `TypeError: ${message}\n    at x (https://materia-v2-dev.web.app/chunk-A.js:1:204857)`,
  route: '/matters/m-1?q=Citizen',
  version: '1.2.0',
  userAgent: 'Mozilla/5.0 Chrome/129.0',
});

function setup(now = new Date('2026-10-05T10:00:30Z')) {
  const { db, docs } = fakeDb();
  const written: Record<string, unknown>[] = [];
  const clock = { now: () => now };
  const handler = createLogClientError({ db: () => db, clock, write: (e) => written.push(e), random: () => 0.99 });
  return { handler, written, docs, setNow: (d: Date) => (now = d) };
}

describe('system-logClientError', () => {
  it('writes a scrubbed Error Reporting event with ids only', async () => {
    const { handler, written } = setup();
    const result = await handler({
      data: { sessionId: 'session-1', errors: [report()] },
      auth: { uid: 'u1' } as never,
    });
    expect(result).toEqual({ accepted: 1, dropped: 0 });
    const [entry] = written;
    expect(entry).toMatchObject({
      severity: 'ERROR',
      '@type': 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
      serviceContext: { service: 'web', version: '1.2.0' },
      route: '/matters/m-1',
      uid: 'u1',
      sessionId: 'session-1',
    });
    expect(String(entry?.['message'])).toContain('chunk-A.js:1:204857');
    expect(JSON.stringify(entry)).not.toMatch(/jane|citizen|0412/i);
  });

  it('allows 20 reports per session per minute, then a new minute starts again', async () => {
    const { handler, written, setNow } = setup();
    const batch = (n: number) => Array.from({ length: n }, () => report('boom'));
    const call = (n: number, sessionId = 'session-1') =>
      handler({ data: { sessionId, errors: batch(n) }, auth: null as never });
    expect(await call(15)).toEqual({ accepted: 15, dropped: 0 });
    expect(await call(10)).toEqual({ accepted: 5, dropped: 5 });
    expect(await call(1)).toEqual({ accepted: 0, dropped: 1 });
    // Another session has its own allowance.
    expect(await call(2, 'session-2')).toEqual({ accepted: 2, dropped: 0 });
    setNow(new Date('2026-10-05T10:01:01Z'));
    expect(await call(1)).toEqual({ accepted: 1, dropped: 0 });
    expect(written).toHaveLength(CLIENT_ERRORS_PER_MINUTE + 3);
  });

  it('rejects malformed input', async () => {
    const { handler } = setup();
    await expect(handler({ data: { sessionId: 'x', errors: [] }, auth: null as never })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('keeps the first reports each minute in a storm, then samples', () => {
    let roll = 0.05;
    const sampler = new StormSampler(() => roll);
    const now = Date.parse('2026-10-05T10:00:00Z');
    for (let i = 0; i < FULL_REPORTS_PER_MINUTE; i++) expect(sampler.take(now)).toBe(1);
    expect(sampler.take(now)).toBe(STORM_SAMPLE_RATE);
    roll = 0.5;
    expect(sampler.take(now)).toBe(0);
    expect(sampler.take(now + 60_000)).toBe(1);
  });

  it('adds a header to header-less stacks and marks samples', () => {
    const event = errorEvent(
      { message: 'boom', stack: 'f@https://x.example/a.js:1:2', route: '', version: '', userAgent: '' },
      { uid: null, sessionId: 's' },
      10,
    );
    expect(event.message).toBe('boom\nf@https://x.example/a.js:1:2');
    expect(event).toMatchObject({ sampledOneIn: 10, serviceContext: { version: 'unknown' } });
    const bare = errorEvent(
      { message: 'boom', route: '/x', version: '1', userAgent: '' },
      { uid: 'u', sessionId: 's' },
      1,
    );
    expect(bare.message).toBe('boom');
    expect(bare).not.toHaveProperty('sampledOneIn');
  });
});

describe('LogClientErrorInputSchema', () => {
  it('accepts a batch of up to 20', () => {
    const errors = (n: number) => Array.from({ length: n }, () => report());
    expect(LogClientErrorInputSchema.safeParse({ sessionId: 'session-1', errors: errors(20) }).success).toBe(true);
    expect(LogClientErrorInputSchema.safeParse({ sessionId: 'session-1', errors: errors(21) }).success).toBe(false);
  });
});
