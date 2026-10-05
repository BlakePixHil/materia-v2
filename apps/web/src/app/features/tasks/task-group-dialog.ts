import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TASK_GROUP_MAX } from '@materia/domain';
import { injectDialogRef, MtButton, MtDialog, MtTextField } from '@materia/ui';

export interface TaskGroupDialogData {
  /** How many tasks change. */
  count: number;
  /** Their shared group, if they have one. */
  current: string | null;
  /** The groups already on the list (and the matter's stages), to pick from. */
  groups: readonly string[];
}

/** The new group, or `null` to take the tasks out of their group. */
export interface TaskGroupDialogResult {
  group: string | null;
}

/**
 * Moves the selected tasks into a group (CORE-08e): type a new one or pick one already on the list.
 * Saving it empty takes them out of their group.
 */
@Component({
  selector: 'mt-task-group-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtTextField],
  template: `
    <mt-dialog size="sm" [title]="title">
      <form id="mt-task-group-form" class="mt-task-group-form" (submit)="$event.preventDefault(); save()">
        <mt-text-field
          name="group"
          label="Group"
          placeholder="A new or existing group"
          [ngModel]="text()"
          (ngModelChange)="text.set($event ?? '')"
        />
        @if (data.groups.length) {
          <div class="picks" role="group" aria-label="Groups on this list">
            @for (name of data.groups; track name) {
              <button
                type="button"
                mtButton
                variant="secondary"
                size="sm"
                [attr.aria-pressed]="name === text().trim()"
                (click)="text.set(name)"
              >
                {{ name }}
              </button>
            }
          </div>
        }
      </form>
      <ng-container mtDialogFooter>
        @if (data.current) {
          <button mtButton variant="ghost" (click)="close({ group: null })">Remove from group</button>
        }
        <button mtButton variant="ghost" (click)="close()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-task-group-form">Move to group</button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .mt-task-group-form {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
    }
    .mt-task-group-form .picks {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-6);
    }
  `,
})
export class TaskGroupDialog {
  protected readonly ref = injectDialogRef<TaskGroupDialogData, TaskGroupDialogResult | undefined>();
  protected readonly data = this.ref.data;
  protected readonly title =
    this.data.count === 1 ? 'Move the task to a group' : `Move ${this.data.count} tasks to a group`;
  protected readonly text = signal(this.data.current ?? '');

  protected close(result?: TaskGroupDialogResult): void {
    void this.ref.close(result);
  }

  protected save(): void {
    const group = this.text().trim().slice(0, TASK_GROUP_MAX);
    this.close({ group: group || null });
  }
}
