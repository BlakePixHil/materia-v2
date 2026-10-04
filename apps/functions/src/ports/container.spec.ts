import { DomainError } from '@materia/domain';

import { ports, setPorts } from './container';
import { FakeMail } from './fakes';

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
    await expect(p.malwareScan.scan('b', 'orgs/o/pending/eicar.txt')).resolves.toBe('infected');
    await expect(p.malwareScan.scan('b', 'orgs/o/pending/will.pdf')).resolves.toBe('clean');
    expect((await p.embedding.embed(['a', 'bb']))[0]).toHaveLength(768);
    expect(ports()).toBe(p);
  });

  it('fails clearly for ports without a production adapter', async () => {
    delete process.env['MATERIA_FAKES'];
    delete process.env['FUNCTIONS_EMULATOR'];
    const p = ports();
    expect(p.clock.now()).toBeInstanceOf(Date);
    await expect(p.mail.send({ to: 'x', template: 't', model: {} })).rejects.toBeInstanceOf(DomainError);
    await expect(p.pdfRender.render('<p></p>', 'out.pdf')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('can be replaced in tests', () => {
    const custom = { ...ports(), mail: new FakeMail() };
    setPorts(custom);
    expect(ports()).toBe(custom);
  });
});
