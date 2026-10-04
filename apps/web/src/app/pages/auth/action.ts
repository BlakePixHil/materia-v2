import { ChangeDetectionStrategy, Component, inject, signal, type OnInit } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { MtButton, MtNote, MtTextField } from '@materia/ui';

import { authErrorMessage, continueAfterSignIn } from './auth-flow';
import { MIN_PASSWORD_LENGTH } from './sign-up';
import { AuthState } from '../../core/auth/auth-state';

/**
 * Email action links (`/auth/action?mode=…&oobCode=…`): confirm an email (on any device) or set a
 * new password. Point the Identity Platform email templates' action URL here.
 */
@Component({
  selector: 'mt-auth-action-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MtButton, MtNote, MtTextField],
  template: `
    @switch (state()) {
      @case ('working') {
        <h1 class="title-m">One moment…</h1>
      }
      @case ('verified') {
        <h1 class="title-m">Email confirmed</h1>
        <mt-note tone="info">Thanks. Your email is confirmed.</mt-note>
        <button mtButton variant="primary" class="mt-auth-wide" (click)="continue()">Continue</button>
      }
      @case ('reset') {
        <header class="mt-auth-head">
          <h1 class="title-m">Choose a new password</h1>
          <p>For {{ resetEmail() }}.</p>
        </header>
        <form class="mt-auth-form" [formGroup]="form" (ngSubmit)="reset()">
          <mt-text-field
            label="New password"
            type="password"
            autocomplete="new-password"
            formControlName="password"
            required
            [errorMessages]="{ minlength: 'Use at least 12 characters.' }"
          />
          @if (error(); as message) {
            <mt-note tone="danger">{{ message }}</mt-note>
          }
          <button mtButton variant="primary" type="submit" class="mt-auth-wide" [loading]="busy()">
            Save password
          </button>
        </form>
      }
      @case ('done') {
        <h1 class="title-m">Password changed</h1>
        <mt-note tone="info">Sign in with your new password.</mt-note>
        <a mtButton variant="primary" class="mt-auth-wide" routerLink="/auth/sign-in">Sign in</a>
      }
      @default {
        <h1 class="title-m">This link doesn’t work</h1>
        <mt-note tone="danger">{{ error() }}</mt-note>
        <a mtButton variant="secondary" class="mt-auth-wide" routerLink="/auth/sign-in">Back to sign in</a>
      }
    }
  `,
})
export class AuthActionPage implements OnInit {
  private readonly auth = inject(AuthState);
  private readonly router = inject(Router);
  private readonly params = inject(ActivatedRoute).snapshot.queryParamMap;
  protected readonly state = signal<'working' | 'verified' | 'reset' | 'done' | 'failed'>('working');
  protected readonly resetEmail = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly password = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.minLength(MIN_PASSWORD_LENGTH)],
  });
  protected readonly form = new FormGroup({ password: this.password });
  private readonly code = this.params.get('oobCode') ?? '';

  async ngOnInit(): Promise<void> {
    const mode = this.params.get('mode');
    try {
      if (!this.code) throw new Error('missing code');
      if (mode === 'verifyEmail') {
        await this.auth.api.applyVerificationCode(this.code);
        this.state.set('verified');
      } else if (mode === 'resetPassword') {
        this.resetEmail.set(await this.auth.api.verifyResetCode(this.code));
        this.state.set('reset');
      } else {
        throw new Error('unsupported mode');
      }
    } catch (error) {
      this.error.set(
        error instanceof Error && error.name !== 'AuthFlowError'
          ? 'This link is incomplete or not supported.'
          : authErrorMessage(error),
      );
      this.state.set('failed');
    }
  }

  protected async reset(): Promise<void> {
    this.password.markAsTouched();
    if (this.password.invalid) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.api.confirmPasswordReset(this.code, this.password.value);
      this.state.set('done');
    } catch (error) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected async continue(): Promise<void> {
    if (this.auth.signedIn()) await continueAfterSignIn(this.auth, this.router, null);
    else await this.router.navigateByUrl('/auth/sign-in');
  }
}
