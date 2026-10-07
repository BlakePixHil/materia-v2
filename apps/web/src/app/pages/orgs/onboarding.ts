import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import {
  DELETE_ACCOUNT_CALLABLE,
  DELETE_ACCOUNT_CONFIRMATION,
  ORG_TIMEZONES,
  TERMS_VERSION,
  termsAskedIn,
  type DeleteAccountInput,
  type Jurisdiction,
} from '@materia/domain';
import {
  DialogService,
  MtButton,
  MtCheckbox,
  MtNote,
  MtSelect,
  MtTextField,
  ToastService,
  type MtOption,
} from '@materia/ui';

import { environment } from '../../../environments/environment';
import { AuthState } from '../../core/auth/auth-state';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { OrgService, pendingInvite } from '../../core/orgs/org-service';
import { MtNeedsConnection } from '../../core/pwa/needs-connection';

const JURISDICTIONS: MtOption<Jurisdiction>[] = [
  { value: 'VIC', label: 'Victoria' },
  { value: 'NSW', label: 'New South Wales' },
  { value: 'QLD', label: 'Queensland' },
  { value: 'SA', label: 'South Australia' },
  { value: 'WA', label: 'Western Australia' },
  { value: 'TAS', label: 'Tasmania' },
  { value: 'ACT', label: 'Australian Capital Territory' },
  { value: 'NT', label: 'Northern Territory' },
];

const TIMEZONES: MtOption<string>[] = ORG_TIMEZONES.map((zone) => ({
  value: zone,
  label: zone.replace('Australia/', ''),
}));

/**
 * Onboarding (FND-17): create the practice, which makes you its owner, accepting the terms of
 * service and DPA for it (SEC-01: recorded on the org, so its owner isn't asked again; in prod only
 * once the terms are signed off, `termsAskedIn`). Someone with an invite
 * waiting (they signed up from the link) is offered it first. A practice brought across from the
 * old materia never comes here (its owner already has one): its import step is Settings → Import
 * from materia, offered from Today (MIG-08, D-22). Someone in no practice who doesn't want an account
 * any more deletes it here (`auth-deleteAccount`, SEC-05), typing DELETE.
 */
@Component({
  selector: 'mt-onboarding-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MtButton, MtCheckbox, MtNeedsConnection, MtNote, MtSelect, MtTextField],
  template: `
    <header class="mt-auth-head">
      <h1 class="title-m">Set up your practice</h1>
      <p>You’ll be its owner. You can invite your team next.</p>
    </header>
    @if (invite; as path) {
      <mt-note tone="info">
        You have an invitation waiting.
        <a [routerLink]="invitePath(path)" [queryParams]="inviteQuery(path)">Accept it</a>
        to join that practice instead.
      </mt-note>
    }
    <form class="mt-auth-form" [formGroup]="form" (ngSubmit)="submit()">
      <mt-text-field label="Practice name" autocomplete="organization" formControlName="name" required />
      <mt-text-field
        label="ABN"
        inputmode="numeric"
        formControlName="abn"
        optional
        description="11 digits. You can add it later in settings."
        [errorMessages]="{ pattern: 'An ABN is 11 digits.' }"
      />
      <mt-select
        label="Primary jurisdiction"
        formControlName="primaryJurisdiction"
        [options]="jurisdictions"
        [native]="true"
        required
      />
      <mt-select label="Time zone" formControlName="timezone" [options]="timezones" [native]="true" required />
      @if (askTerms) {
        <div class="terms">
          <p>
            Read the
            <a routerLink="/legal/terms" target="_blank"
              >terms of service<span class="mt-sr"> (opens in a new tab)</span></a
            >, including the
            <a routerLink="/legal/dpa" target="_blank"
              >data processing addendum<span class="mt-sr"> (opens in a new tab)</span></a
            >, and the
            <a routerLink="/legal/privacy" target="_blank"
              >privacy policy<span class="mt-sr"> (opens in a new tab)</span></a
            >.
          </p>
          <mt-checkbox
            formControlName="acceptTerms"
            required
            label="I accept the terms of service and data processing addendum on behalf of my practice."
          />
        </div>
      }
      @if (error(); as message) {
        <mt-note tone="danger">{{ message }}</mt-note>
      }
      <button mtButton variant="primary" type="submit" class="mt-auth-wide" [loading]="busy()">Create practice</button>
    </form>
    <p class="mt-auth-foot">
      <button type="button" class="mt-auth-link" mtNeedsConnection [disabled]="deleting()" (click)="deleteAccount()">
        Delete my account
      </button>
    </p>
  `,
  styles: `
    .terms {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .terms p {
      margin: 0;
      color: var(--text-secondary);
      font: 400 13px/18px var(--font-sans);
    }
    .terms a {
      color: var(--text-brand);
    }
  `,
})
export class OnboardingPage {
  private readonly orgs = inject(OrgService);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthState);
  private readonly callables = inject(CALLABLES);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);

  protected readonly jurisdictions = JURISDICTIONS;
  protected readonly timezones = TIMEZONES;
  protected readonly invite = pendingInvite();
  /** Whether this practice's owner accepts the terms here (SEC-01; prod waits for the sign-off). */
  protected readonly askTerms = termsAskedIn(environment.name);
  protected readonly busy = signal(false);
  protected readonly deleting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(120)] }),
    abn: new FormControl('', { nonNullable: true, validators: [Validators.pattern(/^\s*(\d\s*){11}$/)] }),
    primaryJurisdiction: new FormControl<Jurisdiction>('VIC', { nonNullable: true, validators: [Validators.required] }),
    timezone: new FormControl<string>('Australia/Melbourne', { nonNullable: true, validators: [Validators.required] }),
    acceptTerms: new FormControl(false, {
      nonNullable: true,
      validators: this.askTerms ? [Validators.requiredTrue] : [],
    }),
  });

  protected invitePath(path: string): string {
    return path.split('?')[0] ?? path;
  }

  protected inviteQuery(path: string): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(path.split('?')[1] ?? ''));
  }

  protected async submit(): Promise<void> {
    this.error.set(null);
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const { name, abn, primaryJurisdiction, timezone } = this.form.getRawValue();
    this.busy.set(true);
    try {
      await this.orgs.createOrg({
        name: name.trim(),
        ...(abn.trim() ? { abn } : {}),
        primaryJurisdiction,
        timezone: timezone as (typeof ORG_TIMEZONES)[number],
        ...(this.askTerms ? { acceptTermsVersion: TERMS_VERSION } : {}),
      });
      await this.router.navigateByUrl('/today');
    } catch (error) {
      this.error.set(errorCopy(error));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Deletes the account (sign-in, profile and photo) after the person types DELETE, confirming it's
   * them when their sign-in is old, then signs out. Refused while they still belong to a practice.
   */
  protected async deleteAccount(): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: 'Delete your account?',
      body:
        'Your sign-in, profile and photo are deleted for good. You aren’t in any practice, so nothing else changes. ' +
        `Type ${DELETE_ACCOUNT_CONFIRMATION} to confirm.`,
      confirmLabel: 'Delete account',
      tone: 'danger',
      typedConfirmation: DELETE_ACCOUNT_CONFIRMATION,
    });
    if (!confirmed) return;
    this.deleting.set(true);
    this.error.set(null);
    try {
      await this.callables.call<DeleteAccountInput, { deleted: true }>(DELETE_ACCOUNT_CALLABLE, {
        confirmation: DELETE_ACCOUNT_CONFIRMATION,
      });
      await this.auth.signOut().catch(() => undefined);
      this.toasts.show({ title: 'Your account is deleted', tone: 'success' });
      await this.router.navigateByUrl('/auth/sign-in');
    } catch (error) {
      this.error.set(errorCopy(error));
    } finally {
      this.deleting.set(false);
    }
  }
}
