import { TestBed } from '@angular/core/testing';

import { cleanUpOverlays, MATTER, meta, openMatter, ORG, READONLY } from './testing';

/** The stage stepper (CORE-06). Fictional data only. */

afterEach(cleanUpOverlays);

const stepper = (page: Awaited<ReturnType<typeof openMatter>>) => page.body.querySelector('mt-estate-stepper');
const stage = (page: Awaited<ReturnType<typeof openMatter>>, title: string) =>
  [...(stepper(page)?.querySelectorAll<HTMLElement>('button') ?? [])].find((b) => b.textContent?.includes(title));

describe('stages', () => {
  it('shows the type’s stages with the current one, and their criteria', async () => {
    const page = await openMatter(undefined, { matter: { stageId: 'grant_application' } });
    const titles = [...(stepper(page)?.querySelectorAll('li') ?? [])].map((li) => page.text(li));
    expect(titles).toEqual([
      'Intake, complete',
      'Grant application, current',
      'Grant issued',
      'Collection',
      'Distribution',
      'Finalisation',
    ]);
    stage(page, 'Grant issued')?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    stage(page, 'Grant issued')?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    await page.stable(500);
    expect(page.body.querySelector('.mt-tooltip')?.textContent?.trim()).toBe('Grant received from the court');
  });

  it('uses the template’s stages when the matter has one', async () => {
    const page = await openMatter(undefined, {
      matter: { templateId: 'tpl-probate', stageId: 'papers' },
      configure: (fs) =>
        fs.set(`orgs/${ORG}/templates/tpl-probate`, {
          name: 'Probate (fictional)',
          matterType: 'probate',
          version: 1,
          stages: [
            { id: 'intake', title: 'First meeting' },
            { id: 'papers', title: 'Papers' },
          ],
          tasks: [],
          published: true,
          source: 'org',
          ...meta,
        }),
    });
    const titles = [...(stepper(page)?.querySelectorAll('li') ?? [])].map((li) => page.text(li));
    expect(titles).toEqual(['First meeting, complete', 'Papers, current']);
  });

  it('moves to another stage through matters-changeStage', async () => {
    const page = await openMatter();
    stage(page, 'Grant application')?.click();
    await page.stable();
    expect(page.calls('matters-changeStage')).toEqual([
      { matterId: 'm-whitfield', stageId: 'grant_application', requestId: expect.any(String) },
    ]);
    expect(page.firestore.get(MATTER)?.['stageId']).toBe('grant_application');
    expect(page.text()).toContain('Moved to Grant application');
  });

  it('lists the missing key facts when the move needs them, and records one from there', async () => {
    const page = await openMatter('/matters/m-whitfield/parties');
    stage(page, 'Grant issued')?.click();
    await page.stable();
    const note = page.body.querySelector('mt-matter-stages mt-note');
    expect(page.text(note)).toContain('To move to Grant issued, record:');
    expect(page.firestore.get(MATTER)?.['stageId']).toBe('intake');

    await page.click('Grant date', note ?? page.body);
    expect(page.router.url).toBe('/matters/m-whitfield/overview');
    const input = page.body.querySelector<HTMLInputElement>('mt-key-facts form input');
    expect(document.activeElement).toBe(input);
    await page.fill('Grant date', '30/09/2026');
    await page.submit(page.body.querySelector('mt-key-facts'));

    expect(page.text(page.body.querySelector('mt-matter-stages mt-note'))).toContain('Everything Grant issued needs');
    await page.click('Move to Grant issued');
    expect(page.firestore.get(MATTER)?.['stageId']).toBe('grant_issued');
    expect(page.body.querySelector('mt-matter-stages mt-note')).toBeNull();
  });

  it('says why a closed matter’s stage can’t move', async () => {
    const page = await openMatter(undefined, {
      callables: {
        'matters-changeStage': () => {
          throw {
            code: 'functions/failed-precondition',
            details: { code: 'FAILED_PRECONDITION', reason: 'matter_closed' },
          };
        },
      },
    });
    stage(page, 'Collection')?.click();
    await page.stable();
    expect(page.text()).toContain('Reopen the matter before changing its stage.');
  });

  it('is read-only for read-only members and on closed matters', async () => {
    const page = await openMatter(undefined, { session: READONLY });
    expect(stepper(page)?.querySelector('button')).toBeNull();
    expect(page.text(stepper(page))).toContain('Intake');
    TestBed.resetTestingModule();

    const closed = await openMatter(undefined, { matter: { status: 'closed' } });
    expect(stepper(closed)?.querySelector('button')).toBeNull();
  });
});
