import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { confirmationMatches, DeadlineReasonSchema, type DateOnly, type DeadlineOutcome } from '@materia/domain';
import { formatDateOnly, injectDialogRef, MtButton, MtCheckbox, MtDialog, MtTextarea, MtTextField } from '@materia/ui';

import { formatDueInput, parseDueInput } from '../tasks/task-view';

/** The first problem with a reason, or null. */
function reasonProblem(text: string): string | null {
  const parsed = DeadlineReasonSchema.safeParse(text);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Give a reason');
}

// ---------- closing a deadline ----------

export interface CompleteDeadlineDialogData {
  title: string;
  outcome: DeadlineOutcome;
  today: DateOnly;
  /** The deadline has a task its rule created: offer to close it too. */
  linkedTask: boolean;
}

export interface CompleteDeadlineDialogResult {
  completedOn?: DateOnly;
  reason?: string;
  completeLinkedTasks: boolean;
}

const OUTCOME_COPY: Record<DeadlineOutcome, { title: string; confirm: string; description: string }> = {
  done: {
    title: 'Mark the deadline done',
    confirm: 'Mark done',
    description: 'Record when it was met.',
  },
  waived: {
    title: 'Waive the deadline',
    confirm: 'Waive deadline',
    description: 'It no longer needs to be met. The reason is kept on the matter.',
  },
  missed: {
    title: 'Confirm the deadline was missed',
    confirm: 'Confirm missed',
    description: 'It’s recorded as missed on the matter. Tell the responsible lawyer what happened.',
  },
};

/** Closes a deadline: done (with the date), waived (with a reason) or confirmed missed (CORE-10). */
@Component({
  selector: 'mt-complete-deadline-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtCheckbox, MtDialog, MtTextarea, MtTextField],
  template: `
    <mt-dialog
      size="sm"
      [title]="copy.title"
      [description]="data.title + '. ' + copy.description"
      [role]="data.outcome === 'missed' ? 'alertdialog' : 'dialog'"
    >
      <form id="mt-complete-deadline-form" class="mt-col form" (submit)="$event.preventDefault(); save()">
        @if (data.outcome === 'done') {
          <mt-text-field
            name="completedOn"
            label="Done on"
            placeholder="DD/MM/YYYY"
            [error]="dateError() ?? undefined"
            [ngModel]="date()"
            (ngModelChange)="date.set($event ?? ''); dateError.set(null)"
          />
        } @else {
          <mt-textarea
            name="reason"
            [label]="data.outcome === 'waived' ? 'Why is it waived?' : 'What happened?'"
            [optional]="data.outcome === 'missed'"
            [rows]="3"
            [error]="reasonError() ?? undefined"
            [ngModel]="reason()"
            (ngModelChange)="reason.set($event ?? ''); reasonError.set(null)"
          />
        }
        @if (data.linkedTask) {
          <mt-checkbox
            name="linked"
            label="Also mark its linked task done"
            [ngModel]="linked()"
            (ngModelChange)="linked.set(!!$event)"
          />
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button
          mtButton
          [variant]="data.outcome === 'missed' ? 'danger' : 'primary'"
          type="submit"
          form="mt-complete-deadline-form"
        >
          {{ copy.confirm }}
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
export class CompleteDeadlineDialog {
  protected readonly ref = injectDialogRef<CompleteDeadlineDialogData, CompleteDeadlineDialogResult | undefined>();
  protected readonly data = this.ref.data;
  protected readonly copy = OUTCOME_COPY[this.data.outcome];
  protected readonly date = signal(formatDueInput(this.data.today));
  protected readonly dateError = signal<string | null>(null);
  protected readonly reason = signal('');
  protected readonly reasonError = signal<string | null>(null);
  protected readonly linked = signal(true);

  protected save(): void {
    const completeLinkedTasks = this.data.linkedTask && this.linked();
    if (this.data.outcome === 'done') {
      const completedOn = parseDueInput(this.date());
      if (!completedOn) {
        this.dateError.set('Enter a date like 14/10/2026.');
        return;
      }
      if (completedOn > this.data.today) {
        this.dateError.set('The date it was done can’t be in the future.');
        return;
      }
      void this.ref.close({ completedOn, completeLinkedTasks });
      return;
    }
    const reason = this.reason().trim();
    if (this.data.outcome === 'waived' || reason) {
      const problem = reasonProblem(reason);
      if (problem) {
        this.reasonError.set(problem === 'Give a reason' ? 'Say why it’s waived.' : problem);
        return;
      }
    }
    void this.ref.close({ ...(reason ? { reason } : {}), completeLinkedTasks });
  }
}

// ---------- overriding a computed date ----------

export interface OverrideDeadlineDialogData {
  title: string;
  /** The date in force. */
  dueDate?: string | undefined;
  /** The engine's date, when it differs (an override stands). */
  computedDate?: string | undefined;
}

export interface OverrideDeadlineDialogResult {
  dueDate: DateOnly;
  reason: string;
}

/** Sets a computed deadline's date by hand, with a reason (lawyers and above, CORE-10). */
@Component({
  selector: 'mt-override-deadline-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtTextarea, MtTextField],
  template: `
    <mt-dialog size="sm" title="Override the date" [description]="description">
      <form id="mt-override-form" class="mt-col form" (submit)="$event.preventDefault(); save()">
        <mt-text-field
          name="dueDate"
          label="New due date"
          placeholder="DD/MM/YYYY"
          [error]="dateError() ?? undefined"
          [ngModel]="date()"
          (ngModelChange)="date.set($event ?? ''); dateError.set(null)"
        />
        <mt-textarea
          name="reason"
          label="Reason"
          description="Kept with the deadline and shown in its trace"
          [rows]="3"
          [error]="reasonError() ?? undefined"
          [ngModel]="reason()"
          (ngModelChange)="reason.set($event ?? ''); reasonError.set(null)"
        />
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-override-form">Override date</button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .form {
      gap: var(--space-12);
    }
  `,
})
export class OverrideDeadlineDialog {
  protected readonly ref = injectDialogRef<OverrideDeadlineDialogData, OverrideDeadlineDialogResult | undefined>();
  protected readonly data = this.ref.data;
  protected readonly description =
    `${this.data.title}. ` +
    (this.data.computedDate ? `The rule computes ${formatDateOnly(this.data.computedDate)}. ` : '') +
    'The rule keeps computing: you’re told if its date moves earlier than yours.';
  protected readonly date = signal(formatDueInput((this.data.dueDate as DateOnly | undefined) ?? null));
  protected readonly dateError = signal<string | null>(null);
  protected readonly reason = signal('');
  protected readonly reasonError = signal<string | null>(null);

  protected save(): void {
    const dueDate = parseDueInput(this.date());
    const problem = reasonProblem(this.reason());
    if (!dueDate) this.dateError.set('Enter a date like 14/10/2026.');
    if (problem) this.reasonError.set(problem === 'Give a reason' ? 'Say why the date is overridden.' : problem);
    if (!dueDate || problem) return;
    void this.ref.close({ dueDate, reason: this.reason().trim() });
  }
}

// ---------- accepting a critical change ----------

export interface ConfirmChangeDialogData {
  title: string;
  summary: string;
  matterNumber: string;
  intoPast: boolean;
}

/**
 * Accepting a proposed change to a critical deadline: the matter number typed to confirm
 * (`requiresTypedConfirmation`). Resolves with what was typed.
 */
@Component({
  selector: 'mt-confirm-change-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtTextField],
  template: `
    <mt-dialog size="sm" role="alertdialog" title="Accept a change to a critical deadline?" [description]="description">
      <form id="mt-confirm-change-form" (submit)="$event.preventDefault(); save()">
        <mt-text-field
          name="confirmation"
          autocomplete="off"
          [label]="'Type ' + data.matterNumber + ' to confirm'"
          [ngModel]="typed()"
          (ngModelChange)="typed.set($event ?? '')"
        />
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button mtButton variant="danger" type="submit" form="mt-confirm-change-form" [disabled]="!matches()">
          Accept change
        </button>
      </ng-container>
    </mt-dialog>
  `,
})
export class ConfirmChangeDialog {
  protected readonly ref = injectDialogRef<ConfirmChangeDialogData, string | undefined>();
  protected readonly data = this.ref.data;
  protected readonly description =
    `${this.data.title}: ${this.data.summary}.` +
    (this.data.intoPast ? ' The new date has already passed.' : '') +
    ' The deadline moves for everyone on the matter.';
  protected readonly typed = signal('');
  protected readonly matches = computed(() => confirmationMatches(this.typed(), this.data.matterNumber));

  protected save(): void {
    if (this.matches()) void this.ref.close(this.typed().trim());
  }
}
