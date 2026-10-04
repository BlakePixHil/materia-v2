import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, Injectable, InjectionToken, signal, computed } from '@angular/core';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** localStorage key, shared with the boot script in apps/web/src/index.html. */
export const THEME_STORAGE_KEY = 'mt-theme';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * Where the preference is kept. The default uses localStorage (wrapped in try/catch: storage can
 * be blocked). Once a user is signed in, data-access mirrors it to `users/{uid}.prefs.theme` and
 * calls `ThemeService.applyProfilePreference` with the stored value.
 */
export interface ThemePreferenceStore {
  load(): ThemePreference | null;
  save(preference: ThemePreference): void;
}

export function localStorageThemeStore(storage: () => Storage | undefined): ThemePreferenceStore {
  return {
    load() {
      try {
        const value = storage()?.getItem(THEME_STORAGE_KEY);
        return isThemePreference(value) ? value : null;
      } catch {
        return null;
      }
    },
    save(preference) {
      try {
        storage()?.setItem(THEME_STORAGE_KEY, preference);
      } catch {
        // Storage blocked (private mode, quota): the preference lasts for this page only.
      }
    },
  };
}

export const THEME_PREFERENCE_STORE = new InjectionToken<ThemePreferenceStore>('THEME_PREFERENCE_STORE', {
  providedIn: 'root',
  factory: () => {
    const view = inject(DOCUMENT).defaultView;
    return localStorageThemeStore(() => view?.localStorage);
  },
});

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Light, dark or follow the system (FND-07). Sets `data-theme` on `<html>` to the resolved theme;
 * the token CSS keys off that attribute, so an explicit choice beats `prefers-color-scheme`.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly store = inject(THEME_PREFERENCE_STORE);
  private readonly media = this.document.defaultView?.matchMedia?.(DARK_QUERY) ?? null;
  private readonly systemDark = signal(this.media?.matches ?? false);
  private readonly preference = signal<ThemePreference>(this.store.load() ?? 'system');

  /** The user's choice. */
  readonly theme = this.preference.asReadonly();
  /** What is on screen. */
  readonly resolved = computed<ResolvedTheme>(() => {
    const theme = this.preference();
    if (theme !== 'system') return theme;
    return this.systemDark() ? 'dark' : 'light';
  });

  constructor() {
    const onChange = (event: MediaQueryListEvent) => {
      this.systemDark.set(event.matches);
      this.apply();
    };
    this.media?.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => this.media?.removeEventListener('change', onChange));
    this.apply();
  }

  setTheme(theme: ThemePreference): void {
    this.preference.set(theme);
    this.store.save(theme);
    this.apply();
  }

  /** Adopts the preference saved on the signed-in user's profile, and caches it locally. */
  applyProfilePreference(theme: unknown): void {
    if (isThemePreference(theme) && theme !== this.preference()) this.setTheme(theme);
  }

  private apply(): void {
    this.document.documentElement.setAttribute('data-theme', this.resolved());
  }
}
