import { ADMIN, cleanUpOverlays, MATTER, openMatter, ORG, PARALEGAL, type FakeCallable } from './testing';
import { NumberingPage } from '../numbering/numbering-page';

/**
 * Matter numbering (CORE-21a): changing a matter's number, linking it to a web address (the same
 * matter in 3E, say), and the Settings → Matter numbering page. Fictional data only.
 */

afterEach(cleanUpOverlays);

const renumber: FakeCallable = (data, fs) => {
  if (String(data['number']).toUpperCase() === 'M-2026-0001') {
    throw { code: 'functions/already-exists', details: { code: 'ALREADY_EXISTS', number: data['number'] } };
  }
  fs.set(MATTER, { ...fs.get(MATTER), number: data['number'] });
  return { matterId: data['matterId'], number: data['number'], changed: true };
};

describe('changing a matter number', () => {
  it('renumbers from the "…" menu and refuses a number another matter has', async () => {
    const page = await openMatter('/matters/m-whitfield/overview', { callables: { 'matters-renumber': renumber } });
    await page.click('More matter actions');
    await page.click('Change matter number…');
    await page.fill('Matter number', 'M-2026-0001');
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('Another matter already has M-2026-0001.');

    await page.fill('Matter number', '3E-104233');
    await page.submit(page.dialog());
    expect(page.calls('matters-renumber').at(-1)).toMatchObject({ matterId: 'm-whitfield', number: '3E-104233' });
    expect(page.dialog()).toBeNull();
    expect(page.text(page.header())).toContain('3E-104233');
  });

  it('is not offered to a paralegal', async () => {
    const page = await openMatter('/matters/m-whitfield/overview', { session: PARALEGAL });
    await page.click('More matter actions');
    expect(page.buttons('Change matter number…')).toHaveLength(0);
    expect(page.buttons('Add link…')).toHaveLength(1);
  });
});

describe('the matter link', () => {
  const LINK = 'https://3e.harbourvine.example/matter/104233';

  it('is added from the "…" menu and turns the number into a link', async () => {
    const page = await openMatter();
    expect(page.header()?.querySelector('a.num')).toBeNull();
    await page.click('More matter actions');
    expect(page.buttons('Add 3E matter…')).toHaveLength(0);
    await page.click('Add link…');
    await page.fill('Web address', 'not a link');
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('Enter a web address');
    await page.fill('Web address', '3e.harbourvine.example/matter/104233');
    await page.submit(page.dialog());
    expect(page.dialog()).toBeNull();
    expect(page.firestore.get(MATTER)).toMatchObject({ externalUrl: LINK });

    const link = page.header()?.querySelector<HTMLAnchorElement>('a.num');
    expect(link?.getAttribute('href')).toBe(LINK);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
    // The label is the matter number with a link icon, not the address.
    expect(link?.textContent?.replace(/\s+/g, ' ').trim()).toBe('M-2026-0142');
    expect(link?.querySelector('mt-icon')).not.toBeNull();
  });

  it('can be edited and removed', async () => {
    const page = await openMatter('/matters/m-whitfield/overview', { matter: { externalUrl: LINK } });
    await page.click('More matter actions');
    await page.click('Edit link…');
    await page.fill('Web address', 'https://3e.harbourvine.example/matter/9');
    await page.submit(page.dialog());
    expect(page.firestore.get(MATTER)).toMatchObject({ externalUrl: 'https://3e.harbourvine.example/matter/9' });
    await page.click('More matter actions');
    await page.click('Remove link');
    expect(page.firestore.get(MATTER)?.['externalUrl']).toBeUndefined();
    expect(page.header()?.querySelector('a.num')).toBeNull();
  });

  it('is never rendered for a non-http address', async () => {
    const page = await openMatter('/matters/m-whitfield/overview', { matter: { externalUrl: 'javascript:alert(1)' } });
    expect(page.text(page.header())).toContain('M-2026-0142');
    expect(page.header()?.querySelector('a.num')).toBeNull();
  });

  it('shows on the matters list as the underlined number', async () => {
    // The list orders by last activity (matters-denormalise keeps it).
    const page = await openMatter('/matters', {
      matter: { externalUrl: LINK, lastActivityAt: new Date('2026-10-03T00:00:00Z') },
    });
    const link = page.body.querySelector<HTMLAnchorElement>('a.mt-matters-link');
    expect(link?.getAttribute('href')).toBe(LINK);
    expect(link?.textContent?.trim()).toBe('M-2026-0142');
    link?.click();
    await page.stable();
    // Following the link doesn't also open the matter in the app.
    expect(page.router.url).toBe('/matters');
  });
});

describe('Settings → Matter numbering', () => {
  const open = () =>
    openMatter('/settings/numbering', {
      session: ADMIN,
      configure: (fs) =>
        fs.set(`orgs/${ORG}`, { name: 'Harbour & Vine Legal', matterNumberFormat: 'M-{YYYY}-{seq:4}' }),
    });

  it('previews the format and saves it with type codes', async () => {
    const page = await open();
    expect(page.body.querySelector('mt-numbering-page')).not.toBeNull();
    await page.fill('Format', '{TYPE}{YY}-{seq:3}');
    const year = String(new Date().getFullYear() % 100).padStart(2, '0');
    expect(page.text(page.body.querySelector('[data-preview]'))).toContain(`PRB${year}-001`);
    await page.fill('Probate', 'EST');
    expect(page.text(page.body.querySelector('[data-preview]'))).toContain(`EST${year}-001`);
    await page.click('Save');
    expect(page.firestore.get(`orgs/${ORG}`)).toMatchObject({
      matterNumberFormat: '{TYPE}{YY}-{seq:3}',
      matterTypeCodes: { probate: 'EST' },
    });
  });

  it('refuses a format without {seq}', async () => {
    const page = await open();
    await page.fill('Format', 'M-{YYYY}');
    expect(page.text(page.body.querySelector('mt-numbering-page'))).toContain('Include {seq}');
    const save = page.buttons('Save')[0] as HTMLButtonElement;
    expect(save.disabled || save.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('is a lazily loaded page', () => {
    expect(NumberingPage).toBeDefined();
  });
});
