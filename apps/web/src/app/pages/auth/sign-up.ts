import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { MtButton, MtNote, MtTextField } from '@materia/ui';

import { authErrorMessage } from './auth-flow';
import { AuthState } from '../../core/auth/auth-state';

/** Identity Platform enforces the same minimum (FND-16 password policy). */
export const MIN_PASSWORD_LENGTH = 12;

/** A length-based strength hint: length matters most for passphrases. */
export function passwordStrength(password: string): { level: 0 | 1 | 2 | 3 | 4; label: string } {
  if (password.length < MIN_PASSWORD_LENGTH)
    return { level: password ? 1 : 0, label: `At least ${MIN_PASSWORD_LENGTH} characters` };
  if (password.length < 16) return { level: 2, label: 'OK' };
  if (password.length < 20) return { level: 3, label: 'Good' };
  return { level: 4, label: 'Strong' };
}

/**
 * Create an account (FND-16): from an invite link (`?email=`) or to create a practice (FND-17).
 * Sign-up is invitation-only in prod; the blocking function refuses others.
 */
@Component({
  selector: 'mt-sign-up-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MtButton, MtNote, MtTextField],
  template: `
    <header class="mt-auth-head">
      <h1 class="title-m">Create your account</h1>
      <p>Use your work email. We’ll send a link to confirm it.</p>
    </header>
    <form class="mt-auth-form" [formGroup]="form" (ngSubmit)="submit()">
      <mt-text-field label="Full name" autocomplete="name" formControlName="name" required />
      <mt-text-field label="Work email" type="email" autocomplete="email" formControlName="email" required />
      <mt-text-field
        label="Password"
        type="password"
        autocomplete="new-password"
        formControlName="password"
        required
        [errorMessages]="{ minlength: 'Use at least 12 characters.' }"
      />
      <span class="mt-strength" [attr.data-level]="strength().level < 2 ? 'gap' : null" aria-live="polite">
        @for (dot of dots; track dot) {
          <i [class.on]="dot < strength().level" aria-hidden="true"></i>
        }
        {{ strength().label }}
      </span>
      @if (error(); as message) {
        <mt-note tone="danger">{{ message }}</mt-note>
      }
      <button mtButton variant="primary" type="submit" class="mt-auth-wide" [loading]="busy()">Create account</button>
    </form>
    <p class="mt-auth-foot">
      <span>Already have an account? <a routerLink="/auth/sign-in">Sign in</a></span>
    </p>
  `,
})
export class SignUpPage {
  private readonly auth = inject(AuthState);
  private readonly router = inject(Router);
  private readonly email = inject(ActivatedRoute).snapshot.queryParamMap.get('email') ?? '';

  protected readonly dots = [0, 1, 2, 3];
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    email: new FormControl(this.email, { nonNullable: true, validators: [Validators.required, Validators.email] }),
    password: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(MIN_PASSWORD_LENGTH)],
    }),
  });
  private readonly password = toSignal(this.form.controls.password.valueChanges, { initialValue: '' });
  protected readonly strength = computed(() => passwordStrength(this.password()));

  protected async submit(): Promise<void> {
    this.error.set(null);
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const { name, email, password } = this.form.getRawValue();
    this.busy.set(true);
    try {
      await this.auth.signUp(email, password, name);
      await this.router.navigateByUrl('/auth/verify-email');
    } catch (error) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
