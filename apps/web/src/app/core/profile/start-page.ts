import { DOCUMENT } from '@angular/common';
import { inject } from '@angular/core';

/*
 * Kept apart from UserPrefsService so the routes (in the initial bundle) can read the start page
 * without pulling in the data layer.
 */

/** localStorage key: where `/` lands (CORE-20), known before the profile loads. */
export const START_PAGE_STORAGE_KEY = 'mt-start-page';

export type StartPagePath = 'today' | 'matters';

/** Where `/` goes: the saved start page, Today until one is chosen. Call in an injection context. */
export function startPagePath(): StartPagePath {
  try {
    return inject(DOCUMENT).defaultView?.localStorage.getItem(START_PAGE_STORAGE_KEY) === 'matters'
      ? 'matters'
      : 'today';
  } catch {
    return 'today';
  }
}
