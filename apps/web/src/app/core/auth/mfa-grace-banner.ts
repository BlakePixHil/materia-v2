import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { MtNote } from '@materia/ui';

import { SessionPolicy } from './session-policy';

/**
 * "Your practice requires two-step sign-in from …" (SEC-04): shown on every page during the grace
 * period after an org turns MFA on, to members who haven't set it up. Once it ends the guards
 * send them to set it up before anything else.
 */
@Component({
  selector: 'mt-mfa-grace-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MtNote],
  template: `
    @if (policy.mfaGraceUntil(); as until) {
      <mt-note tone="warning" data-mfa-grace style="margin: 0 0 16px">
        Your practice requires two-step sign-in from {{ when(until) }}.
        <a routerLink="/auth/mfa/enrol">Set it up now</a>
      </mt-note>
    }
  `,
})
export class MtMfaGraceBanner {
  protected readonly policy = inject(SessionPolicy);

  protected when(at: Date): string {
    return at.toLocaleString('en-AU', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
}
