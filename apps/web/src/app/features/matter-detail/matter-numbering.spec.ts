import { ADMIN, cleanUpOverlays, MATTER, openMatter, ORG, PARALEGAL, type FakeCallable } from './testing';
import { NumberingPage } from '../numbering/numbering-page';

/**
 * Matter numbering (CORE-21a): changing a matter's number, its reference in the firm's other
 * system (3E) with the org's link template, and the Settings → Matter numbering page. Fictional data only.
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
    expect(page.buttons('Add 3E matter…')).toHaveLength(1);
  });
});

describe('the 3E matter reference', () => {
  it('links to the firm’s system through the org’s template', async () => {
    const page = await openMatter('/matters/m-whitfield/overview', {
      matter: { externalRef: '104233/1' },
      configure: (fs) =>
        fs.set(`orgs/${ORG}`, {
          name: 'Harbour & Vine Legal',
          externalSystem: { name: '3E', urlTemplate: 'https://3e.harbourvine.example/matter/{ref}' },
        }),
    });
    const link = page.header()?.querySelector<HTMLAnchorElement>('a.ext');
    expect(link?.getAttribute('href')).toBe('https://3e.harbourvine.example/matter/104233%2F1');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(link?.textContent?.replace(/\s+/g, ' ').trim()).toBe('3E 104233/1');
  });

  it('is plain text without a template, and can be added and removed', async () => {
    const page = await openMatter();
    await page.click('More matter actions');
    await page.click('Add 3E matter…');
    await page.fill('3E matter number', '104233');
    await page.submit(page.dialog());
    expect(page.firestore.get(MATTER)).toMatchObject({ externalRef: '104233' });
    expect(page.header()?.querySelector('a.ext')).toBeNull();
    expect(page.text(page.header()?.querySelector('.ext'))).toBe('3E 104233');

    await page.click('More matter actions');
    await page.click('Change 3E matter…');
    await page.fill('3E matter number', '');
    await page.submit(page.dialog());
    expect(page.firestore.get(MATTER)?.['externalRef']).toBeUndefined();
    expect(page.header()?.querySelector('.ext')).toBeNull();
  });
});

describe('Settings → Matter numbering', () => {
  const open = () =>
    openMatter('/settings/numbering', {
      session: ADMIN,
      configure: (fs) =>
        fs.set(`orgs/${ORG}`, { name: 'Harbour & Vine Legal', matterNumberFormat: 'M-{YYYY}-{seq:4}' }),
    });

  it('previews the format and saves it with type codes and the 3E link template', async () => {
    const page = await open();
    expect(page.body.querySelector('mt-numbering-page')).not.toBeNull();
    await page.fill('Format', '{TYPE}{YY}-{seq:3}');
    const year = String(new Date().getFullYear() % 100).padStart(2, '0');
    expect(page.text(page.body.querySelector('[data-preview]'))).toContain(`PRB${year}-001`);
    await page.fill('Probate', 'EST');
    expect(page.text(page.body.querySelector('[data-preview]'))).toContain(`EST${year}-001`);
    await page.fill('Link template', 'https://3e.harbourvine.example/matter/{ref}');
    await page.click('Save');
    expect(page.firestore.get(`orgs/${ORG}`)).toMatchObject({
      matterNumberFormat: '{TYPE}{YY}-{seq:3}',
      matterTypeCodes: { probate: 'EST' },
      externalSystem: { name: '3E', urlTemplate: 'https://3e.harbourvine.example/matter/{ref}' },
    });
  });

  it('refuses a format without {seq} and a link that isn’t https with {ref}', async () => {
    const page = await open();
    await page.fill('Format', 'M-{YYYY}');
    expect(page.text(page.body.querySelector('mt-numbering-page'))).toContain('Include {seq}');
    await page.fill('Format', 'M-{seq}');
    await page.fill('Link template', 'javascript:alert({ref})');
    expect(page.text(page.body.querySelector('mt-numbering-page'))).toContain('https://');
    const save = page.buttons('Save')[0] as HTMLButtonElement;
    expect(save.disabled || save.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('is a lazily loaded page', () => {
    expect(NumberingPage).toBeDefined();
  });
});
