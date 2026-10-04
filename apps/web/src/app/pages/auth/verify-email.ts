import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { MtButton, MtNote } from '@materia/ui';

import { authErrorMessage, continueAfterSignIn } from './auth-flow';
import { AuthState } from '../../core/auth/auth-state';

/** Seconds before another verification email can be sent. */
export const RESEND_COOLDOWN_S = 60;

/** "Check your inbox" (FND-16): resend the link, or continue once it's clicked (on any device). */
@Component({
  selector: 'mt-verify-email-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtNote],
  template: `
    <header class="mt-auth-head">
      <h1 class="title-m">Confirm your email</h1>
      <p>
        We sent a link to <strong>{{ email }}</strong
        >. Open it on any device, then come back here.
      </p>
    </header>
    <div role="status">
      @if (message(); as text) {
        <mt-note [tone]="tone()">{{ text }}</mt-note>
      }
    </div>
    <button mtButton variant="primary" class="mt-auth-wide" [loading]="busy() === 'check'" (click)="check()">
      I’ve confirmed my email
    </button>
    <button mtButton variant="ghost" class="mt-auth-wide" [disabled]="cooldown() > 0 || !!busy()" (click)="resend()">
      {{ cooldown() > 0 ? 'Send again in ' + cooldown() + 's' : 'Send the link again' }}
    </button>
    <p class="mt-auth-foot">
      <button type="button" class="mt-auth-link" (click)="signOut()">Use a different account</button>
    </p>
  `,
})
export class VerifyEmailPage {
  private readonly auth = inject(AuthState);
  private readonly router = inject(Router);
  protected readonly email = this.auth.user()?.email ?? 'your email';
  protected readonly busy = signal<'check' | 'resend' | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly tone = signal<'info' | 'danger'>('info');
  protected readonly cooldown = signal(0);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearInterval(this.timer));
  }

  protected async check(): Promise<void> {
    this.busy.set('check');
    try {
      await this.auth.reload();
      if (this.auth.status() === 'needsVerification') {
        this.tone.set('info');
        this.message.set('We haven’t seen the confirmation yet. Open the link in the email, then try again.');
      } else {
        await continueAfterSignIn(this.auth, this.router, null);
      }
    } catch (error) {
      this.tone.set('danger');
      this.message.set(authErrorMessage(error));
    } finally {
      this.busy.set(null);
    }
  }

  protected async resend(): Promise<void> {
    this.busy.set('resend');
    try {
      await this.auth.sendVerificationEmail();
      this.tone.set('info');
      this.message.set('Sent. Check your inbox (and your junk folder).');
      this.startCooldown();
    } catch (error) {
      this.tone.set('danger');
      this.message.set(authErrorMessage(error));
    } finally {
      this.busy.set(null);
    }
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/auth/sign-in');
  }

  private startCooldown(): void {
    this.cooldown.set(RESEND_COOLDOWN_S);
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.cooldown.update((s) => Math.max(0, s - 1));
      if (this.cooldown() === 0) clearInterval(this.timer);
    }, 1000);
  }
}
