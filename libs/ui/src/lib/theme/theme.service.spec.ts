import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';

import {
  localStorageThemeStore,
  THEME_PREFERENCE_STORE,
  THEME_STORAGE_KEY,
  ThemeService,
  type ThemePreference,
  type ThemePreferenceStore,
} from './theme.service';

/** A controllable `prefers-color-scheme: dark` media query. */
function fakeMedia(initialDark: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches: initialDark,
    addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.delete(fn),
  };
  return {
    media,
    listeners,
    change(dark: boolean) {
      media.matches = dark;
      for (const fn of listeners) fn({ matches: dark } as MediaQueryListEvent);
    },
  };
}

function memoryStore(initial: ThemePreference | null = null): ThemePreferenceStore & { saved: ThemePreference[] } {
  let value = initial;
  const saved: ThemePreference[] = [];
  return {
    saved,
    load: () => value,
    save: (preference) => {
      value = preference;
      saved.push(preference);
    },
  };
}

function setup({ dark = false, stored = null as ThemePreference | null } = {}) {
  const media = fakeMedia(dark);
  const store = memoryStore(stored);
  const doc = document.implementation.createHTMLDocument('theme');
  Object.defineProperty(doc, 'defaultView', { value: { matchMedia: () => media.media } });
  TestBed.configureTestingModule({
    providers: [
      { provide: DOCUMENT, useValue: doc },
      { provide: THEME_PREFERENCE_STORE, useValue: store },
    ],
  });
  const service = TestBed.inject(ThemeService);
  const attr = () => doc.documentElement.getAttribute('data-theme');
  return { service, media, store, attr };
}

describe('ThemeService', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('defaults to system and follows a light OS', () => {
    const { service, attr } = setup({ dark: false });
    expect(service.theme()).toBe('system');
    expect(service.resolved()).toBe('light');
    expect(attr()).toBe('light');
  });

  it('defaults to system and follows a dark OS', () => {
    const { service, attr } = setup({ dark: true });
    expect(service.resolved()).toBe('dark');
    expect(attr()).toBe('dark');
  });

  it('reacts to a media query change while on system', () => {
    const { service, media, attr } = setup({ dark: false });
    media.change(true);
    expect(service.resolved()).toBe('dark');
    expect(attr()).toBe('dark');
    media.change(false);
    expect(attr()).toBe('light');
  });

  it('an explicit light choice wins over a dark OS, and ignores media changes', () => {
    const { service, media, attr } = setup({ dark: true });
    service.setTheme('light');
    expect(attr()).toBe('light');
    media.change(true);
    expect(attr()).toBe('light');
  });

  it('an explicit dark choice wins over a light OS', () => {
    const { service, attr } = setup({ dark: false });
    service.setTheme('dark');
    expect(service.theme()).toBe('dark');
    expect(attr()).toBe('dark');
  });

  it('persists the choice and restores it on the next load', () => {
    const { service, store } = setup();
    service.setTheme('dark');
    service.setTheme('system');
    expect(store.saved).toEqual(['dark', 'system']);

    TestBed.resetTestingModule();
    const next = setup({ stored: 'dark', dark: false });
    expect(next.service.theme()).toBe('dark');
    expect(next.attr()).toBe('dark');
  });

  it('applies a valid profile preference and ignores junk', () => {
    const { service, store, attr } = setup();
    service.applyProfilePreference('dark');
    expect(attr()).toBe('dark');
    service.applyProfilePreference('dark');
    service.applyProfilePreference('purple');
    service.applyProfilePreference(undefined);
    expect(store.saved).toEqual(['dark']);
  });

  it('removes its media listener when destroyed', () => {
    const { media } = setup();
    expect(media.listeners.size).toBe(1);
    TestBed.resetTestingModule();
    expect(media.listeners.size).toBe(0);
  });

  it('works without matchMedia (light)', () => {
    const doc = document.implementation.createHTMLDocument('theme');
    Object.defineProperty(doc, 'defaultView', { value: {} });
    TestBed.configureTestingModule({
      providers: [
        { provide: DOCUMENT, useValue: doc },
        { provide: THEME_PREFERENCE_STORE, useValue: memoryStore() },
      ],
    });
    expect(TestBed.inject(ThemeService).resolved()).toBe('light');
  });
});

describe('localStorageThemeStore', () => {
  it('round-trips a preference', () => {
    const storage = new Map<string, string>();
    const fake = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
    } as unknown as Storage;
    const store = localStorageThemeStore(() => fake);
    expect(store.load()).toBeNull();
    store.save('dark');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(store.load()).toBe('dark');
  });

  it('ignores invalid stored values', () => {
    const fake = { getItem: () => 'purple' } as unknown as Storage;
    expect(localStorageThemeStore(() => fake).load()).toBeNull();
  });

  it('swallows storage errors (blocked storage)', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    } as unknown as Storage;
    const store = localStorageThemeStore(() => blocked);
    expect(store.load()).toBeNull();
    expect(() => store.save('light')).not.toThrow();
  });

  it('works when there is no storage at all', () => {
    const store = localStorageThemeStore(() => undefined);
    expect(store.load()).toBeNull();
    expect(() => store.save('dark')).not.toThrow();
  });
});

describe('THEME_PREFERENCE_STORE default', () => {
  it('uses the document localStorage', () => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    const store = TestBed.inject(THEME_PREFERENCE_STORE);
    store.save('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(store.load()).toBe('light');
    localStorage.removeItem(THEME_STORAGE_KEY);
  });
});
