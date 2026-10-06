import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { OrgContext } from '@materia/data-access';
import { orgTrustSettingsRepository, trustCallables } from '@materia/data-access/repository';
import {
  TRUST_EXPLAINER,
  TRUST_RECORDS_SYSTEMS,
  trustSettingsOf,
  TrustSettingsInput,
  type TrustRecordsSystem,
} from '@materia/domain';
import {
  MtBadge,
  MtButton,
  MtNote,
  MtSelect,
  MtSettingsRow,
  MtSettingsSection,
  MtSwitch,
  MtTextField,
  ToastService,
  type MtOption,
} from '@materia/ui';

import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { warnBeforeUnload, type HasUnsavedChanges } from '../settings/unsaved-changes';

interface TrustForm {
  showOnMatters: boolean;
  system: TrustRecordsSystem;
  otherName: string;
  staleAfterDays: string;
}

function formOf(trust: Parameters<typeof trustSettingsOf>[0]): TrustForm {
  const settings = trustSettingsOf(trust);
  return {
    showOnMatters: settings.showOnMatters,
    system: settings.system,
    otherName: settings.otherName ?? '',
    staleAfterDays: String(settings.staleAfterDays),
  };
}

/**
 * Settings → Trust account (`/settings/trust`, BILL-11, ADR-035; owners and admins, behind
 * `billing.trustDisplay`). Display only: matters may show a trust balance copied from the firm's
 * own trust records, always labelled "Not the trust ledger". There is nothing here, or anywhere in
 * Materia, to deposit, withdraw or transfer trust money. Saved through `trust-updateSettings`.
 */
@Component({
  selector: 'mt-trust-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtBadge, MtButton, MtNote, MtSelect, MtSettingsRow, MtSettingsSection, MtSwitch, MtTextField],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  template: `
    <div class="mt-row head">
      <div class="mt-col mt-grow" style="gap: 6px">
        <h1 class="title-l" style="margin: 0">Trust account</h1>
        <p style="margin: 0; color: var(--text-secondary)">
          Trust money is receipted, paid and reconciled in your own trust records, which your external examiner checks
          each year. Materia can show a balance you copy from them on each matter, and nothing more.
        </p>
      </div>
      <mt-badge>Owners and admins</mt-badge>
    </div>

    <mt-note data-testid="trust-explainer">{{ explainer }}</mt-note>

    @switch (org.status()) {
      @case ('loading') {
        <p role="status" style="margin: 0; color: var(--text-tertiary)">Loading settings…</p>
      }
      @case ('error') {
        <mt-note tone="danger">{{ loadError() }}</mt-note>
      }
    }

    <form class="mt-col" style="gap: 24px" (submit)="$event.preventDefault(); save()">
      <mt-settings-section
        title="Trust balances on matters"
        description="Off until you turn it on. People with billing access then see the balance on each matter, and Clerk quotes its as-at date."
        [headingLevel]="2"
      >
        <mt-settings-row
          title="Show trust balances on matters"
          description="Nothing is shown on invoices, client exports or emails."
        >
          <mt-switch
            name="showOnMatters"
            label="Show trust balances on matters"
            labelHidden
            [ngModel]="form().showOnMatters"
            (ngModelChange)="set({ showOnMatters: !!$event })"
          />
        </mt-settings-row>
        <div class="pair">
          <mt-select
            name="system"
            label="Your trust records are kept in"
            description="Named on every balance, as “from …”."
            [native]="true"
            [options]="systems"
            [ngModel]="form().system"
            (ngModelChange)="set({ system: $event ?? 'other' })"
          />
          @if (form().system === 'other') {
            <mt-text-field
              name="otherName"
              label="Name of your trust records"
              placeholder="In-house trust records"
              autocomplete="off"
              [error]="otherNameProblem() ?? undefined"
              [ngModel]="form().otherName"
              (ngModelChange)="set({ otherName: $event ?? '' })"
            />
          }
        </div>
        <mt-text-field
          name="staleAfterDays"
          label="Mark a balance out of date after"
          description="Older balances get an amber Out of date chip until someone updates them."
          suffix="days"
          inputmode="numeric"
          class="days"
          [error]="daysProblem() ?? undefined"
          [ngModel]="form().staleAfterDays"
          (ngModelChange)="set({ staleAfterDays: $event ?? '' })"
        />
      </mt-settings-section>

      <div class="mt-row" style="gap: 8px">
        <button mtButton variant="primary" type="submit" [loading]="saving()" [disabled]="!ready()">Save</button>
        <button mtButton variant="ghost" type="button" [disabled]="!unsaved()" (click)="reset()">
          Discard changes
        </button>
      </div>
    </form>

    <p class="caption t-3" style="margin: 0">
      There are no deposit, withdraw or transfer actions anywhere in Materia. Turning balances off keeps them, hidden.
    </p>
  `,
  styles: `
    .head {
      align-items: flex-start;
      gap: var(--space-16, 16px);
    }
    .pair {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: var(--space-12, 12px);
      align-items: start;
    }
    .days {
      max-width: 220px;
    }
    @media (max-width: 599px) {
      .head {
        flex-direction: column;
      }
    }
  `,
})
export class TrustSettingsPage implements HasUnsavedChanges {
  private readonly context = inject(OrgContext);
  private readonly api = trustCallables(inject(CALLABLES));
  private readonly toasts = inject(ToastService);
  protected readonly org = orgTrustSettingsRepository().watch(() => this.context.orgId());

  protected readonly explainer = TRUST_EXPLAINER;
  protected readonly systems: MtOption<TrustRecordsSystem>[] = TRUST_RECORDS_SYSTEMS.map((s) => ({ ...s }));

  protected readonly form = signal<TrustForm>(formOf(undefined));
  private readonly saved = signal<TrustForm | null>(null);
  protected readonly saving = signal(false);

  readonly unsaved = computed(() => {
    const saved = this.saved();
    return !!saved && JSON.stringify(saved) !== JSON.stringify(this.form());
  });
  private readonly parsed = computed(() => {
    const f = this.form();
    return TrustSettingsInput.safeParse({
      showOnMatters: f.showOnMatters,
      system: f.system,
      otherName: f.otherName.trim() || undefined,
      staleAfterDays: /^\d+$/.test(f.staleAfterDays.trim()) ? Number(f.staleAfterDays) : Number.NaN,
    });
  });
  private readonly problems = computed(() => {
    const parsed = this.parsed();
    return parsed.success ? {} : Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
  });
  protected readonly otherNameProblem = computed(() => this.problems()['otherName'] ?? null);
  protected readonly daysProblem = computed(() => (this.problems()['staleAfterDays'] ? 'Enter 1 to 365 days' : null));
  protected readonly ready = computed(() => this.unsaved() && this.parsed().success && !this.saving());
  protected readonly loadError = computed(() => {
    const error = this.org.error();
    return error ? errorCopy(error) : 'Couldn’t load the settings.';
  });

  constructor() {
    warnBeforeUnload(this.unsaved);
    effect(() => {
      const org = this.org.value();
      if (!org) return;
      untracked(() => {
        if (this.unsaved()) return;
        const form = formOf(org);
        this.form.set(form);
        this.saved.set(form);
      });
    });
  }

  protected set(patch: Partial<TrustForm>): void {
    this.form.update((form) => ({ ...form, ...patch }));
  }

  protected reset(): void {
    const saved = this.saved();
    if (saved) this.form.set(saved);
  }

  protected async save(): Promise<void> {
    const parsed = this.parsed();
    if (!this.ready() || !parsed.success) return;
    this.saving.set(true);
    try {
      await this.api.updateSettings({ settings: parsed.data });
      const saved = { ...this.form(), otherName: parsed.data.otherName ?? '' };
      this.form.set(saved);
      this.saved.set(saved);
      this.toasts.show({ title: 'Trust settings saved', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'The settings didn’t save', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.saving.set(false);
    }
  }
}
