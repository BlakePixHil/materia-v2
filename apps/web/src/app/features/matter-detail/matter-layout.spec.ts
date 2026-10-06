import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';

import { ADMIN, cleanUpOverlays, LAWYER, MATTER, ME, openMatter, PARALEGAL, PRIYA, READONLY } from './testing';
import { ShortcutService } from '../../core/shortcuts/shortcut.service';

/** The matter screen's frame and header (CORE-06). Fictional data only. */

afterEach(cleanUpOverlays);

type Page = Awaited<ReturnType<typeof openMatter>>;

/** Ticks the checkbox labelled `label` in the open dialog. */
async function check(page: Page, label: string): Promise<void> {
  const box = [...page.body.querySelectorAll('mt-checkbox')].find((node) => page.text(node).startsWith(label));
  const button = box?.querySelector<HTMLElement>('button');
  if (!button) throw new Error(`No checkbox "${label}"`);
  button.click();
  await page.stable();
}

/** Picks the radio option labelled `label`. */
async function choose(page: Page, label: string): Promise<void> {
  const option = [...page.body.querySelectorAll('mt-radio-group label')].find((node) => page.text(node) === label);
  const button = option?.querySelector<HTMLElement>('button');
  if (!button) throw new Error(`No option "${label}"`);
  button.click();
  await page.stable();
}

describe('matter header', () => {
  it('shows the number, type, conflict status, title, status, people, labels, stages and tabs', async () => {
    const page = await openMatter(undefined, { flags: { 'estate.register': true } });
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

  it('titles the page and breadcrumbs with the matter’s number, not its id', async () => {
    const page = await openMatter('/matters/m-whitfield/parties');
    expect(TestBed.inject(Title).getTitle()).toBe('Matter · M-2026-0142 · Parties · Materia');
    const crumbs = [...page.body.querySelectorAll('.mt-crumbs li')].map((li) => page.text(li));
    expect(crumbs).toEqual(['Matters', 'M-2026-0142', 'Parties']);
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

  it('closes the matter through its closing checklist (CORE-19)', async () => {
    const page = await openMatter();
    await page.click('More matter actions');
    await page.click('Close matter…', page.body.querySelector('[role="menu"]') ?? page.body);
    const dialog = page.dialog();
    expect(page.text(dialog)).toContain('No upcoming deadlines');
    expect(page.text(dialog)).toContain('1 task still open.');
    expect(page.text(dialog)).toContain('Kept until at least 4 Oct 2033 (7 years)');
    const close = () => page.buttons('Close matter', dialog ?? page.body).at(-1);
    expect(close()?.hasAttribute('disabled') || close()?.getAttribute('aria-disabled') === 'true').toBe(true);

    await check(page, 'Cancel the 1 open task when closing');
    await page.fill('Why cancel them', 'Superseded', dialog ?? page.body);
    await choose(page, 'We hold no originals');
    await check(page, 'Closing letter sent');
    expect(page.text(dialog)).toContain('Final distribution recorded. Still to do');
    await page.fill('Or say why there’s no final distribution', 'No residue to distribute', dialog ?? page.body);
    await page.fill('Reason for closing', 'Estate fully administered', dialog ?? page.body);
    await page.submit(page.dialog());
    expect(page.calls('matters-close')[0]).toMatchObject({
      matterId: 'm-whitfield',
      reason: 'Estate fully administered',
      checklist: { originals: 'none_held', closingLetterSent: true, finalDistributionRecorded: false },
      cancelOpenTasks: { reason: 'Superseded' },
      checklistOverrides: { final_distribution: 'No residue to distribute' },
    });
    expect(page.calls('matters-changeStatus')).toEqual([]);
    expect(page.text(page.layout())).toContain('Closed on');
    expect(page.text(page.layout())).toContain('Kept until at least 4 Oct 2033');
  });

  it('blocks closing on unbilled WIP unless a reason is given, linking to the time tab (CORE-19b)', async () => {
    const page = await openMatter(undefined, { matter: { wipCents: 1_200_00, disbursementWipCents: 55_00 } });
    await page.click('More matter actions');
    await page.click('Close matter…', page.body.querySelector('[role="menu"]') ?? page.body);
    const dialog = page.dialog() ?? page.body;
    expect(page.text(dialog)).toContain('No unbilled WIP. Still to do');
    expect(page.text(dialog)).toContain('$1,255.00 of time and disbursements not yet billed');
    const link = [...dialog.querySelectorAll('a')].find((a) => page.text(a) === 'Review time and disbursements');
    expect(link?.getAttribute('href')).toBe('/matters/m-whitfield/time');

    await check(page, 'Cancel the 1 open task when closing');
    await page.fill('Why cancel them', 'Superseded', dialog);
    await choose(page, 'We hold no originals');
    await check(page, 'Closing letter sent');
    await check(page, 'Final distribution recorded');
    await page.fill('Reason for closing', 'Estate fully administered', dialog);
    const close = () => page.buttons('Close matter', dialog).at(-1);
    expect(close()?.hasAttribute('disabled') || close()?.getAttribute('aria-disabled') === 'true').toBe(true);

    await page.fill('Or say why it won’t be billed', 'Written off by agreement with the executor', dialog);
    await page.submit(page.dialog());
    expect(page.calls('matters-close')[0]).toMatchObject({
      checklistOverrides: { wip: 'Written off by agreement with the executor' },
    });
  });

  it('shows a closed matter read-only with a banner, and reopens it with a reason', async () => {
    const page = await openMatter(undefined, {
      matter: { status: 'closed', closedAt: new Date('2026-09-01T00:00:00Z'), destroyAfter: '2033-09-01' },
    });
    expect(page.text(page.layout())).toContain('It’s read-only apart from notes');
    expect(page.text(page.layout())).toContain('Kept until at least 1 Sept 2033');
    expect(page.buttons('Edit title')).toHaveLength(0);
    await page.click('Status: Closed. Change status');
    await page.click('Reopen…', page.body.querySelector('[role="menu"]') ?? page.body);
    await page.fill('Reason', 'Further assets found', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    expect(page.calls('matters-reopen')[0]).toMatchObject({ matterId: 'm-whitfield', reason: 'Further assets found' });
    expect(page.text(page.layout())).not.toContain('read-only apart from notes');
    expect(page.buttons('Edit title')).toHaveLength(1);
  });

  it('on an archived matter only lawyers and above add notes (CORE-19)', async () => {
    const archived = { status: 'archived', closedAt: new Date('2026-06-01T00:00:00Z'), archivedAt: new Date() };
    const lawyer = await openMatter('/matters/m-whitfield/notes', { matter: archived });
    expect(lawyer.text(lawyer.layout())).toContain('It’s read-only; lawyers can still add notes.');
    expect(lawyer.body.querySelector('[aria-label="New note"]')).not.toBeNull();
    cleanUpOverlays();
    TestBed.resetTestingModule();
    const paralegal = await openMatter('/matters/m-whitfield/notes', { session: PARALEGAL, matter: archived });
    expect(paralegal.body.querySelector('[aria-label="New note"]')).toBeNull();
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

  it('lets an owner or admin restore a deleted matter from its banner; others are told who can (CORE-03)', async () => {
    const deleted = { deletedAt: new Date(), deletedBy: PRIYA };
    const restore = {
      'matters-restore': (data: Record<string, unknown>, fs: Page['firestore']) => {
        fs.set(MATTER, { ...fs.get(MATTER), deletedAt: null, deletedBy: null });
        return { matterId: data['matterId'], restored: true };
      },
    };
    const lawyer = await openMatter(undefined, { matter: deleted, callables: restore });
    expect(lawyer.text(lawyer.layout())).toContain('an owner or admin can restore it within 30 days');
    expect(lawyer.buttons('Restore matter')).toHaveLength(0);
    cleanUpOverlays();
    TestBed.resetTestingModule();

    const page = await openMatter(undefined, { session: ADMIN, matter: deleted, callables: restore });
    expect(page.buttons('Edit title')).toHaveLength(0);
    await page.click('Restore matter');
    expect(page.calls('matters-restore')).toEqual([{ matterId: 'm-whitfield', requestId: expect.any(String) }]);
    expect(page.text()).toContain('Restored M-2026-0142');
    expect(page.text(page.layout())).not.toContain('This matter was deleted');
    expect(page.buttons('Edit title')).toHaveLength(1);
  });

  it('says a deleted matter past the 30-day window can no longer be restored', async () => {
    const page = await openMatter(undefined, {
      session: ADMIN,
      matter: { deletedAt: new Date(Date.now() - 31 * 86_400_000), deletedBy: PRIYA },
    });
    expect(page.text(page.layout())).toContain('it can no longer be restored');
    expect(page.buttons('Restore matter')).toHaveLength(0);
  });

  it('offers Undo on the delete toast to owners and admins, which restores the matter', async () => {
    const page = await openMatter(undefined, {
      session: ADMIN,
      callables: {
        'matters-restore': (data, fs) => {
          fs.set(MATTER, { ...fs.get(MATTER), deletedAt: null, deletedBy: null });
          return { matterId: data['matterId'], restored: true };
        },
      },
    });
    await page.click('More matter actions');
    await page.click('Delete matter…', page.body.querySelector('[role="menu"]') ?? page.body);
    await page.click('Delete matter', page.dialog() ?? page.body);
    expect(page.router.url).toBe('/matters');
    await page.click('Undo');
    expect(page.calls('matters-restore')).toEqual([{ matterId: 'm-whitfield', requestId: expect.any(String) }]);
    await page.stable();
    expect(page.router.url).toBe('/matters/m-whitfield/overview');
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
        'c New matter',
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
