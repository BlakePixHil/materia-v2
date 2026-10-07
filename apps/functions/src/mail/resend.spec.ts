import { mailFrom, RESEND_API, resendMail } from './resend';
import { MAIL_FROM } from '../config';
import { MailError } from '../ports';

/** The Resend adapter over a fake fetch (ADR-057): no request leaves the test. */

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

describe('resendMail', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('sends the rendered template with the key, tagged with the template', async () => {
    const { fetch, calls } = fakeFetch(200, { id: 're-1' });
    const mail = resendMail({ apiKey: () => 'fake-api-key', from: () => 'Materia <n@materia.example>', fetch });
    expect(await mail.send({ ...message, idempotencyKey: 'notification-org-1-n1' })).toEqual({ id: 're-1' });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [{ url: string; init: RequestInit }];
    expect(url).toBe(RESEND_API);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer fake-api-key',
      'Idempotency-Key': 'notification-org-1-n1',
    });
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({
      from: 'Materia <n@materia.example>',
      to: ['ada.fictional@example.com'],
      subject: 'Task assigned to you',
      tags: [{ name: 'template', value: 'notification' }],
    });
    expect(sent.html).toContain('Lodge the inventory');
    expect(sent.text).toContain('Open in Materia: https://materia.example/matters/m1/tasks');
    expect(sent.attachments).toBeUndefined();
  });

  it('sends no Idempotency-Key when the message has none', async () => {
    const { fetch, calls } = fakeFetch(200, { id: 're-2' });
    await resendMail({ apiKey: () => 'fake-api-key', from: mailFrom, fetch }).send(message);
    expect((calls[0] as { init: RequestInit }).init.headers).not.toHaveProperty('Idempotency-Key');
  });

  it('attaches files base64-encoded (BILL-07 invoices)', async () => {
    const { fetch, calls } = fakeFetch(200, { id: 're-3' });
    const mail = resendMail({ apiKey: () => 'fake-api-key', from: () => 'n@materia.example', fetch });
    await mail.send({
      ...message,
      attachments: [
        { name: 'INV-000001.pdf', contentType: 'application/pdf', content: new TextEncoder().encode('%PDF') },
      ],
    });
    const sent = JSON.parse(String((calls[0] as { init: RequestInit }).init.body));
    expect(sent.attachments).toEqual([
      { filename: 'INV-000001.pdf', content: 'JVBERg==', content_type: 'application/pdf' },
    ]);
  });

  it('is not configured without a key, and calls nobody', async () => {
    const { fetch, calls } = fakeFetch(200, {});
    const mail = resendMail({ apiKey: () => '', from: mailFrom, fetch });
    expect(await failureOf(mail.send(message))).toBe('not_configured');
    expect(calls).toEqual([]);
  });

  it.each([
    [401, { name: 'missing_api_key', statusCode: 401 }, 'not_configured'],
    [403, { name: 'invalid_api_key', statusCode: 403 }, 'not_configured'],
    [401, { name: 'restricted_api_key', statusCode: 401 }, 'not_configured'],
    [403, { name: 'validation_error', message: 'Verify a domain', statusCode: 403 }, 'rejected'],
    [422, { name: 'invalid_from_address', statusCode: 422 }, 'rejected'],
    [409, { name: 'invalid_idempotent_request', statusCode: 409 }, 'rejected'],
    [409, { name: 'concurrent_idempotent_requests', statusCode: 409 }, 'transient'],
    [429, { name: 'rate_limit_exceeded', statusCode: 429 }, 'transient'],
    [500, 'not json', 'transient'],
    [503, {}, 'transient'],
    [200, {}, 'rejected'],
  ])('classifies HTTP %i %j as %s', async (status, body, failure) => {
    const { fetch } = fakeFetch(status, body);
    const mail = resendMail({ apiKey: () => 'fake-api-key', from: mailFrom, fetch });
    expect(await failureOf(mail.send(message))).toBe(failure);
  });

  it('treats a network failure as transient', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const mail = resendMail({ apiKey: () => 'fake-api-key', from: mailFrom, fetch, timeoutMs: 50 });
    expect(await failureOf(mail.send(message))).toBe('transient');
  });

  it('sends from MAIL_FROM unless the environment overrides it', () => {
    delete process.env['MATERIA_MAIL_FROM'];
    expect(mailFrom()).toBe(MAIL_FROM);
    process.env['MATERIA_MAIL_FROM'] = 'Materia Dev <dev@materia.example>';
    expect(mailFrom()).toBe('Materia Dev <dev@materia.example>');
  });
});
