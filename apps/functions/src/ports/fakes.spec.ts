import {
  FakeCalendar,
  FakeClock,
  FakeJobRunner,
  FakeMail,
  FakePush,
  FakeTaskQueue,
  fakeClerkModel,
  fakeTranscription,
  fakeXero,
} from './fakes';

describe('fakes', () => {
  it('behave deterministically', async () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    clock.advance(1000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.000Z');
    clock.set(new Date('2027-01-01T00:00:00Z'));
    expect(clock.now().getUTCFullYear()).toBe(2027);

    const mail = new FakeMail();
    expect(await mail.send({ to: 'a', template: 't', model: {} })).toEqual({ id: 'mail-1' });
    expect(mail.sent).toHaveLength(1);

    const calendar = new FakeCalendar();
    const { externalId } = await calendar.upsertEvent('u1', { title: 'Hearing', start: new Date(), end: new Date() });
    expect(calendar.events.size).toBe(1);
    await calendar.deleteEvent('u1', externalId);
    expect(calendar.events.size).toBe(0);

    const request = {
      model: 'm',
      system: '',
      messages: [],
      maxTokens: 10,
      effort: 'low' as const,
      timeoutMs: 1000,
      serverFallbacks: false,
    };
    expect((await fakeClerkModel.run(request)).text).toBe('Fake Clerk reply.');
    expect(await fakeXero.pushInvoice('o', 'inv-1')).toEqual({ xeroInvoiceId: 'xero-inv-1' });
    expect((await fakeTranscription.transcribe('b', 'p')).durationSeconds).toBe(3);
    const jobs = new FakeJobRunner();
    expect(await jobs.start('pdf', { orgId: 'o', jobId: 'j' })).toEqual({ executionId: 'fake-execution-1' });
    expect(jobs.started).toEqual([{ job: 'pdf', orgId: 'o', jobId: 'j' }]);

    const push = new FakePush();
    const note = { title: 't', body: 'b', link: '/' };
    expect(await push.send('fake-token', note)).toEqual({ ok: true, id: 'push-1' });
    expect(await push.send('invalid-token', note)).toEqual({ ok: false, reason: 'invalid_token' });
    expect(await push.send('flaky-token', note)).toEqual({ ok: false, reason: 'transient' });
    expect(push.sent).toHaveLength(1);

    const tasks = new FakeTaskQueue();
    await tasks.enqueue('q', { a: 1 });
    expect(tasks.queued).toEqual([{ queue: 'q', payload: { a: 1 }, options: {} }]);
  });
});
