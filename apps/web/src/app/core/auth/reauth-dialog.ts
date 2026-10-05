import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { DialogService, injectDialogRef, MtButton, MtDialog, MtNote, MtTextField } from '@materia/ui';

import { AUTH_ERROR_COPY, AuthFlowError, type ReauthMethod } from './auth-port';
import { AuthState } from './auth-state';
import { errorCodeOf, errorCopy } from '../error-copy';

export interface ReauthDialogData {
  /** Why it's asked ("Releasing an original will needs a fresh sign-in."). */
  reason: string;
}

/**
 * "Confirm it's you" (CORE-17): signs the person in again (Google, or their password, then their
 * authenticator code when they use two-step sign-in) so a sensitive callable sees a recent login.
 * Closes `true` once they have.
 */
@Component({
  selector: 'mt-reauth-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtNote, MtTextField],
  template: `
    <mt-dialog size="sm" title="Confirm it’s you" [description]="data.reason" [closeOnOutsideClick]="false">
      <form
        id="mt-reauth-form"
        class="mt-col"
        style="gap: var(--space-12)"
        (submit)="$event.preventDefault(); submit()"
      >
        @if (mfa()) {
          <mt-text-field
            name="code"
            label="Code from your authenticator app"
            autocomplete="one-time-code"
            inputmode="numeric"
            [ngModel]="code()"
            (ngModelChange)="code.set($event ?? '')"
          />
        } @else {
          @if (google()) {
            <button mtButton variant="secondary" type="button" [loading]="busy()" (click)="signIn({ kind: 'google' })">
              Continue with Google
            </button>
          }
          @if (password()) {
            <mt-text-field
              name="password"
              type="password"
              label="Password"
              autocomplete="current-password"
              [ngModel]="secret()"
              (ngModelChange)="secret.set($event ?? '')"
            />
          }
        }
        @if (error(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close(false)">Cancel</button>
        @if (mfa() || password()) {
          <button mtButton variant="primary" type="submit" form="mt-reauth-form" [loading]="busy()">Confirm</button>
        }
      </ng-container>
    </mt-dialog>
  `,
})
export class ReauthDialog {
  protected readonly ref = injectDialogRef<ReauthDialogData, boolean>();
  protected readonly data = this.ref.data;
  private readonly auth = inject(AuthState);

  private readonly providers = computed(() => this.auth.session()?.providerIds ?? []);
  protected readonly google = computed(() => this.providers().includes('google.com'));
  /** Password sign-in, and the fallback when the session names no method. */
  protected readonly password = computed(() => this.providers().includes('password') || !this.google());
  protected readonly mfa = signal(false);
  protected readonly secret = signal('');
  protected readonly code = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected submit(): void {
    if (this.mfa()) void this.finishMfa();
    else void this.signIn({ kind: 'password', password: this.secret() });
  }

  protected async signIn(method: ReauthMethod): Promise<void> {
    if (method.kind === 'password' && !method.password) {
      this.error.set('Enter your password.');
      return;
    }
    await this.attempt(async () => {
      const outcome = await this.auth.api.reauthenticate(method);
      if (outcome.kind === 'mfaRequired') this.mfa.set(true);
      else void this.ref.close(true);
    });
  }

  private async finishMfa(): Promise<void> {
    const code = this.code().replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) {
      this.error.set('Enter the 6-digit code.');
      return;
    }
    await this.attempt(async () => {
      await this.auth.api.completeMfa(code);
      void this.ref.close(true);
    });
  }

  private async attempt(work: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await work();
    } catch (error) {
      this.error.set(error instanceof AuthFlowError ? AUTH_ERROR_COPY[error.code] : errorCopy(error));
    } finally {
      this.busy.set(false);
    }
  }
}

/** Whether a callable refused for want of a recent sign-in. */
export function isReauthRequired(error: unknown): boolean {
  return errorCodeOf(error) === 'REAUTH_REQUIRED';
}

/**
 * Runs a sensitive action that needs a recent sign-in: asks the person to confirm it's them first
 * when their sign-in is older than `minutes`, and once more if the server still refuses (clocks
 * differ). Resolves undefined when they cancel. Call in an injection context.
 */
export function injectRecentLogin(minutes: number) {
  const auth = inject(AuthState);
  const dialogs = inject(DialogService);
  const confirm = async (reason: string) =>
    (await dialogs.open<ReauthDialogData, boolean>(ReauthDialog, { data: { reason } }).result) === true;
  return async <T>(reason: string, run: () => Promise<T>): Promise<T | undefined> => {
    if (!auth.isRecentLogin(minutes) && !(await confirm(reason))) return undefined;
    try {
      return await run();
    } catch (error) {
      if (!isReauthRequired(error)) throw error;
      if (!(await confirm(reason))) return undefined;
      return run();
    }
  };
}
