import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { MT_ORG_TIMEZONE, MtNote } from '@materia/ui';

import { AuthState } from '../auth/auth-state';
import { SessionPolicy } from '../auth/session-policy';

/**
 * "This practice will be deleted on …" (SEC-05): on every page while a deletion is scheduled. The
 * practice is read-only until then (the callables and rules refuse changes); the banner says why
 * a change fails before anyone tries. Owners get the way to cancel or export.
 */
@Component({
  selector: 'mt-deletion-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MtNote],
  template: `
    @if (policy.deletionScheduledAt(); as at) {
      <mt-note tone="danger" data-deletion-banner>
        {{ orgName() }} will be deleted on {{ day(at) }}. Until then it’s read-only.
        @if (owner()) {
          <a routerLink="/settings/data">Cancel or export</a>
        } @else {
          You can still read and export. An owner can cancel the deletion.
        }
      </mt-note>
    }
  `,
})
export class MtDeletionBanner {
  protected readonly policy = inject(SessionPolicy);
  private readonly auth = inject(AuthState);
  private readonly timeZone = inject(MT_ORG_TIMEZONE);

  protected readonly owner = computed(() => this.auth.claims().role === 'owner');
  protected readonly orgName = computed(() => this.auth.claims().orgName ?? 'This practice');

  protected day(at: Date): string {
    return at.toLocaleDateString('en-AU', { timeZone: this.timeZone, day: 'numeric', month: 'long', year: 'numeric' });
  }
}
