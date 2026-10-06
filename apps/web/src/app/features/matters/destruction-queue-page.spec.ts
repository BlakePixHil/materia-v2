import type { InMemoryFirestore } from '@materia/data-access/repository';
import { makeDestructionRequest } from '@materia/test-utils';

import { ADMIN, cleanUpOverlays, LAWYER, openMatter, ORG } from '../matter-detail/testing';

/** The destruction queue (CORE-19): owners and admins approve each destruction. Fictional data only. */

afterEach(cleanUpOverlays);

const QUEUE = `orgs/${ORG}/destructionQueue`;
const FLAGS = { 'matters.destruction': true };

function seedQueue(fs: InMemoryFirestore): void {
  fs.set(
    `${QUEUE}/m-old`,
    makeDestructionRequest({ matterId: 'm-old', number: 'M-2018-0007', title: 'Estate of Fictional Old' }),
  );
  fs.set(
    `${QUEUE}/m-gone`,
    makeDestructionRequest({
      matterId: 'm-gone',
      number: 'M-2017-0003',
      status: 'destroyed',
      certificateId: 'dc-m-gone',
      destroyedAt: new Date('2026-09-02T00:00:00Z'),
    }),
  );
}

describe('destruction queue', () => {
  it('approves a destruction once the admin types the matter number', async () => {
    const page = await openMatter('/matters/destruction', {
      session: ADMIN,
      flags: FLAGS,
      configure: seedQueue,
      callables: {
        'matters-approveDestruction': (data, fs) => {
          fs.set(`${QUEUE}/m-old`, { ...fs.get(`${QUEUE}/m-old`), status: 'approved' });
          return { matterId: data['matterId'], status: 'approved' };
        },
        'matters-destructionCertificateUrl': () => ({ url: 'https://example.test/cert.pdf', expiresAt: '' }),
      },
    });
    expect(page.text()).toContain('M-2018-0007');
    expect(page.text()).toContain('Estate of Fictional Old');
    expect(page.text()).toContain('M-2017-0003');

    await page.click('Approve…');
    await page.fill('Type M-2018-0007 to confirm', 'M-2018-0070', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    expect(page.calls('matters-approveDestruction')).toEqual([]);
    expect(page.text(page.dialog())).toContain('Type M-2018-0007 exactly.');

    await page.fill('Type M-2018-0007 to confirm', 'm-2018-0007', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    expect(page.calls('matters-approveDestruction')[0]).toMatchObject({
      matterId: 'm-old',
      confirmation: 'm-2018-0007',
    });
    expect(page.text()).toContain('Being destroyed');

    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null);
    await page.click('Certificate');
    expect(page.calls('matters-destructionCertificateUrl')[0]).toEqual({ certificateId: 'dc-m-gone' });
    expect(open).toHaveBeenCalledWith('https://example.test/cert.pdf', '_blank', 'noopener');
    open.mockRestore();
  });

  it('signs in again and retries when the last sign-in is too old', async () => {
    let refused = false;
    const page = await openMatter('/matters/destruction', {
      session: ADMIN,
      flags: FLAGS,
      configure: seedQueue,
      callables: {
        'matters-approveDestruction': (data) => {
          if (!refused) {
            refused = true;
            throw Object.assign(new Error('reauth'), { code: 'unauthenticated', details: { code: 'REAUTH_REQUIRED' } });
          }
          return { matterId: data['matterId'], status: 'approved' };
        },
      },
    });
    await page.click('Approve…');
    await page.fill('Type M-2018-0007 to confirm', 'M-2018-0007', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    // The callable client asks "Confirm it's you" (SEC-04), then retries.
    await vi.waitFor(() => expect(page.body.querySelector('mt-reauth-dialog')).not.toBeNull());
    const reauth = page.body.querySelector<HTMLElement>('mt-reauth-dialog') as HTMLElement;
    await page.fill('Password', 'password', reauth);
    await page.submit(reauth);
    await page.stable(10);
    expect(page.calls('matters-approveDestruction')).toHaveLength(2);
  });

  it('is for owners and admins only', async () => {
    const page = await openMatter('/matters/destruction', { session: LAWYER, flags: FLAGS, configure: seedQueue });
    expect(page.text()).toContain('Owners and admins only');
    expect(page.text()).not.toContain('M-2018-0007');
  });
});
