import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';

import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { makeNotification } from '@materia/test-utils';
import { MT_KEYBOARD_PLATFORM, ThemeService } from '@materia/ui';

import { App } from '../app';
import { appRoutes } from '../app.routes';
import { AppShellComponent, SIDEBAR_STORAGE_PREFIX } from './app-shell';
import { MtPageActions } from './page-header';
import type { AuthSession } from '../core/auth/auth-port';
import { provideFakeAuth, testSession, type FakeAuthPort } from '../core/auth/testing';
import { CommandRegistry } from '../core/commands/command-registry';
import { provideTestFlags } from '../core/flags/testing';
import { NOTIFICATIONS_START_DELAY_MS } from '../core/notifications/notifications-store';

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(
  url = '/today',
  options: { mobile?: boolean; session?: AuthSession; firestore?: InMemoryFirestore } = {},
) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? !!options.mobile : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  const fake = provideFakeAuth(options.session ?? testSession());
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      ...fake.providers,
      ...provideTestFlags(),
      // Today lists my tasks (CORE-08).
      provideInMemoryFirestore(options.firestore ?? new InMemoryFirestore()),
      // The unread badge (FND-20) waits for the page's reads; with seeded notifications, start at once.
      ...(options.firestore ? [{ provide: NOTIFICATIONS_START_DELAY_MS, useValue: 0 }] : []),
    ],
  });
  const fixture = TestBed.createComponent(App);
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  await fixture.whenStable();
  window.matchMedia = original;
  const el = fixture.nativeElement as HTMLElement;
  const app = () => el.querySelector('.mt-app') as HTMLElement;
  const press = async (key: string, init: KeyboardEventInit = {}) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    await fixture.whenStable();
    await settle();
  };
  return { fixture, router, el, app, press, port: fake.port as FakeAuthPort };
}

describe('AppShellComponent', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => document.querySelectorAll('[ngpdialogoverlay], .mt-overlay').forEach((node) => node.remove()));

  it('has a skip link to the main panel', async () => {
    const { el } = await setup();
    const skip = el.querySelector<HTMLAnchorElement>('a.mt-skip');
    expect(skip?.getAttribute('href')).toBe('#main');
    skip?.click();
    expect(document.activeElement?.id).toBe('main');
  });

  it('collapses the sidebar with [ and remembers it per user', async () => {
    const first = await setup();
    expect(first.app().hasAttribute('data-collapsed')).toBe(false);
    await first.press('[');
    expect(first.app().hasAttribute('data-collapsed')).toBe(true);
    expect(first.el.querySelector('aside nav a')?.getAttribute('aria-label')).toBe('Today');
    expect(localStorage.getItem(`${SIDEBAR_STORAGE_PREFIX}user-jordan`)).toBe('1');
    TestBed.resetTestingModule();

    const second = await setup();
    expect(second.app().hasAttribute('data-collapsed')).toBe(true);
    (second.el.querySelector('button[aria-label="Expand sidebar"]') as HTMLButtonElement).click();
    await second.fixture.whenStable();
    expect(second.app().hasAttribute('data-collapsed')).toBe(false);
    expect(localStorage.getItem(`${SIDEBAR_STORAGE_PREFIX}user-jordan`)).toBe('0');
  });

  it('keeps the collapsed choice separate for each user', async () => {
    localStorage.setItem(`${SIDEBAR_STORAGE_PREFIX}user-jordan`, '1');
    const { app } = await setup('/today', { session: testSession({ uid: 'user-other' }) });
    expect(app().hasAttribute('data-collapsed')).toBe(false);
  });

  it('shows my unread in-app notifications on Inbox (FND-20)', async () => {
    const firestore = new InMemoryFirestore();
    const session = testSession();
    const orgId = session.claims.orgId as string;
    for (const id of ['n1', 'n2', 'n3']) {
      firestore.set(`orgs/${orgId}/notifications/${id}`, {
        ...makeNotification({ recipientUid: session.uid }),
        createdAt: new Date('2026-10-05T00:00:00.000Z'),
        ...(id === 'n3' ? { readAt: new Date('2026-10-05T01:00:00.000Z') } : {}),
      });
    }
    const { el, fixture } = await setup('/today', { session, firestore });
    await settle();
    await fixture.whenStable();
    const inbox = [...el.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Main"] a')].find(
      (a) => a.getAttribute('href') === '/inbox',
    );
    expect(inbox?.querySelector('.mt-nav-count')?.textContent?.trim()).toBe('2');
    // Other items carry no count.
    expect(el.querySelectorAll('nav[aria-label="Main"] .mt-nav-count')).toHaveLength(1);
  });

  it('shows the unread count on the Inbox tab on a phone (FND-20)', async () => {
    const firestore = new InMemoryFirestore();
    const session = testSession();
    const orgId = session.claims.orgId as string;
    firestore.set(`orgs/${orgId}/notifications/n1`, {
      ...makeNotification({ recipientUid: session.uid }),
      createdAt: new Date('2026-10-05T00:00:00.000Z'),
    });
    const { el, fixture } = await setup('/today', { mobile: true, session, firestore });
    await settle();
    await fixture.whenStable();
    const counts = [...el.querySelectorAll('.mt-tabbar a')].map((a) => a.querySelector('.mt-nav-count')?.textContent);
    expect(counts).toEqual([undefined, undefined, undefined, undefined, '1']);
  });

  it('ignores [ while typing in a field', async () => {
    const { app, fixture, el } = await setup();
    const input = document.createElement('input');
    el.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(app().hasAttribute('data-collapsed')).toBe(false);
  });

  it('toggles the Clerk panel with mod+j', async () => {
    const { el, press, fixture } = await setup();
    expect(el.querySelector('#clerk-panel')).toBeNull();
    await press('j', { ctrlKey: true });
    expect(el.querySelector('#clerk-panel')?.textContent).toContain('Clerk');
    expect(el.querySelector('.mt-app')?.hasAttribute('data-clerk')).toBe(true);
    (el.querySelector('button[aria-label="Close Clerk"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(el.querySelector('#clerk-panel')).toBeNull();
  });

  it('navigates with g then a key', async () => {
    const { router, press } = await setup();
    await press('g');
    await press('m');
    expect(router.url).toBe('/matters');
    await press('g');
    await press('s');
    expect(router.url).toBe('/settings');
  });

  it('opens the palette with mod+k and runs a navigation command', async () => {
    const { router, press, fixture } = await setup();
    await press('k', { ctrlKey: true });
    const input = document.querySelector<HTMLInputElement>('input[role="combobox"]');
    expect(input).not.toBeNull();
    const labels = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim());
    expect(labels.some((label) => label?.startsWith('Go to Deadlines'))).toBe(true);
    if (!input) return;
    input.value = 'deadl';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    const first = document.querySelector('[role="option"]');
    expect(first?.textContent).toContain('Go to Deadlines');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await fixture.whenStable();
    await settle(50);
    expect(router.url).toBe('/deadlines');
    expect(TestBed.inject(CommandRegistry).recent()[0]?.id).toBe('go.deadlines');
  });

  it('opens the shortcut cheat sheet with ? listing every shortcut', async () => {
    const { press } = await setup();
    await press('?', { shiftKey: true });
    const sheet = document.querySelector('.mt-dialog');
    expect(sheet?.textContent).toContain('Keyboard shortcuts');
    for (const text of [
      'Open the command palette',
      'Collapse or expand the sidebar',
      'Ask Clerk',
      'Go to Matters',
      'Go to Settings',
    ]) {
      expect(sheet?.textContent).toContain(text);
    }
  });

  it('registers the built-in commands', async () => {
    await setup();
    const registry = TestBed.inject(CommandRegistry);
    const ids = registry.available().map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'go.today',
        'go.matters',
        'go.settings',
        'theme.toggle',
        'sidebar.toggle',
        'shortcuts.open',
        'clerk.toggle',
        'matters.new',
      ]),
    );
    const theme = TestBed.inject(ThemeService);
    const before = theme.resolved();
    registry.get('theme.toggle')?.run();
    expect(theme.resolved()).not.toBe(before);
  });

  it('signs out from the user menu, clearing cached data, and returns to sign-in', async () => {
    localStorage.setItem('materia.commands.recent', '["go.matters"]');
    const { router, port, fixture } = await setup();
    const shell = fixture.debugElement.query(By.directive(AppShellComponent)).componentInstance as AppShellComponent;
    await shell.signOut();
    await fixture.whenStable();
    expect(port.session).toBeNull();
    expect(router.url).toBe('/auth/sign-in');
    expect(localStorage.getItem('materia.commands.recent')).toBeNull();
  });

  it('shows the TabBar instead of the sidebar on phones', async () => {
    const { el } = await setup('/today', { mobile: true });
    expect(el.querySelector('.mt-sidebar')).toBeNull();
    const tabs = [...el.querySelectorAll('.mt-tabbar a')].map(
      (a) => a.textContent?.trim() || a.getAttribute('aria-label'),
    );
    expect(tabs).toEqual(['Today', 'Matters', 'Record', 'Deadlines', 'Inbox']);
    expect(TestBed.inject(CommandRegistry).get('sidebar.toggle')?.when?.()).toBe(false);
  });
});

@Component({
  selector: 'mt-test-page',
  imports: [MtPageActions],
  template: `<ng-template mtPageActions><button type="button">New matter</button></ng-template>`,
})
class PageWithActions {}

describe('MtPageActions', () => {
  it('puts page actions in the shell header and clears them when the page goes', async () => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([
          {
            path: '',
            component: AppShellComponent,
            children: [
              { path: 'a', component: PageWithActions },
              { path: 'b', children: [] },
            ],
          },
        ]),
        ...provideFakeAuth().providers,
        ...provideTestFlags(),
      ],
    });
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/a');
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.mt-topbar')?.textContent).toContain('New matter');
    await router.navigateByUrl('/b');
    await fixture.whenStable();
    expect(el.querySelector('.mt-topbar')?.textContent).not.toContain('New matter');
  });
});
