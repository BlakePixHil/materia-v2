import { computed, DestroyRef, Directive, effect, ElementRef, inject } from '@angular/core';
import { NgpButton } from 'ng-primitives/button';

import { Connectivity } from '@materia/data-access';
import { ToastService } from '@materia/ui';

import { NEEDS_CONNECTION_COPY } from '../error-copy';

/**
 * For a button whose action is a callable (ADR-020: callables need a connection). Offline it reads
 * "Needs connection" and is disabled: soft-disabled, so it stays focusable and says why, and a
 * click explains instead of running the action.
 *
 * ```html
 * <button mtButton variant="primary" mtNeedsConnection (click)="approve()">Approve invoice</button>
 * ```
 */
@Directive({
  selector: '[mtNeedsConnection]',
  host: {
    '[attr.title]': 'offline() ? copy.short : null',
    '[attr.data-needs-connection]': 'offline() ? "" : null',
  },
})
export class MtNeedsConnection {
  private readonly online = inject(Connectivity).online;
  protected readonly offline = computed(() => !this.online());
  protected readonly copy = NEEDS_CONNECTION_COPY;

  constructor() {
    const button = inject(NgpButton, { self: true, optional: true });
    if (button) {
      effect(() => {
        const own = button.disabled();
        button.setDisabled(this.offline() ? (own === true ? true : 'soft') : own);
      });
    }
    // Runs before the button's own (click): at its target, capturing listeners go first.
    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const toasts = inject(ToastService);
    const guard = (event: Event) => {
      if (!this.offline()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toasts.show({ title: NEEDS_CONNECTION_COPY.long });
    };
    element.addEventListener('click', guard, { capture: true });
    inject(DestroyRef).onDestroy(() => element.removeEventListener('click', guard, { capture: true }));
  }
}
