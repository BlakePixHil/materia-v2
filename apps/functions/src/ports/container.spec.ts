import { DomainError } from '@materia/domain';

import { ports, setPorts } from './container';
import { EICAR_TEST_STRING, FakeMail, FakeSignedUrls } from './fakes';

describe('ports container', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    setPorts();
  });

  it('uses fakes in the emulator or with MATERIA_FAKES=1', async () => {
    process.env['MATERIA_FAKES'] = '1';
    const p = ports();
    expect(p.mail).toBeInstanceOf(FakeMail);
    const scan = (text: string) =>
      p.malwareScan.scan({
        bucket: 'b',
        path: 'orgs/o/matters/m/pending/upload-1',
        data: new TextEncoder().encode(text),
      });
    await expect(scan(EICAR_TEST_STRING)).resolves.toMatchObject({ verdict: 'infected' });
    await expect(scan('%PDF-1.7 fictional')).resolves.toEqual({ verdict: 'clean' });
    expect(p.signedUrls).toBeInstanceOf(FakeSignedUrls);
    expect((await p.embedding.embed(['a', 'bb']))[0]).toHaveLength(768);
    expect(ports()).toBe(p);
  });

  it('fails clearly for ports without a production adapter', async () => {
    delete process.env['MATERIA_FAKES'];
    delete process.env['FUNCTIONS_EMULATOR'];
    const p = ports();
    expect(p.clock.now()).toBeInstanceOf(Date);
    await expect(p.mail.send({ to: 'x', template: 't', model: {} })).rejects.toBeInstanceOf(DomainError);
    await expect(p.xero.pushInvoice('o', 'i')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    // No scanner URL configured: fail closed, so uploads stay quarantined ('Scanning delayed').
    await expect(
      p.malwareScan.scan({ bucket: 'b', path: 'orgs/o/matters/m/pending/upload-1', data: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ name: 'ScannerUnavailableError', reason: 'not_configured' });
  });

  it('can be replaced in tests', () => {
    const custom = { ...ports(), mail: new FakeMail() };
    setPorts(custom);
    expect(ports()).toBe(custom);
  });
});
