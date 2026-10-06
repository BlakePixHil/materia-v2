import { ChangeDetectionStrategy, Component, computed } from '@angular/core';

import { injectDialogRef, MtButton, MtDialog } from '@materia/ui';

import type { IdleTimeout } from './idle-timeout';

/**
 * "Are you still there?" (SEC-04): counts down the last minute before the inactivity sign-out.
 * Closes `true` for "Sign out now"; "Stay signed in" (or any activity) closes it `false`.
 */
@Component({
  selector: 'mt-idle-warning-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtDialog],
  template: `
    <mt-dialog
      size="sm"
      title="Are you still there?"
      description="For security, Materia signs you out when you haven’t used it for a while."
      [closeOnOutsideClick]="false"
    >
      <p style="margin: 0" role="timer" aria-live="polite" data-idle-countdown>
        You’ll be signed out in {{ countdown() }}.
      </p>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" type="button" (click)="ref.close(true)">Sign out now</button>
        <button mtButton variant="primary" type="button" (click)="ref.close(false)">Stay signed in</button>
      </ng-container>
    </mt-dialog>
  `,
})
export class IdleWarningDialog {
  protected readonly ref = injectDialogRef<IdleTimeout, boolean>();
  private readonly idle = this.ref.data;

  protected readonly countdown = computed(() => {
    const seconds = this.idle.secondsLeft() ?? 0;
    return seconds === 1 ? '1 second' : `${seconds} seconds`;
  });
}
