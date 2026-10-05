import { generateKeyPairSync } from 'node:crypto';

import { cert, deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

import { DOWNLOAD_URL_TTL_SECONDS, attachmentDisposition } from '@materia/domain';

import { clamavScanner, metadataIdToken } from './clamav';
import { filesBucket } from './files';
import { googDate, storageSignedUrls } from './signed-urls';
import { ScannerUnavailableError } from '../ports';

/** Unit tests for the documents adapters (CORE-12): ClamAV over HTTP, V4 signing and the bucket name. */

const request = { bucket: 'b', path: 'orgs/o/matters/m/pending/upload-1', data: Buffer.from('fictional bytes') };

describe('clamavScanner', () => {
  const respond = (status: number, body: unknown) =>
    vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

  it('posts the bytes with an ID token and reads the verdict', async () => {
    const fetch = respond(200, { verdict: 'infected', signature: 'Eicar-Test-Signature' });
    const scanner = clamavScanner({
      url: () => 'https://scanner.example.test/',
      idToken: async (a) => `token-for-${a}`,
      fetch,
    });
    await expect(scanner.scan(request)).resolves.toEqual({ verdict: 'infected', signature: 'Eicar-Test-Signature' });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://scanner.example.test/scan');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer token-for-https://scanner.example.test',
        'content-type': 'application/octet-stream',
      },
    });
    expect(Buffer.from(init.body as ArrayBuffer).toString()).toBe('fictional bytes');
    const clean = clamavScanner({
      url: () => 'https://s.example.test',
      idToken: async () => 't',
      fetch: respond(200, { verdict: 'clean' }),
    });
    await expect(clean.scan(request)).resolves.toEqual({ verdict: 'clean' });
  });

  it.each([
    ['no URL configured', '', respond(200, { verdict: 'clean' }), 'not_configured'],
    ['a server error', 'https://s.example.test', respond(503, {}), 'unavailable'],
    ['a malformed verdict', 'https://s.example.test', respond(200, { verdict: 'maybe' }), 'unavailable'],
    [
      'a network error',
      'https://s.example.test',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed'))),
      'unavailable',
    ],
  ])('fails closed on %s', async (_label, url, fetch, reason) => {
    const scanner = clamavScanner({
      url: () => url,
      idToken: async () => 't',
      fetch: fetch as typeof globalThis.fetch,
    });
    const error = await scanner.scan(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScannerUnavailableError);
    expect(error).toMatchObject({ reason });
  });

  it('reports an aborted request as a timeout', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(async () => Promise.reject(new DOMException('aborted', 'AbortError')));
    const scanner = clamavScanner({ url: () => 'https://s.example.test', idToken: async () => 't', fetch });
    await expect(scanner.scan(request, controller.signal)).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('caches metadata-server ID tokens for 50 minutes', async () => {
    let now = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('id-token\n'));
    const token = metadataIdToken(fetch, () => now);
    expect(await token('https://s.example.test')).toBe('id-token');
    expect(await token('https://s.example.test')).toBe('id-token');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { 'Metadata-Flavor': 'Google' } });
    now = 51 * 60 * 1000;
    await token('https://s.example.test');
    expect(fetch).toHaveBeenCalledTimes(2);
    const failing = metadataIdToken(vi.fn(async () => new Response('', { status: 500 })));
    await expect(failing('a')).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
});

describe('storageSignedUrls', () => {
  let app: App;
  const env = { ...process.env };
  beforeAll(() => {
    // V4 signing is local with a key: a throwaway key pair for a fictional service account.
    delete process.env['FIREBASE_STORAGE_EMULATOR_HOST'];
    delete process.env['STORAGE_EMULATOR_HOST'];
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    app = initializeApp(
      {
        credential: cert({
          projectId: 'demo-materia',
          clientEmail: 'fn-runtime@demo-materia.iam.gserviceaccount.com',
          privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        }),
      },
      'signed-urls-spec',
    );
  });
  afterAll(async () => {
    process.env = { ...env };
    await deleteApp(app);
  });

  it('signs a V4 read URL that expires in 5 minutes and downloads as an attachment', async () => {
    const signer = storageSignedUrls(() => getStorage(app));
    const expiresAt = new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000);
    const url = new URL(
      await signer.sign({
        bucket: 'demo-materia-files',
        path: 'orgs/o/matters/m/documents/d/v1',
        expiresAt,
        disposition: attachmentDisposition('Fictional will.pdf'),
        contentType: 'application/pdf',
      }),
    );
    expect(url.pathname).toBe('/demo-materia-files/orgs/o/matters/m/documents/d/v1');
    const params = url.searchParams;
    expect(params.get('X-Goog-Algorithm')).toBe('GOOG4-RSA-SHA256');
    expect(params.get('X-Goog-Credential')).toMatch(/^fn-runtime@demo-materia\.iam\.gserviceaccount\.com\//);
    // Allow for the second that may tick between computing expiresAt and signing.
    expect(Number(params.get('X-Goog-Expires'))).toBeGreaterThanOrEqual(DOWNLOAD_URL_TTL_SECONDS - 1);
    expect(Number(params.get('X-Goog-Expires'))).toBeLessThanOrEqual(DOWNLOAD_URL_TTL_SECONDS);
    expect(params.get('response-content-disposition')).toMatch(/^attachment; filename="Fictional will.pdf"/);
    expect(params.get('response-content-type')).toBe('application/pdf');
    expect(params.get('X-Goog-Signature')).toMatch(/^[0-9a-f]+$/);
  });

  it('googDate formats V4 dates', () => {
    expect(googDate(new Date('2026-10-05T01:02:03.456Z'))).toBe('20261005T010203Z');
  });
});

describe('filesBucket', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('is {project}-files in production and {project}.appspot.com in the emulator', () => {
    delete process.env['MATERIA_FILES_BUCKET'];
    expect(filesBucket('materia-prod')).toBe('materia-prod-files');
    expect(filesBucket('demo-materia')).toBe('demo-materia.appspot.com');
    process.env['MATERIA_FILES_BUCKET'] = 'override-bucket';
    expect(filesBucket('materia-prod')).toBe('override-bucket');
  });
});
