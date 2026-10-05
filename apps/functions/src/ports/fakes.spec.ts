import {
  EICAR_TEST_STRING,
  FAKE_SCANNER_TIMEOUT_MARKER,
  FakeCalendar,
  FakeClock,
  FakeJobRunner,
  FakeMail,
  FakePush,
  FakeSignedUrls,
  FakeTaskQueue,
  fakeClerkModel,
  fakeMalwareScan,
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

  it('scan: EICAR is infected, the timeout marker times out, everything else is clean', async () => {
    const scan = (text: string) =>
      fakeMalwareScan.scan({ bucket: 'b', path: 'orgs/o/matters/m/pending/upload-1', data: Buffer.from(text) });
    await expect(scan(`prefix ${EICAR_TEST_STRING} suffix`)).resolves.toEqual({
      verdict: 'infected',
      signature: 'Eicar-Test-Signature',
    });
    await expect(scan(FAKE_SCANNER_TIMEOUT_MARKER)).rejects.toMatchObject({ reason: 'timeout' });
    await expect(scan('Fictional brief')).resolves.toEqual({ verdict: 'clean' });
    // A view into a larger buffer only scans its own bytes.
    const whole = Buffer.from(`${EICAR_TEST_STRING}clean`);
    await expect(
      fakeMalwareScan.scan({ bucket: 'b', path: 'p', data: whole.subarray(EICAR_TEST_STRING.length) }),
    ).resolves.toEqual({ verdict: 'clean' });
  });

  it('signed urls: records the request and encodes the expiry', async () => {
    const signer = new FakeSignedUrls();
    const expiresAt = new Date('2026-01-01T00:05:00Z');
    const url = await signer.sign({
      bucket: 'demo-materia.appspot.com',
      path: 'orgs/o/matters/m/documents/d/v1',
      expiresAt,
      disposition: 'attachment; filename="a.pdf"',
      contentType: 'application/pdf',
    });
    expect(url).toContain(`expires=${expiresAt.getTime() / 1000}`);
    expect(signer.signed).toHaveLength(1);
  });
});
