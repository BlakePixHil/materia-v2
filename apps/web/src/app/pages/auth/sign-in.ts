import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { MtButton, MtCheckbox, MtNote, MtTextField } from '@materia/ui';

import { authErrorMessage, continueAfterSignIn } from './auth-flow';
import { AuthFlowError, type SignInOutcome } from '../../core/auth/auth-port';
import { AuthState } from '../../core/auth/auth-state';

/** Sign in (FND-16): email, then password; or Google. "Shared computer" keeps the session to this tab. */
@Component({
  selector: 'mt-sign-in-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MtButton, MtCheckbox, MtNote, MtTextField],
  template: `
    <header class="mt-auth-head">
      <h1 class="title-m">Sign in to Materia</h1>
      @if (reenrol) {
        <p>Your authenticator was removed. Sign in with your password, then set it up again.</p>
      }
    </header>
    @if (link(); as pending) {
      <mt-note tone="info">
        {{ pending.email }} already has an account. Sign in with your password to link {{ pending.method }} to it.
      </mt-note>
    }
    <button
      mtButton
      variant="secondary"
      class="mt-auth-wide"
      [loading]="busy() === 'google'"
      [disabled]="!!busy()"
      (click)="google()"
    >
      Continue with Google
    </button>
    <div class="mt-auth-or"><span>or</span></div>
    <form class="mt-auth-form" [formGroup]="form" (ngSubmit)="submit()">
      @if (step() === 'email') {
        <mt-text-field label="Work email" type="email" autocomplete="username" formControlName="email" required />
        <button mtButton variant="primary" type="submit" class="mt-auth-wide">Continue</button>
      } @else {
        <div class="mt-auth-email">
          <span class="mt-ell">{{ form.controls.email.value }}</span>
          <button type="button" class="mt-auth-link" (click)="step.set('email')">Change</button>
        </div>
        <mt-text-field
          label="Password"
          type="password"
          autocomplete="current-password"
          formControlName="password"
          required
        />
        <mt-checkbox label="This is a shared computer (sign out when this tab closes)" formControlName="shared" />
        @if (error(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
        <button
          mtButton
          variant="primary"
          type="submit"
          class="mt-auth-wide"
          [loading]="busy() === 'password'"
          [disabled]="!!busy()"
        >
          Sign in
        </button>
      }
    </form>
    @if (step() === 'email' && error(); as message) {
      <mt-note tone="danger">{{ message }}</mt-note>
    }
    <p class="mt-auth-foot">
      <a routerLink="/auth/forgot-password">Forgot your password?</a>
      <a routerLink="/auth/sign-up">Create an account</a>
      <a routerLink="/auth/recover">Lost your authenticator?</a>
    </p>
  `,
})
export class SignInPage {
  private readonly auth = inject(AuthState);
  private readonly router = inject(Router);
  private readonly params = inject(ActivatedRoute).snapshot.queryParamMap;

  protected readonly reenrol = this.params.get('reenrol') === '1';
  protected readonly step = signal<'email' | 'password'>('email');
  protected readonly busy = signal<'password' | 'google' | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly link = signal(this.auth.api.pendingLink());
  protected readonly form = new FormGroup({
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    shared: new FormControl(false, { nonNullable: true }),
  });

  protected async submit(): Promise<void> {
    this.error.set(null);
    if (this.step() === 'email') {
      this.form.controls.email.markAsTouched();
      if (this.form.controls.email.valid) this.step.set('password');
      return;
    }
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const { email, password, shared } = this.form.getRawValue();
    await this.run('password', () => this.auth.signInWithPassword(email, password, shared ? 'session' : 'local'));
  }

  protected google(): Promise<void> {
    this.error.set(null);
    return this.run('google', () => this.auth.signInWithGoogle(this.form.controls.shared.value ? 'session' : 'local'));
  }

  private async run(kind: 'password' | 'google', attempt: () => Promise<SignInOutcome>): Promise<void> {
    this.busy.set(kind);
    try {
      const outcome = await attempt();
      if (outcome.kind === 'mfaRequired') {
        await this.router.navigate(['/auth/mfa'], { queryParamsHandling: 'preserve' });
        return;
      }
      await this.auth.whenReady();
      if (this.reenrol) {
        await this.router.navigateByUrl('/auth/mfa/enrol');
        return;
      }
      await continueAfterSignIn(this.auth, this.router, this.params.get('returnUrl'));
    } catch (error) {
      if (error instanceof AuthFlowError && error.code === 'account-exists') {
        this.link.set(this.auth.api.pendingLink());
        if (error.detail.email) this.form.controls.email.setValue(error.detail.email);
        this.step.set('password');
      }
      this.error.set(authErrorMessage(error));
    } finally {
      this.busy.set(null);
    }
  }
}
