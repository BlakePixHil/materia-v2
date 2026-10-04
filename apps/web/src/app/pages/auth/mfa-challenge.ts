import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { MtButton, MtNote, MtTextField } from '@materia/ui';

import { authErrorMessage, continueAfterSignIn } from './auth-flow';
import { AuthState } from '../../core/auth/auth-state';

/** The second step of sign-in: the 6-digit code from the authenticator app. */
@Component({
  selector: 'mt-mfa-challenge-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MtButton, MtNote, MtTextField],
  template: `
    <header class="mt-auth-head">
      <h1 class="title-m">Enter your code</h1>
      <p>Open your authenticator app and enter the 6-digit code for Materia.</p>
    </header>
    <form class="mt-auth-form" [formGroup]="form" (ngSubmit)="submit()">
      <mt-text-field
        label="6-digit code"
        inputmode="numeric"
        autocomplete="one-time-code"
        formControlName="code"
        required
        [errorMessages]="{ pattern: 'Enter the 6 digits from your app.' }"
      />
      @if (error(); as message) {
        <mt-note tone="danger">{{ message }}</mt-note>
      }
      <button mtButton variant="primary" type="submit" class="mt-auth-wide" [loading]="busy()">Verify</button>
    </form>
    <p class="mt-auth-foot">
      <a routerLink="/auth/recover">Use a recovery code</a>
      <a routerLink="/auth/sign-in">Start again</a>
    </p>
  `,
})
export class MfaChallengePage {
  private readonly auth = inject(AuthState);
  private readonly router = inject(Router);
  private readonly returnUrl = inject(ActivatedRoute).snapshot.queryParamMap.get('returnUrl');
  protected readonly code = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.pattern(/^\s*\d{3}\s?\d{3}\s*$/)],
  });
  protected readonly form = new FormGroup({ code: this.code });
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    this.code.markAsTouched();
    if (this.code.invalid) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.completeMfa(this.code.value.replace(/\s/g, ''));
      await this.auth.whenReady();
      await continueAfterSignIn(this.auth, this.router, this.returnUrl);
    } catch (error) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
