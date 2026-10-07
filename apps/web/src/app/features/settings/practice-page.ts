import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { OrgContext } from '@materia/data-access';
import { orgSettingsReadRepository, type OrgSettings } from '@materia/data-access/repository';
import {
  abnProblem,
  DEFAULT_ORG_TIMEZONE,
  formatAbn,
  HOLIDAY_LOCALITIES,
  JurisdictionSchema,
  MIN_RETENTION_YEARS,
  PracticeSettingsInput,
  timeZoneOptions,
  type Jurisdiction,
  type OrgSettingsImpact,
} from '@materia/domain';
import {
  DialogService,
  MtButton,
  MtCheckbox,
  MtNote,
  type MtOption,
  MtSelect,
  MtSettingsRow,
  MtSettingsSection,
  MtSkeleton,
  MtTextField,
  ToastService,
} from '@materia/ui';

import { SettingsApi } from './settings-api';
import { warnBeforeUnload, type HasUnsavedChanges } from './unsaved-changes';
import { errorCopy } from '../../core/error-copy';

const JURISDICTIONS = JurisdictionSchema.options;

interface PracticeForm {
  name: string;
  abn: string;
  primaryJurisdiction: Jurisdiction;
  jurisdictions: Jurisdiction[];
  timezone: string;
  holidayLocality: string;
  retentionYears: string;
}

function formOf(org: OrgSettings | undefined): PracticeForm {
  const primary = org?.primaryJurisdiction ?? 'VIC';
  return {
    name: org?.name ?? '',
    abn: org?.abn ? formatAbn(org.abn) : '',
    primaryJurisdiction: primary,
    jurisdictions: org?.jurisdictions?.length ? [...org.jurisdictions] : [primary],
    timezone: org?.timezone || DEFAULT_ORG_TIMEZONE,
    // Orgs created before the locality list (FND-17 stored the jurisdiction, `VIC`) start on Melbourne,
    // so the form is valid and Save works.
    holidayLocality: HOLIDAY_LOCALITIES.some((l) => l.value === org?.holidayLocality)
      ? (org?.holidayLocality ?? 'VIC_MELBOURNE')
      : 'VIC_MELBOURNE',
    retentionYears: String(org?.retentionYears ?? MIN_RETENTION_YEARS),
  };
}

const sameForm = (a: PracticeForm, b: PracticeForm) =>
  JSON.stringify({ ...a, jurisdictions: [...a.jurisdictions].sort() }) ===
  JSON.stringify({ ...b, jurisdictions: [...b.jurisdictions].sort() });

/**
 * Settings → Practice (`/settings/practice`, CORE-21; owners and admins): the firm's name and ABN
 * (checked with the ATO checksum), jurisdictions, time zone, holiday locality and record retention.
 * Saved through `orgs-updateSettings`: a time zone or locality change first says how many reminders
 * move, and removing a jurisdiction that open matters use is refused with those matters listed.
 */
@Component({
  selector: 'mt-practice-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    MtButton,
    MtCheckbox,
    MtNote,
    MtSelect,
    MtSettingsRow,
    MtSettingsSection,
    MtSkeleton,
    MtTextField,
  ],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  template: `
    <div class="mt-col" style="gap: 6px">
      <h1 class="title-l" style="margin: 0">Practice</h1>
      <p style="margin: 0; color: var(--text-secondary)">
        Your firm’s details. They apply to everyone in the practice.
      </p>
    </div>

    @switch (org.status()) {
      @case ('loading') {
        <mt-skeleton variant="fields" framed label="Loading settings…" [count]="4" />
      }
      @case ('error') {
        <mt-note tone="danger">{{ loadError() }}</mt-note>
      }
    }

    @if (blocked().length) {
      <mt-note tone="danger" data-blocked>
        <span>
          Open matters use {{ blockedJurisdictions() }}, so it can’t be removed yet. Close or move them first:
          @for (matter of blocked(); track matter.matterId; let last = $last) {
            <a [routerLink]="['/matters', matter.matterId]">{{ matter.number }}</a
            >{{ last ? '.' : ', ' }}
          }
        </span>
      </mt-note>
    }

    <!-- Shown once the org has loaded, so nothing typed is overwritten when the settings arrive. -->
    @if (org.value()) {
      <form class="mt-col mt-fade" style="gap: 24px" (submit)="$event.preventDefault(); save()">
        <mt-settings-section title="Firm details" [headingLevel]="2">
          <mt-text-field
            name="name"
            label="Practice name"
            autocomplete="organization"
            [error]="nameProblem() ?? undefined"
            [ngModel]="form().name"
            (ngModelChange)="set({ name: $event ?? '' })"
          />
          <mt-text-field
            name="abn"
            label="ABN"
            inputmode="numeric"
            autocomplete="off"
            description="11 digits, checked against the ATO’s checksum."
            optional
            [error]="abnError() ?? undefined"
            [ngModel]="form().abn"
            (ngModelChange)="set({ abn: $event ?? '' })"
            (focusout)="tidyAbn()"
          />
        </mt-settings-section>

        <mt-settings-section
          title="Jurisdictions"
          description="Where the practice works. New matters default to the primary jurisdiction."
          [headingLevel]="2"
        >
          <mt-select
            name="primaryJurisdiction"
            label="Primary jurisdiction"
            [native]="true"
            [options]="jurisdictionOptions"
            [ngModel]="form().primaryJurisdiction"
            (ngModelChange)="setPrimary($event)"
          />
          <fieldset class="jurisdictions">
            <legend class="label">Also works in</legend>
            @for (code of jurisdictions; track code) {
              <mt-checkbox
                [name]="'j-' + code"
                [label]="code"
                [disabled]="code === form().primaryJurisdiction"
                [ngModel]="form().jurisdictions.includes(code)"
                (ngModelChange)="toggle(code, $event)"
              />
            }
          </fieldset>
        </mt-settings-section>

        <mt-settings-section
          title="Time and holidays"
          description="Legal dates and reminders follow the practice’s time zone."
          [headingLevel]="2"
        >
          <mt-select
            name="timezone"
            label="Time zone"
            [native]="true"
            [options]="timeZones"
            [ngModel]="form().timezone"
            (ngModelChange)="set({ timezone: $event ?? form().timezone })"
          />
          <mt-select
            name="holidayLocality"
            label="Holiday locality"
            description="Local public holidays move reminders, not court deadlines. Greater Geelong has Geelong Cup Day instead of Melbourne Cup Day."
            [native]="true"
            [options]="localities"
            [ngModel]="form().holidayLocality"
            (ngModelChange)="set({ holidayLocality: $event ?? form().holidayLocality })"
          />
        </mt-settings-section>

        <mt-settings-section title="Records" [headingLevel]="2">
          <mt-text-field
            name="retentionYears"
            label="Keep records for"
            suffix="years"
            inputmode="numeric"
            [description]="retentionNote"
            [error]="retentionProblem() ?? undefined"
            [ngModel]="form().retentionYears"
            (ngModelChange)="set({ retentionYears: $event ?? '' })"
          />
          <mt-settings-row title="Matter numbering" description="The format new matter numbers follow.">
            <a mtButton size="sm" routerLink="/settings/numbering">Edit numbering</a>
          </mt-settings-row>
        </mt-settings-section>

        <div class="mt-row" style="gap: 8px">
          <button mtButton variant="primary" type="submit" [loading]="saving()" [disabled]="!ready()">Save</button>
          <button mtButton variant="ghost" type="button" [disabled]="!unsaved()" (click)="reset()">
            Discard changes
          </button>
        </div>
      </form>
    }
  `,
  styles: `
    .jurisdictions {
      border: 0;
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-12, 12px) var(--space-20, 20px);
    }
    /* Floated, the legend is an ordinary flex item on its own line rather than drawn into the
       fieldset's top edge, so it sits the same distance under the field above as any label. */
    .jurisdictions legend {
      float: left;
      width: 100%;
      padding: 0;
    }
  `,
})
export class PracticeSettingsPage implements HasUnsavedChanges {
  private readonly context = inject(OrgContext);
  private readonly api = inject(SettingsApi);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  protected readonly org = orgSettingsReadRepository().watch(() => this.context.orgId());

  protected readonly jurisdictions = JURISDICTIONS;
  protected readonly jurisdictionOptions: MtOption<Jurisdiction>[] = JURISDICTIONS.map((j) => ({ value: j, label: j }));
  protected readonly timeZones: MtOption<string>[] = timeZoneOptions().map((zone) => ({
    value: zone,
    label: zone.replace(/_/g, ' '),
  }));
  protected readonly localities: MtOption<string>[] = HOLIDAY_LOCALITIES.map((l) => ({
    value: l.value,
    label: l.label,
  }));
  protected readonly retentionNote = `At least ${MIN_RETENTION_YEARS} years after a matter closes. Check your obligations with your practitioner before shortening it.`;

  protected readonly form = signal<PracticeForm>(formOf(undefined));
  private readonly saved = signal<PracticeForm | null>(null);
  protected readonly saving = signal(false);
  protected readonly blocked = signal<OrgSettingsImpact['jurisdictionInUse']>([]);

  readonly unsaved = computed(() => {
    const saved = this.saved();
    return !!saved && !sameForm(saved, this.form());
  });
  protected readonly nameProblem = computed(() => (this.form().name.trim() ? null : 'Enter the practice’s name.'));
  protected readonly abnError = computed(() => abnProblem(this.form().abn));
  protected readonly retentionProblem = computed(() => {
    const years = Number(this.form().retentionYears);
    if (!Number.isInteger(years)) return 'Enter a whole number of years.';
    if (years < MIN_RETENTION_YEARS) return `At least ${MIN_RETENTION_YEARS} years.`;
    if (years > 100) return 'At most 100 years.';
    return null;
  });
  private readonly input = computed(() => {
    const f = this.form();
    return PracticeSettingsInput.safeParse({ ...f, retentionYears: Number(f.retentionYears) });
  });
  protected readonly ready = computed(() => this.unsaved() && this.input().success && !this.saving());
  protected readonly blockedJurisdictions = computed(() =>
    [...new Set(this.blocked().map((m) => m.jurisdiction))].join(' and '),
  );
  protected readonly loadError = computed(() => {
    const error = this.org.error();
    return error ? errorCopy(error) : 'Couldn’t load the settings.';
  });

  constructor() {
    warnBeforeUnload(this.unsaved);
    // Fill the form when the settings load (and after a save), not while editing.
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

  protected set(patch: Partial<PracticeForm>): void {
    this.form.update((form) => ({ ...form, ...patch }));
  }

  protected setPrimary(code: Jurisdiction | null): void {
    if (!code) return;
    this.form.update((form) => ({
      ...form,
      primaryJurisdiction: code,
      jurisdictions: form.jurisdictions.includes(code) ? form.jurisdictions : [...form.jurisdictions, code],
    }));
  }

  protected toggle(code: Jurisdiction, on: boolean | null): void {
    this.form.update((form) => ({
      ...form,
      jurisdictions: on
        ? [...new Set([...form.jurisdictions, code])]
        : form.jurisdictions.filter((j) => j !== code || j === form.primaryJurisdiction),
    }));
  }

  protected tidyAbn(): void {
    if (!this.abnError()) this.set({ abn: formatAbn(this.form().abn) });
  }

  protected reset(): void {
    const saved = this.saved();
    if (saved) this.form.set(saved);
    this.blocked.set([]);
  }

  protected async save(): Promise<void> {
    const parsed = this.input();
    if (!this.ready() || !parsed.success) return;
    const practice = parsed.data;
    const saved = this.saved();
    this.saving.set(true);
    this.blocked.set([]);
    try {
      const removesJurisdiction = !!saved?.jurisdictions.some((j) => !practice.jurisdictions.includes(j));
      const movesCalendar =
        saved?.timezone !== practice.timezone || saved?.holidayLocality !== practice.holidayLocality;
      if (removesJurisdiction || movesCalendar) {
        const { impact } = await this.api.updateSettings({ practice, dryRun: true });
        if (impact.jurisdictionInUse.length) {
          this.blocked.set(impact.jurisdictionInUse);
          return;
        }
        if (impact.remindersRescheduled > 0) {
          const n = impact.remindersRescheduled;
          const ok = await this.dialogs.confirm({
            title: 'Reschedule reminders?',
            body: `${n} deadline ${n === 1 ? 'reminder' : 'reminders'} will be rescheduled for the new ${
              saved?.timezone !== practice.timezone ? 'time zone' : 'holiday locality'
            }. Deadlines themselves don’t change.`,
            confirmLabel: 'Save and reschedule',
          });
          if (!ok) return;
        }
      }
      await this.api.updateSettings({ practice });
      this.saved.set(this.form());
      this.toasts.show({ title: 'Practice settings saved', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'The settings didn’t save', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.saving.set(false);
    }
  }
}
