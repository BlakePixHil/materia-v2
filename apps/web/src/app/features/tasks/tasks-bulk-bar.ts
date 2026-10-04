import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import type { Priority, TaskStatus } from '@materia/domain';
import { MT_MENU, MtButton, MtIconButton } from '@materia/ui';

import { PRIORITY_NAMES, PRIORITY_ORDER, TASK_STATUS_LABELS, TASK_STATUS_ORDER, type TaskPerson } from './task-view';

/**
 * The bar for the selected tasks (CORE-08): status, assignee, due date, priority and delete, then
 * clear. Up to 50 tasks change directly; more go through `tasks-bulkUpdate`.
 */
@Component({
  selector: 'mt-tasks-bulk-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MT_MENU, MtButton, MtIconButton],
  host: { role: 'region', 'aria-label': 'Selected tasks' },
  template: `
    <span class="label" role="status">{{ count() === 1 ? '1 selected' : count() + ' selected' }}</span>
    <button
      mtButton
      variant="ghost"
      size="sm"
      iconStart="check-circle"
      [mtMenuTrigger]="statusMenu"
      [disabled]="busy()"
    >
      Status
    </button>
    @if (people().length) {
      <button mtButton variant="ghost" size="sm" iconStart="user" [mtMenuTrigger]="assignMenu" [disabled]="busy()">
        Assign
      </button>
    }
    <button mtButton variant="ghost" size="sm" iconStart="calendar" [disabled]="busy()" (click)="dueDate.emit()">
      Due date
    </button>
    <button mtButton variant="ghost" size="sm" iconStart="flag" [mtMenuTrigger]="priorityMenu" [disabled]="busy()">
      Priority
    </button>
    <button mtButton variant="ghost" size="sm" iconStart="trash" [disabled]="busy()" (click)="remove.emit()">
      Delete
    </button>
    <button mtIconButton icon="x" size="sm" label="Clear selection" tooltipKbd="esc" (click)="clear.emit()"></button>

    <ng-template #statusMenu>
      <mt-menu aria-label="Set status to">
        @for (s of statuses; track s) {
          <button mtMenuItem (click)="status.emit(s)">{{ statusLabels[s] }}</button>
        }
      </mt-menu>
    </ng-template>
    <ng-template #assignMenu>
      <mt-menu aria-label="Assign to">
        @for (person of people(); track person.uid) {
          <button mtMenuItem (click)="assign.emit(person.uid)">{{ person.name }}</button>
        }
        <button mtMenuItem (click)="assign.emit(null)">Unassigned</button>
      </mt-menu>
    </ng-template>
    <ng-template #priorityMenu>
      <mt-menu aria-label="Set priority to">
        @for (p of priorities; track p) {
          <button mtMenuItem (click)="priority.emit(p)">{{ priorityLabels[p] }}</button>
        }
      </mt-menu>
    </ng-template>
  `,
  styles: `
    :host {
      position: sticky;
      bottom: var(--space-16);
      z-index: 2;
      align-self: center;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-4);
      max-width: 100%;
      padding: var(--space-6) var(--space-6) var(--space-6) 14px;
      border-radius: 10px;
      background: var(--bg-inverse);
      color: var(--text-inverse);
      box-shadow: var(--shadow-dialog);
    }
    .label {
      margin-right: var(--space-8);
      font: 500 13px/18px var(--font-sans);
    }
    :host ::ng-deep .mt-btn,
    :host ::ng-deep .mt-ibtn {
      color: var(--text-inverse);
    }
  `,
})
export class TasksBulkBar {
  readonly count = input.required<number>();
  /** Who matter tasks can be assigned to (empty hides Assign). */
  readonly people = input<readonly TaskPerson[]>([]);
  readonly busy = input(false);

  readonly status = output<TaskStatus>();
  readonly assign = output<string | null>();
  readonly dueDate = output();
  readonly priority = output<Priority>();
  readonly remove = output();
  readonly clear = output();

  protected readonly statuses = TASK_STATUS_ORDER;
  protected readonly statusLabels = TASK_STATUS_LABELS;
  protected readonly priorities = PRIORITY_ORDER;
  protected readonly priorityLabels = PRIORITY_NAMES;
}
