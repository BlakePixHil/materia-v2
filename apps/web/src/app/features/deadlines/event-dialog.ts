import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can } from '@materia/data-access';
import { matterDocumentRepository, matterDocumentsQuery } from '@materia/data-access/repository';
import { EventKindSchema, type DateOnly, type EventKind } from '@materia/domain';
import { injectDialogRef, MtButton, MtDialog, MtSelect, MtTextField, type MtOption } from '@materia/ui';

import { eventKindLabel } from './deadline-view';
import { formatDueInput, parseDueInput } from '../tasks/task-view';

export interface EventDialogData {
  /** The event being edited; a new one otherwise. */
  event?:
    | {
        kind: EventKind;
        date: string;
        time?: string | undefined;
        label?: string | undefined;
        sourceDocumentId?: string | undefined;
      }
    | undefined;
  /** The kind a new event starts as. */
  kind?: EventKind | undefined;
  today: DateOnly;
  /** The matter whose documents the source picker lists. */
  matterId?: string | undefined;
}

export interface EventDialogResult {
  kind: EventKind;
  date: DateOnly;
  /** `HH:MM`, 24-hour. */
  time?: string;
  label?: string;
  sourceDocumentId?: string;
}

/** The source picker's "no document" value. */
const NO_SOURCE = '';

/** "9:30" or "09:30" as `09:30` (24-hour, as `deadlines-upsertEvent` takes it); null when it isn't a time. */
export function parseEventTime(text: string): string | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  return match ? `${(match[1] ?? '').padStart(2, '0')}:${match[2] ?? ''}` : null;
}

/** Documents as options, numbering repeated names ("Death certificate.pdf (2)") so each reads apart. */
function documentOptions(documents: readonly { id: string; name: string }[]): MtOption<string>[] {
  const seen = new Map<string, number>();
  return documents.map((doc) => {
    const count = (seen.get(doc.name) ?? 0) + 1;
    seen.set(doc.name, count);
    return { value: doc.id, label: count > 1 ? `${doc.name} (${count})` : doc.name };
  });
}

/**
 * Records or edits a matter event (CORE-10): its kind, date and an optional time, label and source
 * document (the matter's live documents; privileged ones only for privileged.view). Saving
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
        <div class="mt-row pair">
          <mt-text-field
            class="mt-grow"
            name="date"
            label="Date"
            placeholder="DD/MM/YYYY"
            [error]="dateError() ?? undefined"
            [ngModel]="date()"
            (ngModelChange)="date.set($event ?? ''); dateError.set(null)"
          />
          <mt-text-field
            class="mt-grow"
            name="time"
            label="Time"
            placeholder="14:30"
            [optional]="true"
            [error]="timeError() ?? undefined"
            [ngModel]="time()"
            (ngModelChange)="time.set($event ?? ''); timeError.set(null)"
          />
        </div>
        <mt-text-field
          name="label"
          label="Label"
          [optional]="true"
          [ngModel]="label()"
          (ngModelChange)="label.set($event ?? '')"
        />
        @if (data.matterId) {
          <mt-select
            name="source"
            label="Source document"
            description="The document this event comes from, such as the death certificate or the grant."
            [optional]="true"
            [native]="true"
            [options]="sources()"
            [ngModel]="source()"
            (ngModelChange)="source.set($event ?? noSource)"
          />
        }
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
    .pair {
      gap: var(--space-8);
      align-items: flex-start;
    }
  `,
})
export class EventDialog {
  protected readonly ref = injectDialogRef<EventDialogData, EventDialogResult | undefined>();
  protected readonly data = this.ref.data;
  protected readonly noSource = NO_SOURCE;
  protected readonly kinds: MtOption<EventKind>[] = EventKindSchema.options.map((kind) => ({
    value: kind,
    label: eventKindLabel(kind),
  }));
  protected readonly kind = signal<EventKind>(this.data.event?.kind ?? this.data.kind ?? 'date_of_death');
  protected readonly date = signal(formatDueInput((this.data.event?.date as DateOnly | undefined) ?? null));
  protected readonly dateError = signal<string | null>(null);
  protected readonly time = signal(this.data.event?.time ?? '');
  protected readonly timeError = signal<string | null>(null);
  protected readonly label = signal(this.data.event?.label ?? '');
  protected readonly source = signal(this.data.event?.sourceDocumentId ?? NO_SOURCE);

  /** The matter's live documents, newest first, as the Documents tab lists them. */
  private readonly privilegedVisible = can('privileged.view');
  private readonly documents = matterDocumentRepository(() => this.data.matterId ?? null).watchQuery(() =>
    this.data.matterId ? matterDocumentsQuery({ privilegedVisible: this.privilegedVisible() }) : null,
  );
  protected readonly sources = computed<MtOption<string>[]>(() => {
    const documents = this.documents.value().filter((doc) => !doc.deletedAt);
    const options = [{ value: NO_SOURCE, label: 'None' }, ...documentOptions(documents)];
    // A linked document the list doesn't show (removed, or privileged for this role) stays linked.
    const linked = this.data.event?.sourceDocumentId;
    if (linked && !documents.some((doc) => doc.id === linked)) {
      options.push({ value: linked, label: 'The document already linked' });
    }
    return options;
  });

  protected save(): void {
    const date = parseDueInput(this.date());
    const timeText = this.time().trim();
    const time = timeText ? parseEventTime(timeText) : null;
    const dateError = !date
      ? 'Enter a date like 14/10/2026.'
      : this.kind() === 'date_of_death' && date > this.data.today
        ? 'A date of death can’t be after today.'
        : null;
    const timeError = timeText && !time ? 'Enter a time like 14:30.' : null;
    this.dateError.set(dateError);
    this.timeError.set(timeError);
    if (!date || dateError || timeError) return;
    const label = this.label().trim();
    const source = this.source();
    void this.ref.close({
      kind: this.kind(),
      date,
      ...(time ? { time } : {}),
      ...(label ? { label } : {}),
      ...(source ? { sourceDocumentId: source } : {}),
    });
  }
}
