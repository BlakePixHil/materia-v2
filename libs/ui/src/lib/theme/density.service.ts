import { DOCUMENT } from '@angular/common';
import { inject, Injectable, signal } from '@angular/core';

export type DensityPreference = 'comfortable' | 'compact';

/** localStorage key: the last density, so a reload starts in it before the profile loads. */
export const DENSITY_STORAGE_KEY = 'mt-density';

function storage(document: Document): Storage | undefined {
  try {
    return document.defaultView?.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Comfortable or compact (CORE-20). Sets `data-density` on `<html>`; tables without an explicit
 * `density` follow it. The signed-in person's choice is `users/{uid}.prefs.density`, applied by the
 * app on load and on every change (so another tab's change applies here too).
 */
@Injectable({ providedIn: 'root' })
export class DensityService {
  private readonly document = inject(DOCUMENT);
  private readonly value = signal<DensityPreference>(this.load());

  readonly density = this.value.asReadonly();

  constructor() {
    this.apply();
  }

  setDensity(density: DensityPreference): void {
    if (density !== 'comfortable' && density !== 'compact') return;
    this.value.set(density);
    try {
      storage(this.document)?.setItem(DENSITY_STORAGE_KEY, density);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
    this.apply();
  }

  private load(): DensityPreference {
    try {
      return storage(this.document)?.getItem(DENSITY_STORAGE_KEY) === 'compact' ? 'compact' : 'comfortable';
    } catch {
      return 'comfortable';
    }
  }

  private apply(): void {
    this.document.documentElement.setAttribute('data-density', this.value());
  }
}
