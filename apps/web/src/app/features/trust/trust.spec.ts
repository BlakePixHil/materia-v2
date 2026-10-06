import { ADMIN, cleanUpOverlays, meta, openMatter, ORG, PARALEGAL } from '../matter-detail/testing';

/**
 * Trust balance snapshots (BILL-11, ADR-035): the matter's "Held in trust" stat and its Update
 * dialog, and Settings → Trust account. Display only. A fictional practice only.
 */

afterEach(cleanUpOverlays);

type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;

const TRUST_ON = { 'billing.trustDisplay': true };
const SNAPSHOT = `orgs/${ORG}/trustSnapshots/m-whitfield`;

function practice(trust: Seed | null = { showOnMatters: true, system: 'smokeball', staleAfterDays: 30 }) {
  return (fs: Page['firestore']) => {
    fs.set(`orgs/${ORG}`, {
      name: 'Harbour & Vine Legal',
      timezone: 'Australia/Melbourne',
      ...(trust ? { trust } : {}),
    });
  };
}

const snapshot = (data: Seed = {}): Seed => ({
  matterId: 'm-whitfield',
  amountCents: 8_421_000,
  asAt: '2026-10-02',
  source: 'manual',
  sourceSystemName: 'Smokeball',
  recordedBy: 'user-priya',
  recordedAt: new Date('2026-10-02T03:00:00Z'),
  ...meta,
  ...data,
});

/** trust-recordSnapshot as the server runs it. */
const recordSnapshot = ({ requestId: _requestId, ...data }: Seed, fs: Page['firestore']) => {
  fs.set(`orgs/${ORG}/trustSnapshots/${String(data['matterId'])}`, snapshot({ ...data, _requestId }));
  return { saved: true };
};

/** Waits for the lazily loaded dialog. */
async function opened(page: Page): Promise<HTMLElement> {
  const dialog = await vi.waitFor(async () => {
    await page.stable(10);
    const shown = page.dialog();
    if (!shown) throw new Error('The dialog hasn’t opened yet');
    return shown;
  });
  await page.stable();
  return dialog;
}

const card = (page: Page) => page.body.querySelector<HTMLElement>('[data-testid="matter-trust"]');

describe('Held in trust (matter overview)', () => {
  it('shows the copied balance with its as-at date, source and "Not the trust ledger"', async () => {
    const page = await openMatter(undefined, {
      flags: TRUST_ON,
      configure: (fs) => {
        practice()(fs);
        fs.set(SNAPSHOT, snapshot());
      },
    });
    const parts = [...(card(page)?.querySelectorAll('.k h2, .k button, .v, .f') ?? [])].map((part) => page.text(part));
    expect(parts).toEqual([
      'Held in trust',
      'Update',
      '$84,210.00',
      'as at 2 Oct 2026 · from Smokeball',
      'Not the trust ledger',
    ]);
    // No ledger actions, and no "available" amount, anywhere on the page.
    for (const word of ['Deposit', 'Withdraw', 'Transfer', 'Available']) {
      expect(page.buttons(word)).toHaveLength(0);
      expect(page.text()).not.toContain(`${word} `);
    }
  });

  it('marks a balance older than the threshold out of date', async () => {
    const page = await openMatter(undefined, {
      flags: TRUST_ON,
      configure: (fs) => {
        practice({ showOnMatters: true, system: 'leap', staleAfterDays: 30 })(fs);
        fs.set(SNAPSHOT, snapshot({ asAt: '2026-08-28', sourceSystemName: 'LEAP' }));
      },
    });
    expect(page.text(card(page))).toContain('Out of date');
    expect(page.text(card(page))).toContain('as at 28 Aug 2026 · from LEAP');
  });

  it('shows an empty state with Update, not $0.00, and records a balance through the dialog', async () => {
    const page = await openMatter(undefined, {
      flags: TRUST_ON,
      configure: practice(),
      callables: { 'trust-recordSnapshot': recordSnapshot },
    });
    expect(page.text(card(page))).toContain('No balance recorded yet. Copy it from Smokeball.');
    expect(page.text(card(page))).not.toContain('$0.00');

    await page.click('Update trust balance');
    const dialog = await opened(page);
    expect(page.text(dialog)).toContain('Update trust balance');
    expect(page.text(dialog)).toContain('Copy the balance from Smokeball. The change is recorded in the audit log.');
    // As at defaults to today.
    expect(
      dialog.querySelector<HTMLInputElement>('input[name="asAt"], mt-text-field:nth-of-type(2) input')?.value,
    ).toBe('04/10/2026');

    // A future as-at date is refused before anything is sent.
    await page.fill('Amount', '84,210.00', dialog);
    await page.fill('As at', '05/10/2026', dialog);
    await page.submit(dialog);
    expect(page.text(dialog)).toContain('The as-at date can’t be in the future');
    expect(page.calls('trust-recordSnapshot')).toHaveLength(0);

    await page.fill('As at', '03/10/2026', dialog);
    await page.fill('Note', 'Trust ledger report 3 Oct', dialog);
    await page.submit(dialog);
    expect(page.calls('trust-recordSnapshot')).toEqual([
      expect.objectContaining({
        matterId: 'm-whitfield',
        amountCents: 8_421_000,
        asAt: '2026-10-03',
        note: 'Trust ledger report 3 Oct',
      }),
    ]);
    expect(page.dialog()).toBeNull();
    await page.stable();
    expect(page.text(card(page))).toContain('$84,210.00');
  });

  it('is hidden from roles without billing access, and reads nothing for them', async () => {
    const page = await openMatter(undefined, {
      session: PARALEGAL,
      flags: TRUST_ON,
      configure: (fs) => {
        practice()(fs);
        fs.set(SNAPSHOT, snapshot());
      },
    });
    expect(card(page)).toBeNull();
    expect(page.text()).not.toContain('Held in trust');
  });

  it('is hidden while the flag is off', async () => {
    const page = await openMatter(undefined, {
      configure: (fs) => {
        practice()(fs);
        fs.set(SNAPSHOT, snapshot());
      },
    });
    expect(card(page)).toBeNull();
  });

  it('is hidden while the practice’s switch is off, and the snapshot is kept', async () => {
    const page = await openMatter(undefined, {
      flags: TRUST_ON,
      configure: (fs) => {
        practice({ showOnMatters: false, system: 'smokeball', staleAfterDays: 30 })(fs);
        fs.set(SNAPSHOT, snapshot());
      },
    });
    expect(card(page)).toBeNull();
    expect(page.firestore.get(SNAPSHOT)).toBeDefined();
  });
});

describe('Settings → Trust account', () => {
  const save = (data: Seed, fs: Page['firestore']) => {
    const org = fs.get(`orgs/${ORG}`) ?? {};
    fs.set(`orgs/${ORG}`, { ...org, trust: data['settings'] });
    return { saved: true };
  };

  it('shows the fixed explanation, and saves the switch, the records and the threshold', async () => {
    const page = await openMatter('/settings/trust', {
      session: ADMIN,
      flags: TRUST_ON,
      configure: practice(null),
      callables: { 'trust-updateSettings': save },
    });
    expect(page.text(page.body.querySelector('h1'))).toBe('Trust account');
    expect(page.text(page.body.querySelector('[data-testid="trust-explainer"]'))).toBe(
      'Materia shows a trust balance you copy from your trust records. It is not the trust ledger. Always check your trust records before paying money out.',
    );
    // Off until turned on; out of date after 30 days by default.
    const toggle = page.body.querySelector<HTMLElement>('mt-switch [role="switch"], mt-switch button') as HTMLElement;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(page.body.querySelector<HTMLInputElement>('input[name="staleAfterDays"]')?.value ?? '').toBe('');

    toggle.click();
    await page.stable();
    // "Other" needs a name.
    await page.click('Save');
    expect(page.text()).toContain('Name the trust records');
    expect(page.calls('trust-updateSettings')).toHaveLength(0);
    await page.fill('Name of your trust records', 'In-house trust records');
    await page.fill('Mark a balance out of date after', '45');
    await page.click('Save');
    expect(page.calls('trust-updateSettings')).toEqual([
      expect.objectContaining({
        settings: { showOnMatters: true, system: 'other', otherName: 'In-house trust records', staleAfterDays: 45 },
      }),
    ]);
  });

  it('is in the sidebar for owners and admins while the flag is on', async () => {
    const page = await openMatter('/settings/practice', { session: ADMIN, flags: TRUST_ON, configure: practice() });
    expect(page.buttons('Trust account').length).toBeGreaterThan(0);
  });

  it('is not in the sidebar while the flag is off', async () => {
    const page = await openMatter('/settings/practice', { session: ADMIN, configure: practice() });
    expect(page.buttons('Trust account')).toHaveLength(0);
  });
});
