import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  formatUnits,
  planWriteDown,
  REJECTION_NOTE_MAX,
  WRITE_DOWN_PROBLEM_COPY,
  WRITE_DOWN_REASON_MAX,
  type WriteDownChange,
} from '@materia/domain';
import {
  formatAud,
  injectDialogRef,
  MtButton,
  MtDialog,
  MtNote,
  MtSegmentedControl,
  MtTextarea,
  MtTextField,
  type MtOption,
} from '@materia/ui';

/** The entries a write-down covers, as the dialog previews them. */
export interface WriteDownDialogData {
  entries: { status: string; units: number; amountCents: number; rateCents: number }[];
  unitMinutes: number;
}

export type WriteDownDialogResult = WriteDownChange & { reason: string };

type Mode = 'units' | 'percent' | 'writeOff';

/**
 * Writes time down or off (BILL-03): to a number of units (one entry), by a percentage, or a
 * write-off, with a reason the entry keeps. Previews the new value. Closes with the change and
 * reason for `time-writeDown`, or `undefined` when cancelled.
 */
@Component({
  selector: 'mt-write-down-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtNote, MtSegmentedControl, MtTextarea, MtTextField],
  template: `
    <mt-dialog size="sm" [title]="title" [description]="description">
      <form
        id="mt-write-down-form"
        class="mt-col"
        style="gap: var(--space-12)"
        (submit)="$event.preventDefault(); save()"
      >
        <mt-segmented-control
          label="How"
          name="mode"
          [options]="modes"
          [ngModel]="mode()"
          (ngModelChange)="mode.set($event)"
        />
        @if (mode() === 'units') {
          <mt-text-field
            name="units"
            label="New units"
            [description]="'Now ' + unitsText(single()?.units ?? 0) + ' (' + (single()?.units ?? 0) + ' units)'"
            inputmode="numeric"
            [error]="amountError() ?? undefined"
            [ngModel]="units()"
            (ngModelChange)="units.set($event ?? '')"
          />
        } @else if (mode() === 'percent') {
          <mt-text-field
            name="percent"
            label="Write down by"
            suffix="%"
            inputmode="numeric"
            [error]="amountError() ?? undefined"
            [ngModel]="percent()"
            (ngModelChange)="percent.set($event ?? '')"
          />
        }
        <mt-textarea
          name="reason"
          label="Reason"
          [maxLength]="reasonMax"
          [rows]="2"
          [error]="reasonError() ?? undefined"
          [ngModel]="reason()"
          (ngModelChange)="reason.set($event ?? ''); touched.set(true)"
        />
        @if (preview(); as text) {
          <mt-note [tone]="mode() === 'writeOff' ? 'warning' : 'info'" data-testid="write-down-preview">{{
            text
          }}</mt-note>
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close(undefined)">Cancel</button>
        <button
          mtButton
          type="submit"
          form="mt-write-down-form"
          [variant]="mode() === 'writeOff' ? 'danger' : 'primary'"
          [disabled]="!result()"
        >
          {{ mode() === 'writeOff' ? 'Write off' : 'Write down' }}
        </button>
      </ng-container>
    </mt-dialog>
  `,
})
export class WriteDownDialog {
  protected readonly ref = injectDialogRef<WriteDownDialogData, WriteDownDialogResult | undefined>();
  private readonly data = this.ref.data;
  protected readonly reasonMax = WRITE_DOWN_REASON_MAX;
  private readonly count = this.data.entries.length;
  protected readonly title = this.count === 1 ? 'Write down this entry' : `Write down ${this.count} entries`;
  protected readonly description =
    'A write-down approves the time at the lower value; a write-off takes it out of WIP. The original value and your reason are kept.';
  protected readonly modes: MtOption<Mode>[] = [
    ...(this.count === 1 ? [{ value: 'units' as const, label: 'New units' }] : []),
    { value: 'percent', label: 'Percentage' },
    { value: 'writeOff', label: 'Write off' },
  ];
  protected readonly mode = signal<Mode>(this.count === 1 ? 'units' : 'percent');
  protected readonly units = signal(this.count === 1 ? String(this.data.entries[0]?.units ?? '') : '');
  protected readonly percent = signal('');
  protected readonly reason = signal('');
  protected readonly touched = signal(false);
  protected readonly single = computed(() => (this.count === 1 ? this.data.entries[0] : undefined));

  private readonly change = computed((): WriteDownChange | null => {
    const mode = this.mode();
    if (mode === 'writeOff') return { writeOff: true };
    const text = (mode === 'units' ? this.units() : this.percent()).trim();
    const value = Number(text);
    if (!text || !Number.isInteger(value)) return null;
    if (mode === 'units') return value >= 0 ? { newUnits: value } : null;
    return value >= 1 && value <= 100 ? { percent: value } : null;
  });

  /** Each entry's plan, or the first problem. */
  private readonly plans = computed(() => {
    const change = this.change();
    if (!change) return null;
    return this.data.entries.map((entry) =>
      planWriteDown(entry, change, { by: 'me', reason: 'preview', unitMinutes: this.data.unitMinutes }),
    );
  });

  protected readonly amountError = computed(() => {
    const mode = this.mode();
    const text = (mode === 'units' ? this.units() : this.percent()).trim();
    if (!text) return null;
    if (!this.change()) return mode === 'units' ? 'Enter a whole number of units.' : 'Enter 1 to 100.';
    const problem = this.plans()?.find((plan) => plan.problem)?.problem;
    return problem ? `${WRITE_DOWN_PROBLEM_COPY[problem]}.` : null;
  });

  protected readonly reasonError = computed(() =>
    this.touched() && !this.reason().trim() ? 'Say why, for the record.' : null,
  );

  protected readonly preview = computed(() => {
    const plans = this.plans();
    if (!plans || plans.some((plan) => !plan.plan)) return null;
    const before = this.data.entries.reduce((sum, entry) => sum + entry.amountCents, 0);
    if (this.mode() === 'writeOff') return `${formatAud(before)} comes out of WIP.`;
    const after = plans.reduce((sum, plan) => sum + (plan.plan?.amountCents ?? 0), 0);
    return `${formatAud(before)} becomes ${formatAud(after)}.`;
  });

  protected readonly result = computed((): WriteDownDialogResult | null => {
    const change = this.change();
    const reason = this.reason().trim();
    if (!change || !reason || this.amountError()) return null;
    return { ...change, reason };
  });

  protected unitsText(units: number): string {
    return `${formatUnits(units, this.data.unitMinutes)} h`;
  }

  protected save(): void {
    this.touched.set(true);
    const result = this.result();
    if (result) void this.ref.close(result);
  }
}

/** Who the time goes back to, for the dialog's description. */
export interface SendBackDialogData {
  count: number;
  author: string;
}

/**
 * Sends drafts back to their author with a note (BILL-03, `time-reject`). Closes with the note, or
 * `undefined` when cancelled.
 */
@Component({
  selector: 'mt-send-back-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtTextarea],
  template: `
    <mt-dialog size="sm" [title]="title" [description]="description">
      <form id="mt-send-back-form" (submit)="$event.preventDefault(); save()">
        <mt-textarea
          name="note"
          label="Note"
          placeholder="What needs changing?"
          [maxLength]="noteMax"
          [rows]="3"
          [error]="error() ?? undefined"
          [ngModel]="note()"
          (ngModelChange)="note.set($event ?? ''); error.set(null)"
        />
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close(undefined)">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-send-back-form">Send back</button>
      </ng-container>
    </mt-dialog>
  `,
})
export class SendBackDialog {
  protected readonly ref = injectDialogRef<SendBackDialogData, string | undefined>();
  protected readonly noteMax = REJECTION_NOTE_MAX;
  protected readonly title =
    this.ref.data.count === 1 ? 'Send this entry back' : `Send ${this.ref.data.count} entries back`;
  protected readonly description = `${this.ref.data.author} sees your note on their time and can change the entry. It comes back here once they do.`;
  protected readonly note = signal('');
  protected readonly error = signal<string | null>(null);

  protected save(): void {
    const note = this.note().trim();
    if (!note) {
      this.error.set('Add a note so they know what to change.');
      return;
    }
    void this.ref.close(note);
  }
}
