import { cloudKms } from './kms';

const fakeFetch = (respond: (url: string, body: Record<string, string>) => Response) => {
  const calls: { url: string; body: Record<string, string>; auth: string }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, string>;
    calls.push({ url, body, auth: (init.headers as Record<string, string>)['authorization'] ?? '' });
    return respond(url, body);
  }) as unknown as typeof fetch;
  return { fn, calls };
};

const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('cloudKms', () => {
  it('encrypts and decrypts through the REST API with the path as additional authenticated data', async () => {
    const { fn, calls } = fakeFetch((url, body) =>
      url.endsWith(':encrypt')
        ? Response.json({ name: 'projects/p/.../cryptoKeyVersions/3', ciphertext: `C(${body['plaintext']})` })
        : Response.json({ plaintext: b64('fictional-plaintext') }),
    );
    const kms = cloudKms({
      cryptoKey: 'clerk-api-keys',
      project: () => 'p',
      accessToken: async () => 'tok',
      fetch: fn,
    });
    const sealed = await kms.encrypt('fictional-plaintext', 'orgs/o1/integrations/anthropic');
    expect(sealed).toEqual({
      ciphertext: `C(${b64('fictional-plaintext')})`,
      keyVersion: 'projects/p/.../cryptoKeyVersions/3',
    });
    expect(await kms.decrypt(sealed.ciphertext, 'orgs/o1/integrations/anthropic')).toBe('fictional-plaintext');
    expect(calls[0]).toMatchObject({
      url: 'https://cloudkms.googleapis.com/v1/projects/p/locations/australia-southeast1/keyRings/materia/cryptoKeys/clerk-api-keys:encrypt',
      auth: 'Bearer tok',
      body: { additionalAuthenticatedData: b64('orgs/o1/integrations/anthropic') },
    });
    expect(calls[1]?.url.endsWith(':decrypt')).toBe(true);
  });

  it('fails with the status only, and needs a project', async () => {
    const { fn } = fakeFetch(() => new Response('{"error":"denied fictional-plaintext"}', { status: 403 }));
    const kms = cloudKms({ cryptoKey: 'k', project: () => 'p', accessToken: async () => 't', fetch: fn });
    const error = (await kms.encrypt('fictional-plaintext', 'aad').catch((e: unknown) => e)) as Error & {
      details?: unknown;
    };
    expect(error.message).toBe('Cloud KMS encrypt failed');
    expect(error.details).toEqual({ status: 403 });
    await expect(cloudKms({ cryptoKey: 'k', project: () => undefined }).decrypt('c', 'a')).rejects.toThrow(
      'No project configured',
    );
  });
});
