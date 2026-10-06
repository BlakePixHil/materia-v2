import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { TENANCY_PORT } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { DEFAULT_DISBURSEMENT_PRESETS } from '@materia/domain';
import { MT_KEYBOARD_PLATFORM } from '@materia/ui';

import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { provideTestFlags } from '../../core/flags/testing';
import { FakeTenancyPort } from '../../core/orgs/testing';

/** Settings → Billing and rates → Disbursement presets (BILL-04). A fictional practice only. */

const ORG = 'org-harbour-vine';
const ADMIN = testSession({ claims: { orgId: ORG, role: 'admin', orgName: 'Harbour & Vine Legal' } });
const PRESETS = `orgs/${ORG}/settings/disbursementPresets`;
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const meta = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: 'seed',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  updatedBy: 'seed',
  schemaVersion: 1,
};

async function open(flags: Record<string, boolean>, seed: (fs: InMemoryFirestore) => void = () => undefined) {
  const firestore = new InMemoryFirestore();
  firestore.set(`orgs/${ORG}`, {
    name: 'Harbour & Vine Legal',
    billing: { unitMinutes: 6, rounding: 'up', gstRegistered: true, defaultRateCents: 45000 },
    ...meta,
  });
  seed(firestore);
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      { provide: AUTH_PORT, useValue: new FakeAuthPort(ADMIN) },
      { provide: TENANCY_PORT, useValue: new FakeTenancyPort() },
      provideInMemoryFirestore(firestore),
      ...provideTestFlags(flags),
    ],
  });
  const fixture = TestBed.createComponent(App);
  await TestBed.inject(Router).navigateByUrl('/settings/billing');
  const stable = async () => {
    await settle();
    await fixture.whenStable();
    await settle();
  };
  await stable();
  const card = () => document.body.querySelector<HTMLElement>('mt-disbursement-presets-settings');
  /** `amount-0`: the Amount field of the first preset row. */
  const field = (name: string) => {
    const [kind, index] = name.split('-') as [string, string];
    const label = { label: 'Name', amount: 'Amount ex GST' }[kind] ?? kind;
    const row = card()?.querySelectorAll('.preset')[Number(index)];
    const host = [...(row?.querySelectorAll('mt-text-field, mt-select') ?? [])].find((f) =>
      f.querySelector('.mt-label')?.textContent?.trim().startsWith(label),
    );
    return host?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select') ?? null;
  };
  const click = async (text: string) => {
    const button = [...(card()?.querySelectorAll<HTMLElement>('button') ?? [])].find(
      (b) => b.textContent?.trim().startsWith(text) || b.getAttribute('aria-label') === text,
    );
    if (!button) throw new Error(`No button "${text}"`);
    button.click();
    await stable();
  };
  const type = async (name: string, value: string) => {
    const input = field(name) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await stable();
  };
  return { firestore, card, field, click, type, stable };
}

describe('disbursement presets settings', () => {
  it('is hidden while billing.disbursements is off', async () => {
    const page = await open({});
    expect(page.card()).toBeNull();
  });

  it('shows the starting presets until the org saves its own, then saves an edited list', async () => {
    const page = await open({ 'billing.disbursements': true });
    expect(page.field('label-0')?.value).toBe(DEFAULT_DISBURSEMENT_PRESETS[0]?.label);
    expect(page.card()?.querySelectorAll('.preset')).toHaveLength(DEFAULT_DISBURSEMENT_PRESETS.length);

    await page.type('amount-0', '345.60');
    await page.click('Remove Courier');
    await page.click('Add preset');
    const last = DEFAULT_DISBURSEMENT_PRESETS.length - 1;
    await page.click('Save presets');
    expect(page.card()?.textContent).toContain('Every preset needs a name.');
    await page.type(`label-${last}`, 'Photocopying');
    await page.click('Save presets');

    const saved = page.firestore.get(PRESETS) as { presets: Record<string, unknown>[] };
    expect(saved.presets).toHaveLength(DEFAULT_DISBURSEMENT_PRESETS.length);
    expect(saved.presets[0]).toMatchObject({ id: 'vsc-grant-filing', defaultAmountCents: 34_560 });
    expect(saved.presets.some((p) => p['id'] === 'courier')).toBe(false);
    expect(saved.presets.at(-1)).toMatchObject({
      id: 'preset',
      label: 'Photocopying',
      category: 'other',
      gstTreatment: 'taxable',
    });
  });

  it('updates a saved list in place', async () => {
    const page = await open({ 'billing.disbursements': true }, (fs) =>
      fs.set(PRESETS, {
        presets: [{ id: 'courier', label: 'Courier', category: 'courier', gstTreatment: 'taxable' }],
        ...meta,
      }),
    );
    expect(page.card()?.querySelectorAll('.preset')).toHaveLength(1);
    await page.type('amount-0', 'abc');
    await page.click('Save presets');
    expect(page.card()?.textContent).toContain('Enter the amount for “Courier” in dollars');
    await page.type('amount-0', '12.50');
    await page.click('Save presets');
    expect(page.firestore.get(PRESETS)).toMatchObject({
      presets: [{ id: 'courier', label: 'Courier', defaultAmountCents: 1_250 }],
      createdBy: 'seed',
    });
  });
});
