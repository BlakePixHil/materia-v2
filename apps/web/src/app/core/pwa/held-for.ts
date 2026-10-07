import { computed, effect, signal, type Signal } from '@angular/core';

/**
 * True once `condition` has held for `ms` without a break, false as soon as it doesn't. Call in an
 * injection context.
 */
export function heldFor(condition: () => boolean, ms: number): Signal<boolean> {
  const now = computed(condition);
  const held = signal(false);
  effect((onCleanup) => {
    if (!now()) {
      held.set(false);
      return;
    }
    const timer = setTimeout(() => held.set(true), ms);
    onCleanup(() => clearTimeout(timer));
  });
  return held.asReadonly();
}
