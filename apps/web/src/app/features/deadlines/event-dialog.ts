import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { EventKindSchema, type DateOnly, type EventKind } from '@materia/domain';
import { injectDialogRef, MtButton, MtDialog, MtSelect, MtTextField, type MtOption } from '@materia/ui';

import { eventKindLabel } from '../matter-detail/matter-view';
import { formatDueInput, parseDueInput } from '../tasks/task-view';

export interface EventDialogData {
  /** The event being edited; a new one otherwise. */
  event?: { kind: EventKind; date: string; label?: string | undefined } | undefined;
  /** The kind a new event starts as. */
  kind?: EventKind | undefined;
  today: DateOnly;
}

export interface EventDialogResult {
  kind: EventKind;
  date: DateOnly;
  label?: string;
}

/**
 * Records or edits a matter event (CORE-10): its kind, date and an optional label. Saving
 * recomputes the matter's deadlines; dates in force never move silently (proposals).
 */
@Component({
  selector: 'mt-event-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtSelect, MtTextField],
  template: `
    <mt-dialog
      size="sm"
      [title]="data.event ? 'Edit the event' : 'Record an event'"
      description="Deadlines computed from this event are worked out again. Dates already in force aren’t moved without your say."
    >
      <form id="mt-event-form" class="mt-col form" (submit)="$event.preventDefault(); save()">
        <mt-select
          name="kind"
          label="Event"
          [native]="true"
          [options]="kinds"
          [ngModel]="kind()"
          (ngModelChange)="kind.set($event ?? 'custom')"
        />
        <mt-text-field
          name="date"
          label="Date"
          placeholder="DD/MM/YYYY"
          [error]="dateError() ?? undefined"
          [ngModel]="date()"
          (ngModelChange)="date.set($event ?? ''); dateError.set(null)"
        />
        <mt-text-field
          name="label"
          label="Label"
          [optional]="true"
          [ngModel]="label()"
          (ngModelChange)="label.set($event ?? '')"
        />
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-event-form">
          {{ data.event ? 'Save event' : 'Record event' }}
        </button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .form {
      gap: var(--space-12);
    }
  `,
})
export class EventDialog {
  protected readonly ref = injectDialogRef<EventDialogData, EventDialogResult | undefined>();
  protected readonly data = this.ref.data;
  protected readonly kinds: MtOption<EventKind>[] = EventKindSchema.options.map((kind) => ({
    value: kind,
    label: eventKindLabel(kind),
  }));
  protected readonly kind = signal<EventKind>(this.data.event?.kind ?? this.data.kind ?? 'date_of_death');
  protected readonly date = signal(formatDueInput((this.data.event?.date as DateOnly | undefined) ?? null));
  protected readonly dateError = signal<string | null>(null);
  protected readonly label = signal(this.data.event?.label ?? '');

  protected save(): void {
    const date = parseDueInput(this.date());
    if (!date) {
      this.dateError.set('Enter a date like 14/10/2026.');
      return;
    }
    if (this.kind() === 'date_of_death' && date > this.data.today) {
      this.dateError.set('A date of death can’t be after today.');
      return;
    }
    const label = this.label().trim();
    void this.ref.close({ kind: this.kind(), date, ...(label ? { label } : {}) });
  }
}
