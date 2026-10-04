import { InjectionToken } from '@angular/core';

import type { DomainError } from '@materia/domain';

/*
 * Kept apart from repository.ts so the app's root providers can use them without pulling the
 * repository and paging code into the initial bundle.
 */

/**
 * Called when a read is refused after the person's access changed (`ACCESS_REVOKED`). The web
 * app routes to the no-access page; the default does nothing.
 */
export const ACCESS_REVOKED_HANDLER = new InjectionToken<(error: DomainError) => void>('ACCESS_REVOKED_HANDLER', {
  providedIn: 'root',
  factory: () => () => undefined,
});

/** The clock for the count cache (tests replace it). */
export const DATA_CLOCK = new InjectionToken<() => number>('DATA_CLOCK', {
  providedIn: 'root',
  factory: () => () => Date.now(),
});
