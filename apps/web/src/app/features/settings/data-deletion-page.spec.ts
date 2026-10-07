import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { TENANCY_PORT, type JobSource } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { resolveSecurity, type Role } from '@materia/domain';
import { MT_KEYBOARD_PLATFORM } from '@materia/ui';

import { deletionDay } from './data-deletion-page';
import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { provideTestFlags } from '../../core/flags/testing';
import { JOB_SOURCE } from '../../core/jobs/job-progress';
import { FakeTenancyPort } from '../../core/orgs/testing';

/**
 * Settings → Data and deletion and the read-only banner (SEC-05), against the in-memory Firestore
 * and fake callables. A fictional practice only.
 */

const ORG = 'org-harbour-vine';
const NAME = 'Harbour & Vine Legal';
const DELETION = new Date('2026-11-06T02:00:00Z');
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** The export job finishes as soon as it is watched. */
const finishedJobs: JobSource = {
  watch: (_orgId, _jobId, next) => {
    next({ status: 'succeeded', progress: { done: 12, total: 12, stage: 'done' }, warnings: [] });
    return () => undefined;
  },
};

async function open(role: Role, deletionScheduledAt: Date | null = null) {
  const port = new FakeAuthPort(testSession({ claims: { orgId: ORG, role, orgName: NAME } }));
  port.callResults['exports-orgFull'] = { jobId: 'job-full-1', status: 'queued' };
  port.callResults['orgs-requestDeletion'] = { deletionScheduledAt: DELETION.toISOString() };
  port.callResults['orgs-cancelDeletion'] = { cancelled: true };
  const tenancy = new FakeTenancyPort();
  tenancy.security_ = { policy: resolveSecurity(undefined), validAfter: null, deletionScheduledAt };
  const firestore = new InMemoryFirestore();
  firestore.set(`orgs/${ORG}`, { name: NAME, timezone: 'Australia/Melbourne' });
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      { provide: AUTH_PORT, useValue: port },
      { provide: TENANCY_PORT, useValue: tenancy },
      { provide: JOB_SOURCE, useValue: finishedJobs },
      provideInMemoryFirestore(firestore),
      ...provideTestFlags(),
    ],
  });
  const fixture = TestBed.createComponent(App);
  const el = fixture.nativeElement as HTMLElement;
  const stable = async () => {
    await settle();
    await fixture.whenStable();
    await settle();
  };
  await TestBed.inject(Router).navigateByUrl('/settings/data');
  await stable();
  const buttonIn = (root: ParentNode, text: string) => {
    const found = [...root.querySelectorAll<HTMLElement>('button, a')].find((b) =>
      b.textContent?.trim().startsWith(text),
    );
    if (!found) throw new Error(`No button "${text}"`);
    return found;
  };
  return {
    port,
    tenancy,
    el,
    stable,
    text: () => el.textContent?.replace(/\s+/g, ' ') ?? '',
    dialog: () => document.body.querySelector<HTMLElement>('.mt-dialog'),
    button: (text: string) => buttonIn(el, text),
    async click(text: string) {
      buttonIn(el, text).click();
      await stable();
    },
    async confirm(text: string, typed?: string) {
      const dialog = document.body.querySelector<HTMLElement>('.mt-dialog');
      if (!dialog) throw new Error('No dialog');
      if (typed !== undefined) {
        const input = dialog.querySelector<HTMLInputElement>('input');
        if (!input) throw new Error('No confirmation field');
        input.value = typed;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await stable();
      }
      buttonIn(dialog, text).click();
      await stable();
    },
    async check(label: string) {
      const box = [...el.querySelectorAll('mt-checkbox')].find((c) => c.textContent?.includes(label));
      const input = box?.querySelector<HTMLElement>('input, button, [role="checkbox"]');
      if (!input) throw new Error(`No checkbox "${label}"`);
      input.click();
      await stable();
    },
    callsTo: (name: string) => port.calls.filter((c) => c.name === name).map((c) => c.data),
  };
}

afterEach(() => {
  for (const node of document.body.querySelectorAll('.mt-modal-root')) node.remove();
});

describe('Settings → Data and deletion', () => {
  it('exports everything once the owner acknowledges the privileged material, and links the download', async () => {
    const page = await open('owner');
    expect(page.text()).toContain('Export everything');
    expect(page.text()).toContain('The export includes privileged and confidential material');
    expect((page.button('Export everything') as HTMLButtonElement).disabled).toBe(true);

    await page.check('Include every version of each document');
    await page.check('I understand the export includes privileged material');
    await page.click('Export everything');
    expect(page.callsTo('exports-orgFull')).toEqual([
      expect.objectContaining({ allVersions: true, acknowledgePrivileged: true }),
    ]);
    expect(page.button('Download the export').getAttribute('href')).toBe('/exports/job-full-1');
  });

  it('schedules the deletion after the owner types the practice’s name', async () => {
    const page = await open('owner');
    expect(page.text()).toContain('A legal hold, or an export still being made, stops the deletion.');
    await page.click('Delete this practice');
    expect(page.dialog()?.textContent).toContain(`Delete ${NAME}?`);
    await page.confirm('Delete practice', 'Harbour and Vine');
    expect(page.callsTo('orgs-requestDeletion')).toEqual([]);
    await page.confirm('Delete practice', NAME);
    expect(page.callsTo('orgs-requestDeletion')).toEqual([expect.objectContaining({ confirmation: NAME })]);
    expect(page.text()).toContain(`${NAME} will be deleted on 6 November 2026`);
    expect(page.button('Cancel deletion')).toBeTruthy();
  });

  it('shows a scheduled deletion on every page, and lets an owner cancel it', async () => {
    const page = await open('owner', DELETION);
    const banner = page.el.querySelector('[data-deletion-banner]');
    expect(banner?.textContent).toContain(`${NAME} will be deleted on 6 November 2026. Until then it’s read-only.`);
    expect(banner?.querySelector('a')?.getAttribute('href')).toBe('/settings/data');
    expect(page.el.querySelector('[data-deletion-row]')?.textContent).toContain('On 6 November 2026');

    await page.click('Cancel deletion');
    await page.confirm('Cancel deletion');
    expect(page.callsTo('orgs-cancelDeletion')).toHaveLength(1);
    expect(page.el.querySelector('[data-deletion-row]')).toBeNull();
    expect(page.text()).toContain('Delete this practice…');
  });

  it('is for owners: everyone else sees the banner and no page (SEC-05)', async () => {
    const page = await open('lawyer', DELETION);
    expect(TestBed.inject(Router).url).toBe('/no-access');
    await TestBed.inject(Router).navigateByUrl('/settings/team');
    await page.stable();
    const banner = page.el.querySelector('[data-deletion-banner]');
    expect(banner?.textContent).toContain(`${NAME} will be deleted on 6 November 2026.`);
    expect(banner?.textContent).toContain('An owner can cancel the deletion.');
    expect(banner?.querySelector('a')).toBeNull();
    expect(page.text()).not.toContain('Data and deletion');
  });
});

describe('deletionDay', () => {
  it('reads the date in the practice’s time zone', () => {
    expect(deletionDay(new Date('2026-11-05T14:00:00Z'), 'Australia/Melbourne')).toBe('6 November 2026');
    expect(deletionDay(new Date('2026-11-05T14:00:00Z'), 'Australia/Perth')).toBe('5 November 2026');
  });
});
