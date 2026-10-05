import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { NewManualDeadlineFields } from '@materia/data-access/repository';
import { MANUAL_DEADLINE_KINDS, type DateOnly, type ManualDeadlineKind } from '@materia/domain';
import { injectDialogRef, MtButton, MtCheckbox, MtDialog, MtSelect, MtTextField, type MtOption } from '@materia/ui';

import { deadlineKindLabel } from './deadline-view';
import { formatDueInput, parseDueInput } from '../tasks/task-view';

export interface ManualDeadlineDialogData {
  /** The deadline being edited; a new one otherwise. */
  deadline?:
    | {
        title: string;
        dueDate?: string | undefined;
        dueTime?: string | undefined;
        kind: string;
        critical: boolean;
        assigneeUid?: string | undefined;
      }
    | undefined;
  /** Who it can be assigned to. */
  people: readonly { uid: string; name: string }[];
  /** The default assignee (the matter's responsible lawyer). */
  assigneeUid: string;
}

export type ManualDeadlineDialogResult = Required<
  Pick<NewManualDeadlineFields, 'title' | 'dueDate' | 'kind' | 'critical' | 'assigneeUid'>
> &
  Pick<NewManualDeadlineFields, 'dueTime'>;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Adds or edits a manual deadline (CORE-10): contractual, internal or court, with no rule behind
 * it. It's saved directly (the rules check it) and edited the same way while it's upcoming.
 */
@Component({
  selector: 'mt-manual-deadline-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtCheckbox, MtDialog, MtSelect, MtTextField],
  template: `
    <mt-dialog size="sm" [title]="data.deadline ? 'Edit the deadline' : 'Add a deadline'">
      <form id="mt-manual-deadline-form" class="mt-col form" (submit)="$event.preventDefault(); save()">
        <mt-text-field
          name="title"
          label="Title"
          [error]="titleError() ?? undefined"
          [ngModel]="title()"
          (ngModelChange)="title.set($event ?? ''); titleError.set(null)"
        />
        <div class="mt-row pair">
          <mt-text-field
            class="mt-grow"
            name="dueDate"
            label="Due date"
            placeholder="DD/MM/YYYY"
            [error]="dateError() ?? undefined"
            [ngModel]="date()"
            (ngModelChange)="date.set($event ?? ''); dateError.set(null)"
          />
          <mt-text-field
            class="mt-grow"
            name="dueTime"
            label="By"
            placeholder="16:00"
            [optional]="true"
            [error]="timeError() ?? undefined"
            [ngModel]="time()"
            (ngModelChange)="time.set($event ?? ''); timeError.set(null)"
          />
        </div>
        <mt-select
          name="kind"
          label="Kind"
          [native]="true"
          [options]="kinds"
          [ngModel]="kind()"
          (ngModelChange)="kind.set($event ?? 'internal')"
        />
        <mt-select
          name="assignee"
          label="Responsible"
          [native]="true"
          [options]="people"
          [ngModel]="assignee()"
          (ngModelChange)="assignee.set($event ?? data.assigneeUid)"
        />
        <mt-checkbox
          name="critical"
          label="Critical"
          description="Flagged everywhere it’s listed, and changes to it need the matter number typed"
          [ngModel]="critical()"
          (ngModelChange)="critical.set(!!$event)"
        />
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-manual-deadline-form">
          {{ data.deadline ? 'Save deadline' : 'Add deadline' }}
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
export class ManualDeadlineDialog {
  protected readonly ref = injectDialogRef<ManualDeadlineDialogData, ManualDeadlineDialogResult | undefined>();
  protected readonly data = this.ref.data;
  private readonly current = this.data.deadline;
  protected readonly kinds: MtOption<ManualDeadlineKind>[] = MANUAL_DEADLINE_KINDS.map((kind) => ({
    value: kind,
    label: deadlineKindLabel(kind),
  }));
  protected readonly people: MtOption[] = this.data.people.map((person) => ({ value: person.uid, label: person.name }));

  protected readonly title = signal(this.current?.title ?? '');
  protected readonly titleError = signal<string | null>(null);
  protected readonly date = signal(formatDueInput((this.current?.dueDate as DateOnly | undefined) ?? null));
  protected readonly dateError = signal<string | null>(null);
  protected readonly time = signal(this.current?.dueTime ?? '');
  protected readonly timeError = signal<string | null>(null);
  protected readonly kind = signal<ManualDeadlineKind>(
    (MANUAL_DEADLINE_KINDS as readonly string[]).includes(this.current?.kind ?? '')
      ? (this.current?.kind as ManualDeadlineKind)
      : 'internal',
  );
  protected readonly assignee = signal(this.current?.assigneeUid ?? this.data.assigneeUid);
  protected readonly critical = signal(this.current?.critical ?? false);

  protected save(): void {
    const title = this.title().trim();
    const dueDate = parseDueInput(this.date());
    const time = this.time().trim();
    if (!title) this.titleError.set('Give the deadline a title.');
    if (!dueDate) this.dateError.set('Enter a date like 14/10/2026.');
    if (time && !TIME.test(time)) this.timeError.set('Enter a time like 16:00.');
    if (!title || !dueDate || (time && !TIME.test(time))) return;
    void this.ref.close({
      title,
      dueDate,
      kind: this.kind(),
      critical: this.critical(),
      assigneeUid: this.assignee(),
      ...(time ? { dueTime: time } : {}),
    });
  }
}
