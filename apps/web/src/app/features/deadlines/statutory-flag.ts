import { computed, inject, signal, type Signal } from '@angular/core';

import type { Jurisdiction } from '@materia/domain';

import { statutoryFlagFor } from './deadline-view';
import { FeatureFlagService } from '../../core/flags/feature-flags';

/**
 * Whether the statutory deadline rules are off (their rule set awaits practitioner review) for any
 * of these jurisdictions, once the flags have loaded. Lists then show `STATUTORY_DISABLED_MESSAGE`.
 * Create it in an injection context.
 */
export function statutoryDisabled(jurisdictions: () => readonly (Jurisdiction | undefined)[]): Signal<boolean> {
  const flags = inject(FeatureFlagService);
  const ready = signal(false);
  flags.ready().then(
    () => ready.set(true),
    () => ready.set(true),
  );
  return computed(
    () =>
      ready() &&
      jurisdictions().some((jurisdiction) => {
        const key = statutoryFlagFor(jurisdiction);
        return !!key && !flags.isOn(key);
      }),
  );
}
