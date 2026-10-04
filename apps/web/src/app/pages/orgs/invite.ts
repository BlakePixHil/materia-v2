import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { MtButton, MtNote } from '@materia/ui';

import { AuthState } from '../../core/auth/auth-state';
import { errorCodeOf, errorCopy } from '../../core/error-copy';
import { OrgService, rememberInvite } from '../../core/orgs/org-service';

/**
 * The invite link's landing page (`/invite/:id?token=…`, FND-17). Signed out: sign in or create an
 * account first (the link is remembered for this tab). Signed in and verified: accept, which joins
 * the practice and makes it the active one.
 */
@Component({
  selector: 'mt-invite-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MtButton, MtNote],
  template: `
    <header class="mt-auth-head">
      <h1 class="title-m">Join your practice on Materia</h1>
      @switch (status()) {
        @case ('signedOut') {
          <p>Sign in, or create an account with the email this invite was sent to.</p>
        }
        @case ('needsVerification') {
          <p>Confirm your email first. Then come back to this link.</p>
        }
        @default {
          <p>You’ve been invited to join a practice{{ email() ? ' as ' + email() : '' }}.</p>
        }
      }
    </header>
    @if (!token) {
      <mt-note tone="danger">This invite link is incomplete. Open it again from the email.</mt-note>
    } @else if (status() === 'signedOut') {
      <div class="mt-col" style="gap: 8px">
        <a
          mtButton
          variant="primary"
          class="mt-auth-wide"
          routerLink="/auth/sign-in"
          [queryParams]="{ returnUrl: here }"
          >Sign in</a
        >
        <a mtButton class="mt-auth-wide" routerLink="/auth/sign-up">Create an account</a>
      </div>
    } @else if (status() === 'needsVerification') {
      <a mtButton variant="primary" class="mt-auth-wide" routerLink="/auth/verify-email">Confirm your email</a>
    } @else if (status() !== 'loading') {
      @if (error(); as message) {
        <mt-note tone="danger">{{ message }}</mt-note>
      }
      @if (expired()) {
        <p class="mt-auth-foot">Ask whoever invited you to send a new invite.</p>
      } @else {
        <button mtButton variant="primary" class="mt-auth-wide" [loading]="busy()" (click)="accept()">
          Accept invitation
        </button>
      }
    }
  `,
})
export class InvitePage {
  private readonly auth = inject(AuthState);
  private readonly orgs = inject(OrgService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute).snapshot;

  private readonly inviteId = this.route.paramMap.get('id') ?? '';
  protected readonly token = this.route.queryParamMap.get('token') ?? '';
  protected readonly here = `/invite/${encodeURIComponent(this.inviteId)}?token=${encodeURIComponent(this.token)}`;
  protected readonly status = computed(() => this.auth.status());
  protected readonly email = computed(() => this.auth.user()?.email ?? '');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly expired = signal(false);

  constructor() {
    // Kept for this tab, so onboarding can offer it after sign-up and email confirmation.
    if (this.token) rememberInvite(this.here);
  }

  protected async accept(): Promise<void> {
    this.error.set(null);
    this.busy.set(true);
    try {
      await this.orgs.acceptInvite(this.inviteId, this.token);
      await this.router.navigateByUrl('/today');
    } catch (error) {
      const code = errorCodeOf(error);
      this.expired.set(code === 'INVITE_EXPIRED' || code === 'INVITE_INVALID');
      this.error.set(errorCopy(error));
    } finally {
      this.busy.set(false);
    }
  }
}
