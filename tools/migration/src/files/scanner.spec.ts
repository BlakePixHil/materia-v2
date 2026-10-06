import {
  EICAR_TEST_STRING,
  emulatorScanner,
  FAKE_SCANNER_UNAVAILABLE_MARKER,
  httpScanner,
  ScannerUnavailableError,
} from './scanner.ts';

function scanner(answer: Response | Error) {
  const seen: { url: string; auth: string | null; type: string | null; bytes: number }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    seen.push({
      url,
      auth: headers.get('authorization'),
      type: headers.get('content-type'),
      bytes: (init.body as ArrayBuffer).byteLength,
    });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  return {
    seen,
    scan: httpScanner({ url: 'https://clamav-x.a.run.app/', idToken: async () => 'id-tok', fetch: impl }),
  };
}

describe('httpScanner (the ClamAV service contract, CORE-12a)', () => {
  it('posts the bytes with an ID token and reads the verdict', async () => {
    const clean = scanner(new Response(JSON.stringify({ verdict: 'clean' })));
    expect(await clean.scan(Buffer.from('hello'))).toEqual({ verdict: 'clean' });
    expect(clean.seen).toEqual([
      { url: 'https://clamav-x.a.run.app/scan', auth: 'Bearer id-tok', type: 'application/octet-stream', bytes: 5 },
    ]);
    const infected = scanner(new Response(JSON.stringify({ verdict: 'infected', signature: 'Win.Test' })));
    expect(await infected.scan(Buffer.from('x'))).toEqual({ verdict: 'infected', signature: 'Win.Test' });
  });

  it('is unavailable on an error status, a strange answer or no answer', async () => {
    for (const answer of [
      new Response('', { status: 503 }),
      new Response(JSON.stringify({ verdict: 'maybe' })),
      new Response('not json'),
      new Error('ECONNRESET'),
    ]) {
      await expect(scanner(answer).scan(Buffer.from('x'))).rejects.toThrow(ScannerUnavailableError);
    }
  });
});

describe('emulatorScanner', () => {
  it('finds EICAR, fails on the marker, and passes everything else', async () => {
    expect(await emulatorScanner(Buffer.from(`a${EICAR_TEST_STRING}b`))).toEqual({
      verdict: 'infected',
      signature: 'Eicar-Test-Signature',
    });
    await expect(emulatorScanner(Buffer.from(FAKE_SCANNER_UNAVAILABLE_MARKER))).rejects.toThrow(
      ScannerUnavailableError,
    );
    expect(await emulatorScanner(Buffer.from('%PDF-1.4'))).toEqual({ verdict: 'clean' });
  });
});
