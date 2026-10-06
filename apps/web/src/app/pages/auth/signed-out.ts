import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { MtButton } from '@materia/ui';

import type { SessionEndReason } from '../../core/auth/session-policy';

const COPY: Record<SessionEndReason, { heading: string; body: string }> = {
  idle: {
    heading: 'Signed out due to inactivity',
    body: 'You hadn’t used Materia for a while, so we signed you out to keep client information safe. Anything you saved is still there.',
  },
  expired: {
    heading: 'Your sign-in has expired',
    body: 'Your practice asks everyone to sign in again after a set number of days.',
  },
  revoked: {
    heading: 'You were signed out',
    body: 'This device was signed out, either by you from another device or by a practice admin. Sign in again to continue.',
  },
  mfa: {
    heading: 'Sign in with your authenticator',
    body: 'Your practice now requires two-step sign-in. Sign in again and enter the code from your authenticator app.',
  },
};

/** Why the app signed someone out (SEC-04): inactivity, an expired or revoked sign-in, or MFA. */
@Component({
  selector: 'mt-signed-out-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MtButton],
  template: `
    <header class="mt-auth-head">
      <h1 class="title-m">{{ copy().heading }}</h1>
      <p>{{ copy().body }}</p>
    </header>
    <a mtButton variant="primary" class="mt-auth-wide" routerLink="/auth/sign-in">Sign in again</a>
  `,
})
export class SignedOutPage {
  private readonly reason = toSignal(inject(ActivatedRoute).queryParamMap.pipe(map((params) => params.get('reason'))), {
    initialValue: null,
  });
  protected readonly copy = computed(() => COPY[(this.reason() ?? 'idle') as SessionEndReason] ?? COPY.idle);
}
