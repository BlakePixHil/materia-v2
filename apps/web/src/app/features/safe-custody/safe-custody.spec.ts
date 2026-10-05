import type { JobSource } from '@materia/data-access';
import { SAFE_CUSTODY_CALLABLES } from '@materia/domain';

import { EXPORT_NAVIGATOR } from './safe-custody-view';
import { AUTHORITY_DOC, PACKETS, safeCustodyServerCallables, seedPackets } from './testing';
import { testSession } from '../../core/auth/testing';
import { JOB_SOURCE } from '../../core/jobs/job-progress';
import {
  ADMIN,
  cleanUpOverlays,
  ME,
  openMatter,
  PARALEGAL,
  PRIYA,
  READONLY,
  type OpenOptions,
} from '../matter-detail/testing';

/** The will safe custody register (CORE-17) against the in-memory Firestore and fake callables. Fictional data only. */

afterEach(cleanUpOverlays);

type Page = Awaited<ReturnType<typeof openMatter>>;

/** Every job finishes at once. */
const instantJobs: JobSource = {
  watch: (_orgId, _jobId, next) => {
    queueMicrotask(() =>
      next({
        status: 'succeeded',
        progress: { done: 1, total: 1 },
        warnings: [],
        output: { storagePath: 'x', pages: 1 },
      }),
    );
    return () => undefined;
  },
};

async function open(url: string, options: OpenOptions & { uid?: string } = {}) {
  const navigated: string[] = [];
  const page = await openMatter(url, {
    ...options,
    callables: { ...safeCustodyServerCallables(options.uid), ...options.callables },
    configure: (fs, port) => {
      seedPackets(fs);
      options.configure?.(fs, port);
    },
    providers: [
      { provide: JOB_SOURCE, useValue: instantJobs },
      { provide: EXPORT_NAVIGATOR, useValue: (url: string) => navigated.push(url) },
      ...(options.providers ?? []),
    ],
  });
  await page.stable(10);
  return { ...page, navigated };
}

const rows = (page: Page) =>
  [...page.body.querySelectorAll<HTMLElement>('mt-safe-custody-register tbody tr[data-index]')].map((row) =>
    page.text(row),
  );
const status = (page: Page) => page.text(page.body.querySelector('[data-testid="packet-status"]'));
const history = (page: Page) =>
  [...page.body.querySelectorAll<HTMLElement>('.mt-sc-history li .label')].map((label) => page.text(label));
const packet = (page: Page, id: string) => page.firestore.get(`${PACKETS}/${id}`) as Record<string, unknown>;

/** Margaret's packet with a destruction `uid` asked for. */
const pendingFrom = (uid: string) => (fs: Page['firestore']) =>
  fs.set(`${PACKETS}/sc-margaret`, {
    ...(fs.get(`${PACKETS}/sc-margaret`) as object),
    pendingDestruction: {
      requestedBy: uid,
      requestedAt: new Date('2026-10-03T00:00:00Z'),
      authority: { matterId: 'm-whitfield', documentId: AUTHORITY_DOC },
      reason: 'Testator’s written instruction',
    },
  });

/** Picks the option labelled `label` in the select labelled `field`. */
async function choose(page: Page, field: string, label: string, root: ParentNode = page.body) {
  const host = [...root.querySelectorAll('mt-select')].find((select) =>
    select.querySelector('.mt-label')?.textContent?.trim().startsWith(field),
  );
  const select = host?.querySelector('select');
  const option = [...(select?.options ?? [])].find((o) => o.textContent?.trim().startsWith(label));
  if (!select || !option) throw new Error(`No option "${label}" in "${field}"`);
  select.value = option.value;
  select.dispatchEvent(new Event('change'));
  await page.stable();
}

describe('the register', () => {
  it('lists every packet newest first, with its originals, place and status', async () => {
    const page = await open('/safe-custody');
    expect(rows(page)).toEqual([
      expect.stringContaining('SC-000003 Wilfred Larch'),
      expect.stringContaining('SC-000002 Margaret Whitfield'),
      expect.stringContaining('SC-000001 Bram Ostler'),
    ]);
    expect(rows(page)[2]).toContain('Will, Codicil (current), Power of attorney');
    expect(rows(page)[2]).toContain('Geelong · Safe A · 1');
    expect(rows(page)[0]).toContain('Released');
  });

  it('finds packets by testator, packet number or location, and by status', async () => {
    const page = await open('/safe-custody');
    await page.fill('Search the register', 'ostler');
    await page.stable(250);
    expect(rows(page)).toEqual([expect.stringContaining('Bram Ostler')]);
    await page.fill('Search the register', 'SC-000002');
    await page.stable(250);
    expect(rows(page)).toEqual([expect.stringContaining('Margaret Whitfield')]);
    await page.fill('Search the register', 'strongroom');
    await page.stable(250);
    expect(rows(page)).toEqual([expect.stringContaining('Margaret Whitfield')]);
    await page.fill('Search the register', '');
    await page.stable(250);
    await page.click('Released');
    expect(rows(page)).toEqual([expect.stringContaining('Wilfred Larch')]);
  });

  it('receives a will: testator, originals, place and date, then opens the packet', async () => {
    const page = await open('/safe-custody');
    await page.click('Receive a will');
    const dialog = page.dialog() as HTMLElement;
    await page.submit(dialog);
    expect(page.text(dialog)).toContain('Choose the testator');
    expect(page.text(dialog)).toContain('Say which office or site holds it.');
    expect(page.calls(SAFE_CUSTODY_CALLABLES.receive)).toHaveLength(0);

    await page.fill('Testator', 'ostler', dialog);
    await page.stable(250);
    await page.click('Bram Ostler', dialog);
    await page.fill('Dated', '14/02/2025', dialog);
    await page.click('Add another original', dialog);
    await page.fill('Site', 'Geelong', dialog);
    await page.fill('Safe or cabinet', 'Safe B', dialog);
    await page.fill('Slot or envelope', '7', dialog);
    await page.submit(dialog);
    await page.stable(10);

    expect(page.calls(SAFE_CUSTODY_CALLABLES.receive)).toEqual([
      {
        testatorContactId: 'c-bram',
        items: [
          { kind: 'will', description: '', date: '2025-02-14' },
          { kind: 'codicil', description: '' },
        ],
        location: { site: 'Geelong', cabinet: 'Safe B', slot: '7' },
        receivedOn: '2026-10-04',
        responsibleUid: ME,
        requestId: expect.any(String),
      },
    ]);
    expect(page.router.url).toBe('/safe-custody/sc-new-11');
    expect(status(page)).toBe('Held');
    expect(history(page)).toEqual(['Received']);
  });

  it('shows no receive button to read-only members', async () => {
    const page = await open('/safe-custody', { session: READONLY });
    expect(page.buttons('Receive a will')).toHaveLength(0);
    await page.router.navigateByUrl('/safe-custody/sc-bram');
    await page.stable(10);
    expect(page.buttons('Take out')).toHaveLength(0);
  });
});

describe('a packet', () => {
  it('shows its originals with the current will flagged, its details and chain of custody', async () => {
    const page = await open('/safe-custody/sc-bram');
    const originals = [...page.body.querySelectorAll('[aria-labelledby="sc-held-h"] li')].map((li) =>
      [...li.children].map((child) => page.text(child)).join(' '),
    );
    expect(originals).toEqual([
      'Will dated 14 Feb 2019 Last will',
      'Codicil dated 1 June 2021 Current',
      'Power of attorney dated 14 Feb 2019',
    ]);
    expect(page.text()).toContain('Geelong · Safe A · 1');
    expect(page.text()).toContain('Responsible lawyerYou');
    expect(history(page)).toEqual(['Received']);
    expect(page.buttons('Return to the safe')).toHaveLength(0);
  });

  it('records a will taken out and returned to a new slot', async () => {
    const page = await open('/safe-custody/sc-bram');
    await page.click('Take out');
    let dialog = page.dialog() as HTMLElement;
    await page.submit(dialog);
    expect(page.text(dialog)).toContain('Say who has it.');
    await page.fill('Who has it', 'Jordan Price', dialog);
    await page.fill('Why it’s out', 'Signing a codicil', dialog);
    await page.submit(dialog);
    await page.stable(10);
    expect(status(page)).toBe('Out');

    await page.click('Return to the safe');
    dialog = page.dialog() as HTMLElement;
    await page.fill('Slot or envelope', '9', dialog);
    await page.fill('Note', 'Codicil signed', dialog);
    await page.submit(dialog);
    await page.stable(10);
    expect(page.calls(SAFE_CUSTODY_CALLABLES.recordMovement)).toEqual([
      expect.objectContaining({ kind: 'out', to: 'Jordan Price', reason: 'Signing a codicil' }),
      expect.objectContaining({
        kind: 'returned',
        reason: 'Codicil signed',
        location: { site: 'Geelong', cabinet: 'Safe A', slot: '9' },
      }),
    ]);
    expect(status(page)).toBe('Held');
    expect(history(page)).toEqual(['Returned', 'Taken out', 'Received']);
    expect(page.text()).toContain('To Jordan Price');
  });

  it('releases an original only with an authority document from the testator’s matter', async () => {
    const page = await open('/safe-custody/sc-margaret');
    await page.click('Release');
    const dialog = page.dialog() as HTMLElement;
    await page.fill('Or name them', 'Avery Quill, executor', dialog);
    await page.fill('Why it’s released', 'Executor’s request after death', dialog);
    await page.submit(dialog);
    expect(page.text(dialog)).toContain('Choose the authority document.');

    await choose(page, 'Document', 'Signed authority.pdf', dialog);
    await page.submit(dialog);
    await page.stable(10);
    expect(page.calls(SAFE_CUSTODY_CALLABLES.recordMovement)).toEqual([
      {
        id: 'sc-margaret',
        kind: 'released',
        reason: 'Executor’s request after death',
        to: 'Avery Quill, executor',
        authority: { matterId: 'm-whitfield', documentId: AUTHORITY_DOC },
        requestId: expect.any(String),
      },
    ]);
    expect(status(page)).toBe('Released');
    expect(page.buttons('Take out')).toHaveLength(0);
    expect(page.body.querySelector('a[href="/matters/m-whitfield/documents/d-authority"]')).not.toBeNull();
  });

  it('asks the person to sign in again before a release when their sign-in is old', async () => {
    const page = await open('/safe-custody/sc-margaret', {
      session: testSession({ authTime: Date.now() - 30 * 60_000 }),
    });
    await page.click('Release');
    const dialog = page.dialog() as HTMLElement;
    await page.fill('Or name them', 'Avery Quill', dialog);
    await page.fill('Why it’s released', 'Executor’s request', dialog);
    await choose(page, 'Document', 'Signed authority.pdf', dialog);
    await page.submit(dialog);
    await page.stable(10);

    const reauth = page.body.querySelector<HTMLElement>('mt-reauth-dialog') as HTMLElement;
    expect(page.text(reauth)).toContain('Releasing an original will needs a fresh sign-in.');
    expect(page.calls(SAFE_CUSTODY_CALLABLES.recordMovement)).toHaveLength(0);
    await page.fill('Password', 'wrong', reauth);
    await page.submit(reauth);
    expect(page.text(reauth)).toContain('don’t match');
    await page.fill('Password', 'password', reauth);
    await page.submit(reauth);
    await page.stable(10);
    expect(page.calls(SAFE_CUSTODY_CALLABLES.recordMovement)).toHaveLength(1);
    expect(status(page)).toBe('Released');
  });

  it('signs in again and retries when the server still wants a recent sign-in', async () => {
    let refused = false;
    const page = await open('/safe-custody/sc-margaret', {
      callables: {
        [SAFE_CUSTODY_CALLABLES.recordMovement]: (data, fs) => {
          if (!refused) {
            refused = true;
            throw Object.assign(new Error('reauth'), { code: 'unauthenticated', details: { code: 'REAUTH_REQUIRED' } });
          }
          return safeCustodyServerCallables()[SAFE_CUSTODY_CALLABLES.recordMovement]?.(data, fs);
        },
      },
    });
    await page.click('Release');
    const dialog = page.dialog() as HTMLElement;
    await page.fill('Or name them', 'Avery Quill', dialog);
    await page.fill('Why it’s released', 'Executor’s request', dialog);
    await choose(page, 'Document', 'Signed authority.pdf', dialog);
    await page.submit(dialog);
    await page.stable(10);
    const reauth = page.body.querySelector<HTMLElement>('mt-reauth-dialog') as HTMLElement;
    await page.fill('Password', 'password', reauth);
    await page.submit(reauth);
    await page.stable(10);
    expect(page.calls(SAFE_CUSTODY_CALLABLES.recordMovement)).toHaveLength(2);
    expect(status(page)).toBe('Released');
  });

  it('keeps paralegals from releasing', async () => {
    const page = await open('/safe-custody/sc-margaret', { session: PARALEGAL });
    await page.click('Release');
    const dialog = page.dialog() as HTMLElement;
    expect(page.text(dialog)).toContain('Only a lawyer, admin or owner can release an original.');
    expect(page.buttons('Release', dialog).at(-1)?.hasAttribute('disabled')).toBe(true);
  });

  it('asks for a destruction, which a second lawyer confirms', async () => {
    const page = await open('/safe-custody/sc-margaret');
    await page.click('Destroy');
    const dialog = page.dialog() as HTMLElement;
    await page.fill('Why it’s destroyed', 'Testator’s written instruction', dialog);
    await choose(page, 'Document', 'Signed authority.pdf', dialog);
    await page.submit(dialog);
    await page.stable(10);
    expect(page.text()).toContain('Destruction needs a second lawyer');
    const pending = page.text(page.body.querySelector('[data-testid="pending-destruction"]'));
    expect(pending).toContain('You asked to destroy this original on 4 Oct 2026');
    expect(page.buttons('Confirm destruction')).toHaveLength(0);
    expect(page.buttons('Take out')[0]?.hasAttribute('disabled')).toBe(true);
  });

  it('records the destruction once a second lawyer confirms it', async () => {
    const page = await open('/safe-custody/sc-margaret', { session: ADMIN, uid: PRIYA, configure: pendingFrom(ME) });
    await page.click('Confirm destruction');
    const confirm = page.dialog() as HTMLElement;
    // The confirmation listens for the input event bubbling to its field.
    const typed = confirm.querySelector('input') as HTMLInputElement;
    typed.value = 'SC-000002';
    typed.dispatchEvent(new Event('input', { bubbles: true }));
    await page.stable();
    await page.click('Confirm destruction', confirm);
    await page.stable(10);
    expect(page.calls(SAFE_CUSTODY_CALLABLES.confirmDestruction)).toEqual([
      { id: 'sc-margaret', approve: true, requestId: expect.any(String) },
    ]);
    expect(status(page)).toBe('Destroyed');
    expect(page.text(page.body.querySelector('.mt-sc-history'))).toContain('Destroyed');
    expect(page.text(page.body.querySelector('.mt-sc-history'))).toContain('Confirmed by You');
  });

  it('lets the lawyer who asked withdraw a destruction', async () => {
    const page = await open('/safe-custody/sc-margaret', { configure: pendingFrom(ME) });
    await page.click('Withdraw');
    await page.stable(10);
    expect(page.calls(SAFE_CUSTODY_CALLABLES.confirmDestruction)).toEqual([
      { id: 'sc-margaret', approve: false, requestId: expect.any(String) },
    ]);
    expect(page.body.querySelector('[data-testid="pending-destruction"]')).toBeNull();
  });

  it('offers a probate matter when the testator has died', async () => {
    const page = await open('/safe-custody/sc-margaret');
    const banner = page.body.querySelector('[data-testid="testator-deceased"]');
    expect(page.text(banner)).toContain('Margaret Whitfield died on 22 July 2026.');
    expect(banner?.querySelector('a')?.getAttribute('href')).toBe('/matters/new?type=probate&deceased=c-margaret');
    // The matters she is on, such as the estate matter, link from the packet.
    expect(page.text(page.body.querySelector('[data-testid="testator-matters"]'))).toBe(
      'M-2026-0142 · Estate of Margaret Whitfield',
    );
  });

  it('edits the packet’s originals and responsible lawyer', async () => {
    const page = await open('/safe-custody/sc-bram');
    await page.click('Edit');
    const dialog = page.dialog() as HTMLElement;
    await page.click('Remove original 3', dialog);
    await choose(page, 'Responsible lawyer', 'Priya Shah', dialog);
    await page.fill('Notes', 'Client keeps a copy', dialog);
    await page.submit(dialog);
    await page.stable(10);
    expect(page.calls(SAFE_CUSTODY_CALLABLES.update)).toEqual([
      {
        id: 'sc-bram',
        items: [
          { kind: 'will', description: 'Last will', date: '2019-02-14' },
          { kind: 'codicil', description: '', date: '2021-06-01' },
        ],
        location: { site: 'Geelong', cabinet: 'Safe A', slot: '1' },
        responsibleUid: PRIYA,
        matterId: null,
        notes: 'Client keeps a copy',
        requestId: expect.any(String),
      },
    ]);
    expect(page.text()).toContain('Responsible lawyerPriya Shah');
  });

  it('makes the receipt PDF and downloads it', async () => {
    const page = await open('/safe-custody/sc-bram');
    await page.click('Receipt PDF');
    await page.stable(10);
    expect(page.calls(SAFE_CUSTODY_CALLABLES.receipt)).toEqual([{ id: 'sc-bram', requestId: expect.any(String) }]);
    expect(page.calls('jobs-getExportUrl')).toEqual([{ jobId: 'job-receipt' }]);
    expect(page.navigated).toEqual(['https://storage.example.test/job-receipt.pdf']);
  });

  it('says when a packet isn’t in the register', async () => {
    const page = await open('/safe-custody/sc-missing');
    expect(page.text()).toContain('This packet isn’t in the register');
  });
});

describe('the stocktake', () => {
  it('lists held packets by site and cabinet and marks the ticked ones found today', async () => {
    const page = await open('/safe-custody/stocktake');
    const table = page.body.querySelector('mt-safe-custody-stocktake mt-table') as HTMLElement;
    expect(page.text(table)).toContain('Geelong · Safe A');
    expect(page.text(table)).toContain('Melbourne · Strongroom');
    expect(page.text(table)).not.toContain('Wilfred Larch');
    expect(page.text()).toContain('2 packets held');

    page.body.querySelector<HTMLElement>('[aria-label="Select SC-000001 Bram Ostler"]')?.click();
    await page.stable();
    await page.click('Mark found');
    await page.stable(10);
    expect(page.calls(SAFE_CUSTODY_CALLABLES.verify)).toEqual([
      { ids: ['sc-bram'], on: '2026-10-04', requestId: expect.any(String) },
    ]);
    expect(page.text()).toContain('1 packet marked found');
    expect(packet(page, 'sc-bram')['lastVerified']).toEqual({ on: '2026-10-04', by: ME });
  });

  it('prints one site’s stocktake', async () => {
    const page = await open('/safe-custody/stocktake');
    await choose(page, 'Site', 'Melbourne');
    expect(page.text()).toContain('1 packet held');
    await page.click('Stocktake PDF');
    await page.stable(10);
    expect(page.calls(SAFE_CUSTODY_CALLABLES.stocktakeReport)).toEqual([
      { site: 'Melbourne', requestId: expect.any(String) },
    ]);
    expect(page.navigated).toEqual(['https://storage.example.test/job-stocktake.pdf']);
  });
});

describe('the contact screen', () => {
  it('lists the testator’s packets and receives a new one for them', async () => {
    const page = await open('/contacts?contact=c-bram');
    // The section renders once the contact and then its packets have loaded, which a busy full run
    // can take longer than one settle for.
    const section = await vi.waitFor(() => {
      const found = page.body.querySelector<HTMLElement>('mt-contact-packets');
      expect(page.text(found)).toContain('SC-000001');
      return found as HTMLElement;
    });
    expect(page.text(section)).toContain('Geelong · Safe A · 1');
    await page.click('Receive a will', section);
    await page.stable(10);
    const dialog = page.dialog() as HTMLElement;
    expect(page.text(dialog.querySelector('[data-testid="chosen-contact"]'))).toBe('Bram Ostler');
  });
});
