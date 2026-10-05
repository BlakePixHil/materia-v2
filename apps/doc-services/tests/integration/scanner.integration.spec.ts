import { startContainer } from './containers';

/**
 * The ClamAV image (CORE-12a) with its baked-in signatures: the EICAR test file is infected, an
 * ordinary file is clean. Runs only with SCANNER_IMAGE set (CI builds it).
 */
const image = process.env['SCANNER_IMAGE'];

// The EICAR anti-virus test string (harmless), built from two halves so this file isn't flagged.
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');

describe.skipIf(!image)('scanner image', () => {
  let service: Awaited<ReturnType<typeof startContainer>>;

  beforeAll(async () => {
    service = await startContainer(image as string);
  });
  afterAll(async () => {
    await service?.stop();
  });

  const scan = (body: string | Buffer) =>
    fetch(`${service.url}/scan`, { method: 'POST', body: typeof body === 'string' ? body : new Uint8Array(body) });

  it('flags the EICAR test file as infected', async () => {
    const response = await scan(EICAR);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verdict: 'infected', signature: expect.stringMatching(/eicar/i) });
  });

  it('passes an ordinary file as clean', async () => {
    const response = await scan(Buffer.from('%PDF-1.7\n% Fictional file note for the Estate of Sam Sample\n%%EOF\n'));
    expect(await response.json()).toEqual({ verdict: 'clean' });
  });

  it('refuses files over the size limit', async () => {
    expect((await scan(Buffer.alloc(56 * 1024 * 1024))).status).toBe(413);
  });
});
