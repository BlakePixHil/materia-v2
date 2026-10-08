import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import { FEEDBACK_PER_HOUR, ROLES, type Role } from '@materia/domain';

import { submitDefinition } from './submit';
import { runCallable, type CallableDeps } from '../core/callable';
import { READ_ONLY_CALLABLES } from '../core/read-only';
import { memoryFirestore } from '../orgs/testing';
import type { MailPort } from '../ports';
import { FakeClock, FakeMail, fakePorts } from '../ports/fakes';

/** Unit tests for Help & feedback (SEC-08). Every person and practice is fictional. */

const ORG = 'org-a';
const meta = { createdBy: 'seed', updatedBy: 'seed', schemaVersion: 1 };

function world(mail: MailPort = new FakeMail()) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { ...meta, name: 'Harbour & Vine Legal' },
    [`orgs/${ORG}/members/user-lawyer`]: {
      ...meta,
      email: 'priya@harbourvine.example',
      displayName: 'Priya Fictional',
      role: 'lawyer',
    },
  });
  const clock = new FakeClock(new Date('2026-10-08T03:00:00.000Z'));
  const deps = (): CallableDeps => ({
    db: () => store.db,
    clock,
    ports: () => fakePorts({ mail }),
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const call = (data: Record<string, unknown>, role: Role = 'lawyer') =>
    runCallable(
      submitDefinition,
      { data: { requestId: randomUUID(), ...data }, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } },
      deps(),
    );
  const feedback = () => [...store.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/feedback/`));
  return { ...store, clock, call, feedback };
}

const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as HttpsError;
  }
  throw new Error('expected a failure');
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('feedback-submit', () => {
  it('keeps the message, with who sent it and from where, for every role', async () => {
    const w = world();
    for (const role of ROLES) await w.call({ kind: 'idea', body: `From ${role}` }, role);
    expect(w.feedback()).toHaveLength(ROLES.length);

    const result = await w.call({
      kind: 'problem',
      body: '  The Deadlines page shows nothing.  ',
      page: '/deadlines',
      version: '1.2.0+abc1234',
    });
    expect(result).toEqual({ feedbackId: expect.any(String), emailed: false });
    expect(w.docs.get(`orgs/${ORG}/feedback/${result.feedbackId}`)).toMatchObject({
      uid: 'user-lawyer',
      kind: 'problem',
      body: 'The Deadlines page shows nothing.',
      page: '/deadlines',
      version: '1.2.0+abc1234',
      createdBy: 'user-lawyer',
    });
  });

  it('refuses an empty message, a page with a query string and a field it does not take', async () => {
    const w = world();
    for (const data of [
      { kind: 'idea', body: '   ' },
      { kind: 'idea', body: 'Hi', page: '/contacts?q=Smith' },
      { kind: 'idea', body: 'Hi', uid: 'someone-else' },
    ]) {
      expect((await failureOf(w.call(data))).details).toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(w.feedback()).toHaveLength(0);
  });

  it(`takes at most ${FEEDBACK_PER_HOUR} an hour from one person`, async () => {
    const w = world();
    for (let i = 0; i < FEEDBACK_PER_HOUR; i++) await w.call({ kind: 'question', body: `Question ${i}` });
    const limited = await failureOf(w.call({ kind: 'question', body: 'One more' }));
    expect(limited.details).toMatchObject({ code: 'RATE_LIMITED', perHour: FEEDBACK_PER_HOUR });
    expect(w.feedback()).toHaveLength(FEEDBACK_PER_HOUR);
    // Someone else in the practice isn't held back, and an hour later the person can write again.
    await expect(w.call({ kind: 'question', body: 'Mine' }, 'paralegal')).resolves.toBeDefined();
    w.clock.advance(3_600_001);
    await expect(w.call({ kind: 'question', body: 'Later' })).resolves.toBeDefined();
  });

  it('emails support once a support address is set', async () => {
    vi.stubEnv('MATERIA_SUPPORT_EMAIL', 'support@materia.example');
    const mail = new FakeMail();
    const w = world(mail);
    const result = await w.call({ kind: 'problem', body: 'It broke.', page: '/today' });
    expect(result.emailed).toBe(true);
    expect(mail.sent).toEqual([
      {
        to: 'support@materia.example',
        template: 'feedback',
        model: expect.objectContaining({
          orgName: 'Harbour & Vine Legal',
          senderName: 'Priya Fictional',
          senderEmail: 'priya@harbourvine.example',
          role: 'lawyer',
          kindLabel: 'Something isn’t working',
          body: 'It broke.',
          page: '/today',
          feedbackId: result.feedbackId,
        }),
        idempotencyKey: `feedback-${ORG}-${result.feedbackId}`,
      },
    ]);
  });

  it('keeps the message when the email fails', async () => {
    vi.stubEnv('MATERIA_SUPPORT_EMAIL', 'support@materia.example');
    const failing: MailPort = {
      send: async () => {
        throw Object.assign(new Error('Resend is down'), { code: 'UNAVAILABLE' });
      },
    };
    const w = world(failing);
    const result = await w.call({ kind: 'idea', body: 'Still here.' });
    expect(result.emailed).toBe(false);
    expect(w.feedback()).toHaveLength(1);
  });

  it('still runs while the practice waits to be deleted, so people can reach support', () => {
    expect(READ_ONLY_CALLABLES.has('feedback-submit')).toBe(true);
  });
});
