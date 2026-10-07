import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { DEFAULT_NOTIFICATION_PREFS, TOUR_ID_PATTERN } from '@materia/domain';
import { MT_KEYBOARD_PLATFORM } from '@materia/ui';

import { dockFor, elementBox, placeCard, spotFor } from './tour-geometry';
import { AUTO_START_DELAY_MS, TOUR_SHORTCUT, TourService } from './tour-service';
import { PAGE_TOURS, TOURS, tourForPath, WELCOME_TOUR } from './tours';
import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { provideFakeAuth, testSession } from '../auth/testing';
import { CommandRegistry } from '../commands/command-registry';
import { provideTestFlags } from '../flags/testing';

/**
 * Guided tours (CORE-24): where the card goes, which page has which tour, and the whole app with
 * the in-memory Firestore: the welcome tour on first sign-in, page tours on first visits, the
 * command, the hotkey and Settings. A fictional practice and person only.
 */
const ORG = 'org-harbour-vine';
const UID = 'user-jordan';
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const meta = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: 'seed',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  updatedBy: 'seed',
  schemaVersion: 1,
};
const userDoc = (tours?: { auto: boolean; seen: string[] }) => ({
  email: 'lawyer@harbourvine.example',
  displayName: 'Jordan Price',
  firstName: 'Jordan',
  lastName: 'Price',
  orgIds: [ORG],
  activeOrgId: ORG,
  prefs: {
    theme: 'system',
    density: 'comfortable',
    shortcuts: true,
    notifications: DEFAULT_NOTIFICATION_PREFS,
    ...(tours ? { tours } : {}),
  },
  ...meta,
});

describe('tour placement', () => {
  const viewport = { width: 1280, height: 800 };

  it('pads the spotlight and keeps it on screen', () => {
    expect(spotFor({ top: 100, left: 200, width: 300, height: 40 }, viewport)).toEqual({
      top: 94,
      left: 194,
      width: 312,
      height: 52,
    });
    const huge = spotFor({ top: -200, left: 0, width: 1280, height: 2000 }, viewport);
    expect(huge.top).toBe(6);
    expect(huge.top + huge.height).toBe(794);
  });

  it('puts the card below the feature, else above, beside, or over a feature that fills the screen', () => {
    const card = { width: 340, height: 180 };
    expect(placeCard({ top: 100, left: 200, width: 300, height: 52 }, card, viewport)).toEqual({
      top: 164,
      left: 180,
      placement: 'below',
    });
    expect(placeCard({ top: 600, left: 200, width: 300, height: 52 }, card, viewport).placement).toBe('above');
    // A tall sidebar: no room above or below, so beside it.
    expect(placeCard({ top: 60, left: 6, width: 240, height: 700 }, card, viewport)).toMatchObject({
      left: 258,
      placement: 'right',
    });
    expect(placeCard({ top: 6, left: 6, width: 1268, height: 788 }, card, viewport)).toEqual({
      top: 608,
      left: 470,
      placement: 'over',
    });
    // Never off the edge.
    expect(placeCard({ top: 100, left: 1200, width: 60, height: 30 }, card, viewport).left).toBe(928);
  });

  it('docks the phone card away from the feature', () => {
    const phone = { width: 390, height: 844 };
    expect(dockFor(null, phone)).toBe('bottom');
    expect(dockFor({ top: 100, left: 0, width: 390, height: 60 }, phone)).toBe('bottom');
    expect(dockFor({ top: 760, left: 0, width: 390, height: 84 }, phone)).toBe('top');
  });

  it('measures a display: contents host by its children', () => {
    const host = document.createElement('div');
    const a = document.createElement('div');
    const b = document.createElement('div');
    host.append(a, b);
    document.body.append(host);
    const rect = (top: number, left: number, width: number, height: number) =>
      ({ top, left, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
    host.getBoundingClientRect = () => rect(0, 0, 0, 0);
    a.getBoundingClientRect = () => rect(10, 20, 100, 30);
    b.getBoundingClientRect = () => rect(50, 10, 50, 40);
    expect(elementBox(host)).toEqual({ top: 10, left: 10, width: 110, height: 80 });
    a.getBoundingClientRect = b.getBoundingClientRect = () => rect(0, 0, 0, 0);
    expect(elementBox(host)).toBeNull();
    host.remove();
  });
});

describe('the tours', () => {
  it('finds the most specific tour for a page', () => {
    expect(tourForPath('/today')?.id).toBe('today');
    expect(tourForPath('/matters?view=mine')?.id).toBe('matters');
    expect(tourForPath('/matters/m-doyle')?.id).toBe('matter');
    expect(tourForPath('/matters/m-doyle/overview')?.id).toBe('matter');
    expect(tourForPath('/matters/m-doyle/documents')?.id).toBe('matter-documents');
    expect(tourForPath('/matters/m-doyle/time')?.id).toBe('matter-time');
    expect(tourForPath('/matters/new')).toBeUndefined();
    expect(tourForPath('/matters/board')).toBeUndefined();
    expect(tourForPath('/billing')?.id).toBe('billing');
    expect(tourForPath('/settings/preferences')?.id).toBe('settings');
    expect(tourForPath('/inbox')).toBeUndefined();
  });

  it('has storable ids, valid selectors and short words', () => {
    expect(TOURS.size).toBe(PAGE_TOURS.length + 1);
    for (const tour of TOURS.values()) {
      expect(tour.id).toMatch(TOUR_ID_PATTERN);
      expect(tour.steps.length).toBeGreaterThan(0);
      for (const step of tour.steps) {
        const targets = typeof step.target === 'string' ? [step.target] : (step.target ?? []);
        for (const target of targets) expect(() => document.querySelector(target)).not.toThrow();
        expect(step.title.length).toBeLessThanOrEqual(40);
        expect(step.body.length).toBeLessThanOrEqual(220);
      }
    }
    expect(WELCOME_TOUR.intro).toBe(true);
    expect(WELCOME_TOUR.steps[0]?.target).toBeUndefined();
  });
});

describe('guided tours in the app', () => {
  let rects: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // jsdom lays nothing out: give every element a box, so every tour step's feature is "on screen".
    rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 40,
      left: 40,
      width: 200,
      height: 40,
      right: 240,
      bottom: 80,
      x: 40,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    rects.mockRestore();
    document.querySelectorAll('mt-tour-overlay').forEach((node) => node.remove());
    document.body.querySelectorAll('[inert]').forEach((node) => node.removeAttribute('inert'));
    localStorage.clear();
  });

  async function open(url: string, options: { tours?: { auto: boolean; seen: string[] }; flag?: boolean } = {}) {
    const firestore = new InMemoryFirestore();
    firestore.set(`orgs/${ORG}`, { name: 'Harbour & Vine Legal', timezone: 'Australia/Melbourne', ...meta });
    firestore.set(`users/${UID}`, userDoc(options.tours));
    const fake = provideFakeAuth(testSession());
    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter(appRoutes),
        { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
        ...fake.providers,
        ...provideTestFlags({ 'tours.enabled': options.flag ?? true }),
        provideInMemoryFirestore(firestore),
      ],
    });
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    const stable = async (ms = 0) => {
      await settle(ms);
      await fixture.whenStable();
      await settle();
    };
    await router.navigateByUrl(url);
    await stable();
    const card = () => document.querySelector<HTMLElement>('mt-tour-overlay .mt-tour-card');
    /** Waits for the tour card (or its absence) — the chunk loads and features are looked for. */
    const waitFor = async (present: boolean, ms = 4000) => {
      const until = Date.now() + ms;
      while (!!card() !== present && Date.now() < until) await stable(50);
      await stable();
    };
    const press = async (key: string, init: KeyboardEventInit = {}) => {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
      await stable();
    };
    const click = async (selector: string) => {
      card()?.querySelector<HTMLElement>(selector)?.click();
      await stable(200);
    };
    return {
      firestore,
      router,
      fixture,
      stable,
      card,
      waitFor,
      press,
      click,
      tours: () => (firestore.get(`users/${UID}`) as { prefs: { tours?: unknown } }).prefs.tours,
      title: () => card()?.querySelector('h2')?.textContent?.trim(),
      eyebrow: () => card()?.querySelector('.eyebrow')?.textContent?.trim(),
    };
  }

  it('offers the welcome tour on first sign-in; Skip leaves page tours off for good', async () => {
    const app = await open('/inbox');
    await app.waitFor(true);
    const card = app.card();
    expect(card?.getAttribute('role')).toBe('dialog');
    expect(card?.getAttribute('aria-modal')).toBe('true');
    expect(app.title()).toBe('Let’s show you around');
    expect(document.activeElement?.hasAttribute('data-tour-next')).toBe(true);
    // The page behind can't be reached while the tour is open.
    expect(document.querySelector('mt-root, [ng-version]')?.closest('[inert]')).not.toBeNull();
    await app.click('[data-tour-skip]');
    await app.waitFor(false);
    expect(app.tours()).toEqual({ auto: false, seen: ['welcome'] });
    expect(document.querySelectorAll('[inert]')).toHaveLength(0);
  });

  it('walks the shell with Show me around, and turns page tours on', async () => {
    const app = await open('/inbox');
    await app.waitFor(true);
    await app.click('[data-tour-next]');
    expect(app.title()).toBe('Your pages');
    expect(app.eyebrow()).toMatch(/^Welcome · 1 of \d$/);
    expect(document.querySelector('mt-tour-overlay .mt-tour-spot')?.hasAttribute('data-target')).toBe(true);
    expect(document.querySelector('[data-tour-announce]')?.textContent).toContain('Your pages');
    await app.press('ArrowRight');
    expect(app.title()).toBe('Find anything, do anything');
    await app.press('ArrowLeft');
    expect(app.title()).toBe('Your pages');
    // Tab stays in the card.
    const buttons = [...(app.card()?.querySelectorAll<HTMLElement>('button') ?? [])];
    buttons.at(-1)?.focus();
    await app.press('Tab');
    expect(document.activeElement).toBe(buttons[0]);
    // The page's own shortcuts don't fire behind the tour.
    await app.press('?');
    expect(document.querySelector('.mt-shortcuts, [data-shortcuts]')).toBeNull();
    await app.press('Escape');
    await app.waitFor(false);
    expect(app.tours()).toEqual({ auto: true, seen: ['welcome'] });
  });

  it('plays a page’s tour the first time it opens, once', async () => {
    const app = await open('/inbox', { tours: { auto: true, seen: ['welcome'] } });
    await app.router.navigateByUrl('/settings/preferences');
    await app.stable(AUTO_START_DELAY_MS);
    await app.waitFor(true);
    expect(app.eyebrow()).toMatch(/^Settings · 1 of 2$/);
    expect(app.title()).toBe('Settings');
    await app.click('[data-tour-next]');
    expect(app.title()).toBe('Guided tours');
    await app.click('[data-tour-next]');
    await app.waitFor(false);
    expect(app.tours()).toEqual({ auto: true, seen: ['welcome', 'settings'] });
    // Coming back doesn't play it again.
    await app.router.navigateByUrl('/inbox');
    await app.router.navigateByUrl('/settings/profile');
    await app.stable(AUTO_START_DELAY_MS + 300);
    expect(app.card()).toBeNull();
  });

  it('starts the page’s tour from ⌘K and the hotkey with page tours off, and says when a page has none', async () => {
    const app = await open('/settings/preferences', { tours: { auto: false, seen: ['welcome'] } });
    const registry = TestBed.inject(CommandRegistry);
    const command = registry.get('tours.page');
    expect(command?.shortcut).toBe(TOUR_SHORTCUT);
    expect(command?.when?.()).toBe(true);
    const search = document.querySelector<HTMLElement>('[data-tour="search"]');
    search?.focus();
    if (!command) throw new Error('No "Tour this page" command');
    registry.run(command);
    await app.waitFor(true);
    expect(app.title()).toBe('Settings');
    await app.click('[data-tour-close]');
    await app.waitFor(false);
    // Focus goes back where it was.
    expect(document.activeElement).toBe(search);

    await app.press('H', { shiftKey: true });
    await app.waitFor(true);
    expect(app.title()).toBe('Settings');
    await app.press('Escape');
    await app.waitFor(false);

    await app.router.navigateByUrl('/inbox');
    await app.stable();
    await TestBed.inject(TourService).startForPage();
    await app.stable();
    expect(document.body.textContent).toContain('This page doesn’t have a tour yet');
    expect(app.card()).toBeNull();
  });

  it('switches page tours and replays them from Settings → Preferences', async () => {
    const app = await open('/settings/preferences', { tours: { auto: false, seen: ['welcome', 'today', 'settings'] } });
    const section = document.querySelector('[data-tour="tours-settings"]');
    expect(section?.textContent).toContain('Guided tours');
    section?.querySelector<HTMLElement>('[role="switch"], button.mt-switch, input')?.click();
    await app.stable();
    expect(app.tours()).toEqual({ auto: true, seen: ['welcome', 'today', 'settings'] });
    section?.querySelector<HTMLElement>('[data-tour-replay]')?.click();
    await app.stable();
    expect(app.tours()).toEqual({ auto: true, seen: ['welcome'] });
    // Settings, where the switch was used, doesn't start its own tour underneath the person.
    await app.stable(AUTO_START_DELAY_MS + 300);
    expect(app.card()).toBeNull();
    section?.querySelector<HTMLElement>('[data-tour-welcome]')?.click();
    await app.waitFor(true);
    expect(app.title()).toBe('Let’s show you around');
  });

  it('shows nothing with the flag off', async () => {
    const app = await open('/settings/preferences', { flag: false });
    await app.stable(500);
    expect(app.card()).toBeNull();
    expect(TestBed.inject(CommandRegistry).get('tours.page')?.when?.()).toBe(false);
    expect(document.querySelector('[data-tour="tours-settings"]')).toBeNull();
    await app.press('H', { shiftKey: true });
    await app.stable(300);
    expect(app.card()).toBeNull();
  });
});
