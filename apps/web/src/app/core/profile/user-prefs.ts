import { DOCUMENT } from '@angular/common';
import { computed, effect, inject, Injectable, untracked } from '@angular/core';

import { OrgContext } from '@materia/data-access';
import { userProfileRepository } from '@materia/data-access/repository';
import { readUserPrefs, type StartPage, type UserPrefs } from '@materia/domain';
import { DensityService, ThemeService } from '@materia/ui';

import { START_PAGE_STORAGE_KEY } from './start-page';

/** The stored form of the preferences: `User.update` validates it, and Firestore refuses `undefined`. */
function stored(prefs: UserPrefs): Record<string, unknown> {
  const { timezone, ...rest } = prefs;
  return timezone ? { ...rest, timezone } : rest;
}

/**
 * The signed-in person's profile and preferences (CORE-20), from a live `users/{uid}` listener.
 * Theme and density apply as soon as they load or change, in this tab and every other one (each
 * follows the same document). Saves are client-direct and queue while offline.
 */
@Injectable({ providedIn: 'root' })
export class UserPrefsService {
  private readonly context = inject(OrgContext);
  private readonly theme = inject(ThemeService);
  private readonly density = inject(DensityService);
  private readonly document = inject(DOCUMENT);
  private readonly users = userProfileRepository();
  /**
   * Changes saved here that the listener may not have delivered yet. The next save builds on them,
   * so two quick changes (the theme, then quiet hours) don't save the first one's old value back.
   */
  private unconfirmed: Partial<UserPrefs> = {};
  private saves = 0;

  /** `users/{uid}`, live. */
  readonly profile = this.users.watch(() => this.context.uid());
  /** Every preference, defaults filled. */
  readonly prefs = computed(() => readUserPrefs(this.profile.value()?.prefs));
  readonly loaded = computed(() => this.profile.status() === 'ready' || !!this.profile.value());

  constructor() {
    effect(() => {
      const doc = this.profile.value();
      if (!doc) return;
      const prefs = this.prefs();
      untracked(() => {
        this.theme.applyProfilePreference(prefs.theme);
        this.density.setDensity(prefs.density);
        this.remember(prefs.startPage);
      });
    });
  }

  /**
   * Changes some preferences: applied here at once, then saved whole to `users/{uid}.prefs`.
   * The returned promise settles when the server has it; callers needn't wait (offline, it queues).
   */
  save(patch: Partial<UserPrefs>, zone?: { timezone: string } | { clearTimezone: true }): Promise<void> {
    const uid = this.context.uid();
    const changes: Partial<UserPrefs> = { ...patch };
    // The time zone is optional (the org's when absent): clearing it saves '', which `stored` drops.
    if (zone) changes.timezone = 'timezone' in zone ? zone.timezone : '';
    if (patch.theme) this.theme.setTheme(patch.theme);
    if (patch.density) this.density.setDensity(patch.density);
    if (patch.startPage) this.remember(patch.startPage);
    if (!uid) return Promise.resolve();
    this.unconfirmed = { ...this.unconfirmed, ...changes };
    const next: UserPrefs = { ...this.prefs(), ...this.unconfirmed };
    const save = ++this.saves;
    const write = this.users.update(uid, { prefs: stored(next) });
    // Once the latest save settles, the listener has it (or has rolled it back), so start afresh.
    const settled = () => {
      if (save === this.saves) this.unconfirmed = {};
    };
    write.then(settled, settled);
    return write;
  }

  /** Changes the person's names or photo URL on `users/{uid}`; `remove` deletes fields (the photo). */
  saveProfile(
    patch: { firstName?: string; lastName?: string; displayName?: string; avatarUrl?: string },
    remove: readonly 'avatarUrl'[] = [],
  ): Promise<void> {
    const uid = this.context.uid();
    if (!uid) return Promise.reject(new Error('Not signed in'));
    return this.users.update(uid, patch, { remove });
  }

  private remember(page: StartPage): void {
    try {
      this.document.defaultView?.localStorage.setItem(START_PAGE_STORAGE_KEY, page);
    } catch {
      // Storage blocked: `/` goes to Today.
    }
  }
}
