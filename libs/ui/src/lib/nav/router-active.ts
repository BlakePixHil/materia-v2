import { DestroyRef, inject, type Signal, signal } from '@angular/core';
import { RouterLinkActive } from '@angular/router';

/**
 * Whether the `RouterLinkActive` on the current element (a host directive) is active, as a signal,
 * so OnPush components can bind `data-active` and `aria-current`. The URL stays the source of truth.
 */
export function routerLinkActiveSignal(): Signal<boolean> {
  const rla = inject(RouterLinkActive, { self: true });
  const active = signal(false);
  const subscription = rla.isActiveChange.subscribe((value) => active.set(value));
  inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  return active.asReadonly();
}
