import type { InMemoryFirestore } from '@materia/data-access/repository';

import { cleanUpOverlays, contactDoc, MATTER, openMatter, ORG, READONLY } from './testing';

/** The matter header's referral (CORE-18): who referred the matter, or its source. Fictional data only. */

beforeAll(() => import('./referral-dialog'));
afterEach(cleanUpOverlays);

const withReferrer = {
  configure: (fs: InMemoryFirestore) =>
    fs.set(
      `orgs/${ORG}/contacts/c-lighthouse`,
      contactDoc('Dana', 'Lighthouse', { isReferrer: true, referrerMeta: { industry: 'financial_planner' } }),
    ),
};

describe('the matter referral', () => {
  it('shows "Not recorded", then records a referrer (listed first) and links to them', async () => {
    const page = await openMatter('/matters/m-whitfield/overview', withReferrer);
    const field = () => page.header()?.querySelector('[data-testid="matter-referral"]');
    expect(page.text(field())).toContain('Not recorded');

    await page.click('Change referral');
    await page.stable(20);
    expect(page.text(page.dialog())).toContain('Referral for M-2026-0142');
    // Referrers are offered before anything is typed.
    await page.click('Dana Lighthouse', page.dialog() ?? undefined);
    expect(page.dialog()).toBeNull();
    expect(page.firestore.get(MATTER)).toMatchObject({ referrerContactId: 'c-lighthouse' });
    expect(page.text(field())).toContain('Dana Lighthouse');
    const link = field()?.querySelector<HTMLAnchorElement>('a.mt-chip');
    expect(link?.getAttribute('href')).toBe('/contacts?contact=c-lighthouse');
  });

  it('switches to a source (clearing the referrer) and clears it', async () => {
    const page = await openMatter('/matters/m-whitfield/overview', {
      ...withReferrer,
      matter: { referrerContactId: 'c-lighthouse' },
    });
    const field = () => page.header()?.querySelector('[data-testid="matter-referral"]');
    expect(page.text(field())).toContain('Dana Lighthouse');

    await page.click('Change referral');
    await page.stable(20);
    // Native select options are indexed: 0 "Choose a source", 1 Unknown, 2 Website.
    await page.fill('Or the source', '2');
    await page.click('Save source', page.dialog() ?? undefined);
    expect(page.firestore.get(MATTER)?.['referralSource']).toBe('website');
    expect(page.firestore.get(MATTER)?.['referrerContactId']).toBeUndefined();
    expect(page.text(field())).toContain('Website');

    await page.click('Change referral');
    await page.stable(20);
    await page.click('Clear referral', page.dialog() ?? undefined);
    expect(page.firestore.get(MATTER)?.['referralSource']).toBeUndefined();
    expect(page.text(field())).toContain('Not recorded');
  });

  it('is read-only for the readonly role', async () => {
    const page = await openMatter('/matters/m-whitfield/overview', {
      ...withReferrer,
      session: READONLY,
      matter: { referralSource: 'existing_client' },
    });
    expect(page.text(page.header()?.querySelector('[data-testid="matter-referral"]'))).toContain('Existing client');
    expect(page.buttons('Change referral')).toHaveLength(0);
  });
});
