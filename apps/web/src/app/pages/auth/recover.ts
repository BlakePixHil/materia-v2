import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { MtButton, MtNote, MtTextField } from '@materia/ui';

import { authErrorMessage } from './auth-flow';
import { AuthState } from '../../core/auth/auth-state';

/**
 * Lost authenticator (FND-16): a recovery code removes the old authenticator. The person then
 * signs in with their password and sets up a new one. Each code works once.
 */
@Component({
  selector: 'mt-recover-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MtButton, MtNote, MtTextField],
  template: `
    <header class="mt-auth-head">
      <h1 class="title-m">Use a recovery code</h1>
      <p>Enter one of the recovery codes you saved when you set up your authenticator.</p>
    </header>
    <form class="mt-auth-form" [formGroup]="form" (ngSubmit)="submit()">
      <mt-text-field label="Work email" type="email" autocomplete="username" formControlName="email" required />
      <mt-text-field
        label="Recovery code"
        autocomplete="off"
        placeholder="ABCDE-FGHJK"
        formControlName="code"
        required
      />
      @if (error(); as message) {
        <mt-note tone="danger">{{ message }}</mt-note>
      }
      <button mtButton variant="primary" type="submit" class="mt-auth-wide" [loading]="busy()">Continue</button>
    </form>
    <p class="mt-auth-foot">
      <span>No codes left? Ask your practice admin to reset your authenticator.</span>
      <a routerLink="/auth/sign-in">Back to sign in</a>
    </p>
  `,
})
export class RecoverPage {
  private readonly auth = inject(AuthState);
  private readonly router = inject(Router);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly form = new FormGroup({
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
    code: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(10)] }),
  });

  protected async submit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.api.call('auth-useRecoveryCode', this.form.getRawValue());
      await this.auth.signOut();
      await this.router.navigate(['/auth/sign-in'], { queryParams: { reenrol: 1 } });
    } catch (error) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
