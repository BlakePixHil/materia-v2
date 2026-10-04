import { TestBed } from '@angular/core/testing';

import { cleanUpOverlays, LAWYER, MATTER, ME, openMatter, PARALEGAL, PRIYA, READONLY } from './testing';
import { ShortcutService } from '../../core/shortcuts/shortcut.service';

/** The matter screen's frame and header (CORE-06). Fictional data only. */

afterEach(cleanUpOverlays);

describe('matter header', () => {
  it('shows the number, type, conflict status, title, status, people, labels, stages and tabs', async () => {
    const page = await openMatter();
    const header = page.text(page.header());
    expect(header).toContain('M-2026-0142');
    expect(header).toContain('Probate');
    expect(header).toContain('Conflict check clear');
    expect(page.header()?.querySelector('h1')?.textContent?.trim()).toBe('Estate of Margaret Whitfield');
    expect(page.buttons('Status: Open. Change status')).toHaveLength(1);
    expect(header).toContain('Jordan Price');
    expect(page.header()?.querySelector('mt-avatar-group')?.getAttribute('aria-label')).toBe('Priya Shah');
    expect(header).toContain('grant');
    const stepper = page.body.querySelector('mt-estate-stepper li[aria-current="step"]');
    expect(page.text(stepper)).toContain('Intake');
    const tabs = [...page.body.querySelectorAll('nav[aria-label="Matter sections"] a')].map((a) => page.text(a));
    expect(tabs).toEqual([
      'Overview',
      'Tasks',
      'Deadlines',
      'Documents',
      'Time',
      'Parties',
      'Estate',
      'Notes',
      'Activity',
    ]);
  });

  it('shows the Litigation tab for disputes only, and sends its URL elsewhere to the overview', async () => {
    const probate = await openMatter('/matters/m-whitfield/litigation');
    expect(probate.router.url).toBe('/matters/m-whitfield/overview');
    TestBed.resetTestingModule();

    const contest = await openMatter('/matters/m-whitfield/litigation', { matter: { type: 'contest' } });
    expect(contest.router.url).toBe('/matters/m-whitfield/litigation');
    expect(contest.text(contest.body.querySelector('nav[aria-label="Matter sections"]'))).toContain('Litigation');
    expect(contest.text()).toContain('Coming in LIT-03');
  });

  it('edits the title inline: Enter saves only the title, Escape cancels', async () => {
    const page = await openMatter();
    await page.click('Edit title');
    await page.fill('Matter title', 'Estate of the late Margaret Whitfield');
    await page.submit(page.header());
    const update = page.firestore.writes.at(-1);
    expect(update).toMatchObject({ op: 'update', path: MATTER });
    expect(Object.keys(update?.data ?? {}).sort()).toEqual(['title', 'updatedAt', 'updatedBy']);
    expect(page.header()?.querySelector('h1')?.textContent?.trim()).toBe('Estate of the late Margaret Whitfield');

    await page.press('e');
    expect(page.header()?.querySelector('form')).not.toBeNull();
    await page.press('Escape', {}, page.header()?.querySelector('form') ?? page.body);
    expect(page.header()?.querySelector('form')).toBeNull();
  });

  it('keeps very long titles to two lines with the full title in a tooltip', async () => {
    const title = `Estate of ${'Fictional '.repeat(20)}Whitfield`;
    const page = await openMatter(undefined, { matter: { title } });
    const h1 = page.header()?.querySelector<HTMLElement>('h1.title');
    expect(h1?.textContent?.trim()).toBe(title);
    h1?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    h1?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await page.stable(500);
    expect(page.body.querySelector('.mt-tooltip')?.textContent?.trim()).toBe(title);
  });
});

describe('status', () => {
  it('moves the matter through matters-changeStatus and toasts the result', async () => {
    const page = await openMatter();
    await page.click('Status: Open. Change status');
    await page.click('Put on hold', page.body.querySelector('[role="menu"]') ?? page.body);
    expect(page.calls('matters-changeStatus')).toEqual([
      { matterId: 'm-whitfield', to: 'on_hold', requestId: expect.any(String) },
    ]);
    expect(page.text()).toContain('M-2026-0142 is on hold');
  });

  it('closes the matter from the "…" menu with a reason', async () => {
    const page = await openMatter();
    await page.click('More matter actions');
    await page.click('Close matter…', page.body.querySelector('[role="menu"]') ?? page.body);
    await page.fill('Reason', 'Estate fully administered', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    expect(page.calls('matters-changeStatus')[0]).toMatchObject({ to: 'closed', reason: 'Estate fully administered' });
  });

  it('shows a refused change with its reason', async () => {
    const page = await openMatter(undefined, {
      callables: {
        'matters-changeStatus': () => {
          throw { code: 'functions/failed-precondition', details: { code: 'MATTER_INVALID_TRANSITION' } };
        },
      },
    });
    await page.click('Status: Open. Change status');
    await page.click('Put on hold', page.body.querySelector('[role="menu"]') ?? page.body);
    expect(page.text()).toContain('The matter can’t move to that status from where it is now.');
  });
});

describe('people, labels and privileged', () => {
  it('changes the responsible lawyer and the team', async () => {
    const page = await openMatter();
    await page.click('Change responsible lawyer');
    await page.click('Priya Shah', page.body.querySelector('[role="menu"]') ?? page.body);
    expect(page.firestore.get(MATTER)).toMatchObject({ responsibleUid: PRIYA, teamUids: [PRIYA], labels: ['grant'] });
    await page.click('Change team');
    await page.click('Daniel Kim', page.body.querySelector('[role="menu"]') ?? page.body);
    expect(page.firestore.get(MATTER)?.['teamUids']).toEqual([PRIYA, 'user-daniel']);
  });

  it('adds and removes labels', async () => {
    const page = await openMatter();
    await page.click('Label', page.header() ?? page.body);
    await page.fill('Label', 'urgent', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    expect(page.firestore.get(MATTER)?.['labels']).toEqual(['grant', 'urgent']);
    await page.click('Remove label grant');
    expect(page.firestore.get(MATTER)?.['labels']).toEqual(['urgent']);
  });

  it('lets a lawyer mark the matter privileged; a paralegal doesn’t see the switch', async () => {
    const page = await openMatter();
    page.header()?.querySelector<HTMLElement>('mt-switch button, mt-switch [role="switch"]')?.click();
    await page.stable();
    expect(page.firestore.get(MATTER)?.['privileged']).toBe(true);
    expect(page.text(page.header())).toContain('Privileged');
    TestBed.resetTestingModule();

    const paralegal = await openMatter(undefined, { session: PARALEGAL });
    expect(paralegal.header()?.querySelector('mt-switch')).toBeNull();
    expect(paralegal.buttons('Edit title')).toHaveLength(1);
    expect(paralegal.header()?.querySelector('mt-badge.status')).not.toBeNull();
  });
});

describe('access and lifecycle', () => {
  it('hides every edit control from read-only members', async () => {
    const page = await openMatter(undefined, { session: READONLY });
    expect(page.text(page.header())).toContain('Estate of Margaret Whitfield');
    for (const label of ['Edit title', 'Change responsible lawyer', 'Change team', 'Edit Grant date']) {
      expect(page.buttons(label)).toHaveLength(0);
    }
    expect(page.header()?.querySelector('mt-switch')).toBeNull();
    expect(page.body.querySelector('mt-estate-stepper button')).toBeNull();
  });

  it('shows "Restricted" for a privileged matter a read-only member can’t read, and stays put', async () => {
    const page = await openMatter(undefined, {
      session: READONLY,
      configure: (fs) => {
        const real = fs.driver;
        (fs as unknown as { driver: typeof real }).driver = (path, opts) => {
          const driver = real(path, opts);
          return path.endsWith('/matters')
            ? {
                ...driver,
                watchDoc: (_id, _next, error) => (
                  queueMicrotask(() => error({ code: 'permission-denied' })),
                  () => undefined
                ),
              }
            : driver;
        };
      },
    });
    await page.stable(50);
    expect(page.text(page.layout())).toContain('Restricted');
    expect(page.layout()?.querySelector('[role="status"]')).toBeNull();
    expect(page.router.url).toBe('/matters/m-whitfield/overview');
  });

  it('shows "not found" for a matter that isn’t in this practice', async () => {
    const page = await openMatter('/matters/m-elsewhere/overview');
    expect(page.text(page.layout())).toContain("We couldn't find that page");
  });

  it('shows a banner and goes read-only when the matter is deleted while open', async () => {
    const page = await openMatter();
    expect(page.buttons('Edit title')).toHaveLength(1);
    page.firestore.set(MATTER, {
      ...page.firestore.get(MATTER),
      deletedAt: new Date('2026-10-04T02:00:00Z'),
      deletedBy: PRIYA,
    });
    await page.stable();
    expect(page.text(page.layout())).toContain('This matter was deleted on 4 Oct 2026 by Priya Shah');
    expect(page.buttons('Edit title')).toHaveLength(0);
    expect(page.buttons('Status: Open. Change status')).toHaveLength(0);
  });

  it('deletes the matter (soft) from the "…" menu and returns to the list', async () => {
    const page = await openMatter();
    await page.click('More matter actions');
    await page.click('Delete matter…', page.body.querySelector('[role="menu"]') ?? page.body);
    await page.click('Delete matter', page.dialog() ?? page.body);
    expect(page.firestore.writes.at(-1)).toMatchObject({ op: 'softDelete', path: MATTER });
    expect(page.router.url).toBe('/matters');
  });

  it('says who changed the matter just now when it was someone else', async () => {
    const page = await openMatter();
    expect(page.text(page.header())).not.toContain('Updated by');
    page.firestore.set(MATTER, { ...page.firestore.get(MATTER), updatedBy: PRIYA, updatedAt: new Date() });
    await page.stable();
    expect(page.text(page.header())).toContain('Updated by Priya Shah just now');
    page.firestore.set(MATTER, { ...page.firestore.get(MATTER), updatedBy: ME, updatedAt: new Date() });
    await page.stable();
    expect(page.text(page.header())).not.toContain('Updated by');
  });
});

describe('Clerk and shortcuts', () => {
  it('⌘J opens Clerk scoped to this matter', async () => {
    const page = await openMatter(undefined, { session: LAWYER });
    await page.press('j', { ctrlKey: true });
    const panel = page.body.querySelector('#clerk-panel');
    expect(panel?.getAttribute('data-scope')).toBe('matter:m-whitfield');
    expect(page.text(panel)).toContain('M-2026-0142');
  });

  it('documents the matter shortcuts in the ? sheet and moves between tabs with numbers', async () => {
    const page = await openMatter();
    const matter = TestBed.inject(ShortcutService)
      .list()
      .filter((s) => s.group === 'Matter')
      .map((s) => `${s.combo} ${s.description}`);
    expect(matter).toEqual(
      expect.arrayContaining([
        'mod+j Ask Clerk about this matter',
        'e Edit the matter title',
        'y Copy the matter number',
        'p Add a party',
        '1 Go to the overview (tab 1)',
        '6 Go to tab 6',
      ]),
    );
    await page.press('6');
    expect(page.router.url).toBe('/matters/m-whitfield/parties');
    await page.press('?');
    expect(page.text(page.dialog())).toContain('Add a party');
  });
});
