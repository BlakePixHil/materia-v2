import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { ORG_TIMEZONES, type Jurisdiction } from '@materia/domain';
import { MtButton, MtNote, MtSelect, MtTextField, type MtOption } from '@materia/ui';

import { errorCopy } from '../../core/error-copy';
import { OrgService, pendingInvite } from '../../core/orgs/org-service';

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
 * Onboarding (FND-17): create the practice, which makes you its owner. Someone with an invite
 * waiting (they signed up from the link) is offered it first. A practice brought across from the
 * old materia never comes here (its owner already has one): its import step is Settings → Import
 * from materia, offered from Today (MIG-08, D-22).
 */
@Component({
  selector: 'mt-onboarding-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MtButton, MtNote, MtSelect, MtTextField],
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
      @if (error(); as message) {
        <mt-note tone="danger">{{ message }}</mt-note>
      }
      <button mtButton variant="primary" type="submit" class="mt-auth-wide" [loading]="busy()">Create practice</button>
    </form>
  `,
})
export class OnboardingPage {
  private readonly orgs = inject(OrgService);
  private readonly router = inject(Router);

  protected readonly jurisdictions = JURISDICTIONS;
  protected readonly timezones = TIMEZONES;
  protected readonly invite = pendingInvite();
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(120)] }),
    abn: new FormControl('', { nonNullable: true, validators: [Validators.pattern(/^\s*(\d\s*){11}$/)] }),
    primaryJurisdiction: new FormControl<Jurisdiction>('VIC', { nonNullable: true, validators: [Validators.required] }),
    timezone: new FormControl<string>('Australia/Melbourne', { nonNullable: true, validators: [Validators.required] }),
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
      });
      await this.router.navigateByUrl('/today');
    } catch (error) {
      this.error.set(errorCopy(error));
    } finally {
      this.busy.set(false);
    }
  }
}
