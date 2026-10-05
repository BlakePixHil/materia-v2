import { mailFrom, POSTMARK_API, POSTMARK_STREAM, postmarkMail } from './postmark';
import { MAIL_FROM } from '../config';
import { MailError } from '../ports';

/** The Postmark adapter over a fake fetch (FND-20): no request leaves the test. */

const message = {
  to: 'ada.fictional@example.com',
  template: 'notification',
  model: {
    title: 'Task assigned to you',
    body: 'Lodge the inventory',
    link: 'https://materia.example/matters/m1/tasks',
    settingsLink: 'https://materia.example/settings',
    kindLabel: 'tasks assigned to you',
  },
};

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MailError);
    return (error as MailError).failure;
  }
  throw new Error('expected a failure');
};

describe('postmarkMail', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('sends the rendered template on the outbound stream with tracking off', async () => {
    const { fetch, calls } = fakeFetch(200, { ErrorCode: 0, MessageID: 'pm-1', Message: 'OK' });
    const mail = postmarkMail({ token: () => 'fake-server-token', from: () => 'Materia <n@materia.example>', fetch });
    expect(await mail.send(message)).toEqual({ id: 'pm-1' });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [{ url: string; init: RequestInit }];
    expect(url).toBe(POSTMARK_API);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-Postmark-Server-Token': 'fake-server-token' });
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({
      From: 'Materia <n@materia.example>',
      To: 'ada.fictional@example.com',
      Subject: 'Task assigned to you',
      MessageStream: POSTMARK_STREAM,
      Tag: 'notification',
      TrackOpens: false,
      TrackLinks: 'None',
    });
    expect(POSTMARK_STREAM).toBe('outbound');
    expect(sent.HtmlBody).toContain('Lodge the inventory');
    expect(sent.TextBody).toContain('Open in Materia: https://materia.example/matters/m1/tasks');
  });

  it('is not configured without a token, and calls nobody', async () => {
    const { fetch, calls } = fakeFetch(200, {});
    const mail = postmarkMail({ token: () => '', from: mailFrom, fetch });
    expect(await failureOf(mail.send(message))).toBe('not_configured');
    expect(calls).toEqual([]);
  });

  it.each([
    [401, { ErrorCode: 10, Message: 'Bad or missing server token' }, 'not_configured'],
    [422, { ErrorCode: 10 }, 'not_configured'],
    [422, { ErrorCode: 406, Message: 'Inactive recipient' }, 'inactive_recipient'],
    [422, { ErrorCode: 300, Message: 'Invalid email request' }, 'rejected'],
    [429, { ErrorCode: 0 }, 'transient'],
    [500, 'not json', 'transient'],
    [503, {}, 'transient'],
    [200, { ErrorCode: 0 }, 'rejected'],
  ])('classifies HTTP %i %j as %s', async (status, body, failure) => {
    const { fetch } = fakeFetch(status, body);
    const mail = postmarkMail({ token: () => 'fake-server-token', from: mailFrom, fetch });
    expect(await failureOf(mail.send(message))).toBe(failure);
  });

  it('treats a network failure as transient', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const mail = postmarkMail({ token: () => 'fake-server-token', from: mailFrom, fetch, timeoutMs: 50 });
    expect(await failureOf(mail.send(message))).toBe('transient');
  });

  it('sends from MAIL_FROM unless the environment overrides it', () => {
    delete process.env['MATERIA_MAIL_FROM'];
    expect(mailFrom()).toBe(MAIL_FROM);
    process.env['MATERIA_MAIL_FROM'] = 'Materia Dev <dev@materia.example>';
    expect(mailFrom()).toBe('Materia Dev <dev@materia.example>');
  });
});
