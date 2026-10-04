import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { MtButton, MtNote, MtTextField } from '@materia/ui';

import { authErrorMessage } from './auth-flow';
import { AuthState } from '../../core/auth/auth-state';

/** Request a reset link. The reply never reveals whether the account exists. */
@Component({
  selector: 'mt-forgot-password-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MtButton, MtNote, MtTextField],
  template: `
    <header class="mt-auth-head">
      <h1 class="title-m">Reset your password</h1>
      <p>Enter your work email and we’ll send a link to choose a new password.</p>
    </header>
    <div role="status">
      @if (sent()) {
        <mt-note tone="info"
          >If there’s an account for {{ email.value }}, a reset link is on its way. It expires in an hour.</mt-note
        >
      }
    </div>
    @if (!sent()) {
      <form class="mt-auth-form" [formGroup]="form" (ngSubmit)="submit()">
        <mt-text-field label="Work email" type="email" autocomplete="email" formControlName="email" required />
        @if (error(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
        <button mtButton variant="primary" type="submit" class="mt-auth-wide" [loading]="busy()">
          Send reset link
        </button>
      </form>
    }
    <p class="mt-auth-foot"><a routerLink="/auth/sign-in">Back to sign in</a></p>
  `,
})
export class ForgotPasswordPage {
  private readonly auth = inject(AuthState);
  protected readonly email = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.email],
  });
  protected readonly form = new FormGroup({ email: this.email });
  protected readonly busy = signal(false);
  protected readonly sent = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    this.email.markAsTouched();
    if (this.email.invalid) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.api.sendPasswordReset(this.email.value);
      this.sent.set(true);
    } catch (error) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
