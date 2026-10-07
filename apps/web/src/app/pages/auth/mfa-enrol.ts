import { ChangeDetectionStrategy, Component, computed, inject, signal, type OnInit } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';

import { MtButton, MtCheckbox, MtNote, MtTextField } from '@materia/ui';

import { authErrorMessage, continueAfterSignIn } from './auth-flow';
import { MtQrCode } from './qr-code';
import type { TotpEnrolment } from '../../core/auth/auth-port';
import { AuthState } from '../../core/auth/auth-state';

/** Groups a secret in fours for reading aloud or typing: `JBSW Y3DP EHPK 3PXP`. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * Set up an authenticator app (FND-16): re-authenticate if the sign-in is old, scan the QR code
 * (or type the key), confirm a code, then save ten recovery codes.
 */
@Component({
  selector: 'mt-mfa-enrol-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MtButton, MtCheckbox, MtNote, MtTextField, MtQrCode],
  template: `
    @switch (step()) {
      @case ('reauth') {
        <header class="mt-auth-head">
          <h1 class="title-m">Confirm it’s you</h1>
          <p>{{ google() ? 'Sign in with Google again' : 'Enter your password' }} to set up two-step sign-in.</p>
        </header>
        @if (google()) {
          <button
            mtButton
            variant="secondary"
            type="button"
            class="mt-auth-wide"
            [loading]="busy()"
            (click)="reauthGoogle()"
          >
            Continue with Google
          </button>
        }
        @if (error() && google() && !hasPassword()) {
          <mt-note tone="danger">{{ error() }}</mt-note>
        }
        @if (hasPassword()) {
          <form class="mt-auth-form" [formGroup]="reauthForm" (ngSubmit)="reauth()">
            <mt-text-field
              label="Password"
              type="password"
              autocomplete="current-password"
              formControlName="password"
              required
            />
            @if (error(); as message) {
              <mt-note tone="danger">{{ message }}</mt-note>
            }
            <button mtButton variant="primary" type="submit" class="mt-auth-wide" [loading]="busy()">Continue</button>
          </form>
        }
      }
      @case ('scan') {
        <header class="mt-auth-head">
          <h1 class="title-m">Set up your authenticator</h1>
          <p>
            Scan this with an authenticator app (such as Microsoft Authenticator or 1Password), then enter the 6-digit
            code it shows.
          </p>
        </header>
        @if (enrolment(); as e) {
          <div class="mt-auth-qr">
            <mt-qr-code [value]="e.uri" label="QR code to add Materia to your authenticator app" />
            <div class="mt-col" style="gap: 4px">
              <span class="label-s">Can’t scan? Enter this key</span>
              <code class="mt-auth-secret">{{ grouped() }}</code>
            </div>
          </div>
        }
        <form class="mt-auth-form" [formGroup]="codeForm" (ngSubmit)="confirm()">
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
          <button
            mtButton
            variant="primary"
            type="submit"
            class="mt-auth-wide"
            [loading]="busy()"
            [disabled]="!enrolment()"
          >
            Turn on two-step sign-in
          </button>
        </form>
      }
      @case ('codes') {
        <header class="mt-auth-head">
          <h1 class="title-m">Save your recovery codes</h1>
          <p>
            If you lose your phone, each code lets you sign in once. Keep them somewhere safe, like a password manager.
          </p>
        </header>
        <ol class="mt-auth-codes" aria-label="Recovery codes">
          @for (c of codes(); track c) {
            <li>
              <code>{{ c }}</code>
            </li>
          }
        </ol>
        <div class="mt-row" style="gap: 8px">
          <button mtButton variant="secondary" iconStart="copy" (click)="copy()">
            {{ copied() ? 'Copied' : 'Copy codes' }}
          </button>
          <button mtButton variant="secondary" iconStart="arrow-down" (click)="download()">Download</button>
        </div>
        @if (error(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
        <mt-checkbox label="I’ve saved these codes" [formControl]="saved" />
        <button mtButton variant="primary" class="mt-auth-wide" [disabled]="!saved.value" (click)="finish()">
          Continue
        </button>
      }
      @default {
        <h1 class="title-m">One moment…</h1>
        @if (error(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
      }
    }
  `,
})
export class MfaEnrolPage implements OnInit {
  private readonly auth = inject(AuthState);
  private readonly router = inject(Router);
  protected readonly step = signal<'loading' | 'reauth' | 'scan' | 'codes'>('loading');
  protected readonly enrolment = signal<TotpEnrolment | null>(null);
  protected readonly grouped = computed(() => groupSecret(this.enrolment()?.secret ?? ''));
  protected readonly codes = signal<string[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly password = new FormControl('', { nonNullable: true, validators: [Validators.required] });
  protected readonly code = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.pattern(/^\s*\d{3}\s?\d{3}\s*$/)],
  });
  protected readonly saved = new FormControl(false, { nonNullable: true });
  protected readonly reauthForm = new FormGroup({ password: this.password });
  private readonly providers = computed(() => this.auth.session()?.providerIds ?? []);
  /** Google accounts confirm through the Google popup (SEC-04); password accounts by password. */
  protected readonly google = computed(() => this.providers().includes('google.com'));
  protected readonly hasPassword = computed(() => this.providers().includes('password') || !this.google());
  protected readonly codeForm = new FormGroup({ code: this.code });

  async ngOnInit(): Promise<void> {
    await this.auth.whenReady();
    if (this.auth.isRecentLogin(5)) await this.start();
    else {
      this.step.set('reauth');
      if (this.google()) void this.auth.api.preparePopups();
    }
  }

  protected async reauth(): Promise<void> {
    this.password.markAsTouched();
    if (this.password.invalid) return;
    await this.attempt(async () => {
      await this.auth.api.reauthenticateWithPassword(this.password.value);
      await this.start();
    });
  }

  protected async reauthGoogle(): Promise<void> {
    await this.attempt(async () => {
      await this.auth.api.reauthenticate({ kind: 'google' });
      await this.start();
    });
  }

  protected async confirm(): Promise<void> {
    this.code.markAsTouched();
    if (this.code.invalid) return;
    await this.attempt(async () => {
      await this.auth.api.finishTotpEnrolment(this.code.value.replace(/\s/g, ''));
      const { codes } = await this.auth.api.call<{ codes: string[] }>('auth-generateRecoveryCodes', {});
      this.codes.set(codes);
      this.step.set('codes');
    });
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.codes().join('\n'));
      this.copied.set(true);
    } catch {
      this.error.set('Copying didn’t work. Select the codes and copy them, or use Download.');
    }
  }

  protected download(): void {
    const blob = new Blob([`Materia recovery codes\n\n${this.codes().join('\n')}\n\nEach code works once.\n`], {
      type: 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href: url, download: 'materia-recovery-codes.txt' });
    link.click();
    URL.revokeObjectURL(url);
  }

  protected finish(): Promise<void> {
    return continueAfterSignIn(this.auth, this.router, null);
  }

  private async start(): Promise<void> {
    this.step.set('scan');
    await this.attempt(async () => this.enrolment.set(await this.auth.api.startTotpEnrolment()));
  }

  private async attempt(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await work();
    } catch (error) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
