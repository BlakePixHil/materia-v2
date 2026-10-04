import { FakeCalendar, FakeClock, FakeMail, fakeClerkModel, fakePdfRender, fakeTranscription, fakeXero } from './fakes';

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

    expect(
      (await fakeClerkModel.complete({ system: '', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 })).text,
    ).toContain('1 message');
    expect(await fakeXero.pushInvoice('o', 'inv-1')).toEqual({ xeroInvoiceId: 'xero-inv-1' });
    expect((await fakeTranscription.transcribe('b', 'p')).durationSeconds).toBe(3);
    expect(await fakePdfRender.render('<p></p>', 'out.pdf')).toEqual({ path: 'out.pdf', pages: 1 });
  });
});
