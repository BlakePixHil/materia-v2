import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { DateOnly } from '@materia/domain';
import { injectDialogRef, MtButton, MtDialog, MtTextField } from '@materia/ui';

import { formatDueInput, parseDueInput } from './task-view';

export interface TaskDueDialogData {
  /** How many tasks change. */
  count: number;
  /** Their shared due date, if they have one. */
  current: DateOnly | null;
}

/** The new due date, or `null` to clear it. */
export interface TaskDueDialogResult {
  dueDate: DateOnly | null;
}

/** Sets or clears the due date of the selected tasks (CORE-08). */
@Component({
  selector: 'mt-task-due-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtTextField],
  template: `
    <mt-dialog size="sm" [title]="title">
      <form id="mt-task-due-form" (submit)="$event.preventDefault(); save()">
        <mt-text-field
          name="due"
          label="Due date"
          placeholder="DD/MM/YYYY"
          [error]="error() ?? undefined"
          [ngModel]="text()"
          (ngModelChange)="text.set($event ?? ''); error.set(null)"
        />
      </form>
      <ng-container mtDialogFooter>
        @if (data.current) {
          <button mtButton variant="ghost" (click)="clear()">Clear due date</button>
        }
        <button mtButton variant="ghost" (click)="close()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-task-due-form">Set due date</button>
      </ng-container>
    </mt-dialog>
  `,
})
export class TaskDueDialog {
  protected readonly ref = injectDialogRef<TaskDueDialogData, TaskDueDialogResult | undefined>();
  protected readonly data = this.ref.data;
  protected readonly title =
    this.data.count === 1 ? 'Change the due date' : `Change the due date of ${this.data.count} tasks`;
  protected readonly text = signal(formatDueInput(this.data.current));
  protected readonly error = signal<string | null>(null);

  protected close(result?: TaskDueDialogResult): void {
    void this.ref.close(result);
  }

  protected clear(): void {
    this.close({ dueDate: null });
  }

  protected save(): void {
    const text = this.text().trim();
    if (!text) {
      this.close({ dueDate: null });
      return;
    }
    const dueDate = parseDueInput(text);
    if (!dueDate) {
      this.error.set('Enter a date like 14/10/2026.');
      return;
    }
    this.close({ dueDate });
  }
}
