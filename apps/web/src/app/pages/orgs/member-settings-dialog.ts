import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { fyLabel, type Cents } from '@materia/domain';
import { injectDialogRef, MtButton, MtDialog, MtSelect, MtTextField, type MtOption } from '@materia/ui';

import { dollarsText, parseDollars } from '../../features/settings/money';

export interface MemberSettingsDialogData {
  displayName: string;
  defaultRateCents: number | null;
  supervisorUid: string | null;
  budgets: Record<string, number>;
  /** Who can supervise: the other current members. */
  supervisors: MtOption<string>[];
  /** The financial years to budget for (this one and the next), as their start years. */
  fyStartYears: number[];
  fyStartMonth: number;
}

export interface MemberSettingsDialogResult {
  defaultRateCents: Cents;
  supervisorUid: string | null;
  budgets: Record<string, Cents>;
}

/**
 * A member's rate, supervisor and budgets (CORE-21), from the team page. The rate applies to new
 * time entries only; budgets are fee targets per financial year (`budgets[fyStartYear]`).
 */
@Component({
  selector: 'mt-member-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtSelect, MtTextField],
  template: `
    <mt-dialog [title]="'Rate and budget for ' + data.displayName">
      <form id="mt-member-settings-form" class="mt-col" style="gap: 16px" (submit)="$event.preventDefault(); save()">
        <mt-text-field
          name="rate"
          label="Hourly rate"
          description="Excluding GST. New time entries use it; recorded entries keep their rate."
          inputmode="decimal"
          suffix="AUD / h"
          [error]="rateProblem() ?? undefined"
          [ngModel]="rate()"
          (ngModelChange)="rate.set($event ?? '')"
        />
        <mt-select
          name="supervisor"
          label="Supervisor"
          description="Gets escalations when this person’s deadlines are missed."
          [native]="true"
          [options]="supervisorOptions"
          [ngModel]="supervisor()"
          (ngModelChange)="supervisor.set($event ?? '')"
        />
        @for (year of data.fyStartYears; track year) {
          <mt-text-field
            [name]="'budget-' + year"
            [label]="'Fee budget ' + fyLabel(year)"
            inputmode="decimal"
            suffix="AUD"
            optional
            [error]="budgetProblems()[year] ?? undefined"
            [ngModel]="budgets()[year] ?? ''"
            (ngModelChange)="setBudget(year, $event ?? '')"
          />
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-member-settings-form" [disabled]="!valid()">
          Save
        </button>
      </ng-container>
    </mt-dialog>
  `,
})
export class MemberSettingsDialog {
  protected readonly ref = injectDialogRef<MemberSettingsDialogData, MemberSettingsDialogResult>();
  protected readonly data = this.ref.data;
  protected readonly supervisorOptions: MtOption<string>[] = [
    { value: '', label: 'No supervisor' },
    ...this.data.supervisors,
  ];

  protected readonly rate = signal(dollarsText(this.data.defaultRateCents ?? 0));
  protected readonly supervisor = signal(this.data.supervisorUid ?? '');
  protected readonly budgets = signal<Record<number, string>>(
    Object.fromEntries(this.data.fyStartYears.map((year) => [year, dollarsText(this.data.budgets[String(year)])])),
  );

  protected readonly rateProblem = computed(() => {
    const value = parseDollars(this.rate());
    return value === undefined || value === null ? 'Enter a rate in dollars.' : null;
  });
  protected readonly budgetProblems = computed(() => {
    const problems: Record<number, string> = {};
    for (const [year, text] of Object.entries(this.budgets())) {
      if (parseDollars(text) === undefined) problems[Number(year)] = 'Enter an amount in dollars.';
    }
    return problems;
  });
  protected readonly valid = computed(() => !this.rateProblem() && !Object.keys(this.budgetProblems()).length);

  protected fyLabel(year: number): string {
    return fyLabel(year, this.data.fyStartMonth);
  }

  protected setBudget(year: number, text: string): void {
    this.budgets.update((budgets) => ({ ...budgets, [year]: text }));
  }

  protected save(): void {
    const rate = parseDollars(this.rate());
    if (!this.valid() || rate === null || rate === undefined) return;
    // Budgets for other years are kept; an emptied one is removed.
    const budgets: Record<string, Cents> = Object.fromEntries(
      Object.entries(this.data.budgets).filter(([year]) => !this.data.fyStartYears.includes(Number(year))),
    ) as Record<string, Cents>;
    for (const [year, text] of Object.entries(this.budgets())) {
      const amount = parseDollars(text);
      if (amount !== null && amount !== undefined) budgets[year] = amount;
    }
    void this.ref.close({ defaultRateCents: rate, supervisorUid: this.supervisor() || null, budgets });
  }
}
