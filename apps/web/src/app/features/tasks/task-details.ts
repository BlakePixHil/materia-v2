import { ChangeDetectionStrategy, Component, computed, input, output, signal, ViewEncapsulation } from '@angular/core';

import { TASK_CHECKLIST_MAX, type ChecklistItem, type TaskStatus } from '@materia/domain';
import { MtIconButton } from '@materia/ui';

import { TASK_STATUS_LABELS, TASK_STATUS_ORDER, type TaskEntry } from './task-view';

let nextId = 0;
/** A checklist item id, unique within its task. */
function itemId(existing: readonly ChecklistItem[]): string {
  const taken = new Set(existing.map((item) => item.id));
  let id: string;
  do {
    id = `c${Date.now().toString(36)}${(nextId++).toString(36)}`;
  } while (taken.has(id));
  return id;
}

/**
 * A task's details under its row (CORE-08): its status, and its checklist ticked, added to and
 * removed inline. Read-only for people who can't edit the task.
 */
@Component({
  selector: 'mt-task-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtIconButton],
  host: { class: 'mt-task-details' },
  template: `
    <label class="status caption t-2">
      Status
      <select [disabled]="!entry().editable" (change)="onStatus($event)">
        @for (status of statuses; track status) {
          <option [value]="status" [selected]="status === entry().task.status">{{ labels[status] }}</option>
        }
      </select>
    </label>
    <ul class="items" [attr.aria-label]="'Checklist for ' + entry().task.title">
      @for (item of items(); track item.id) {
        <li>
          <label>
            <input
              type="checkbox"
              [checked]="item.done"
              [disabled]="!entry().editable"
              (change)="tick(item, $any($event.target).checked)"
            />
            <span [class.done]="item.done">{{ item.text }}</span>
          </label>
          @if (entry().editable) {
            <button
              mtIconButton
              icon="x"
              size="sm"
              [tooltip]="false"
              [label]="'Remove checklist item: ' + item.text"
              (click)="removeItem(item)"
            ></button>
          }
        </li>
      } @empty {
        <li class="caption t-3">No checklist items.</li>
      }
    </ul>
    @if (entry().editable && items().length < max) {
      <input
        class="add"
        type="text"
        [attr.aria-label]="'Add a checklist item to ' + entry().task.title"
        placeholder="Add a checklist item"
        [value]="draft()"
        (input)="draft.set($any($event.target).value)"
        (keydown.enter)="$event.preventDefault(); add()"
      />
    }
  `,
  styles: `
    .mt-task-details {
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
      padding: var(--space-4) var(--space-8) var(--space-8) 56px;
    }
    .mt-task-details .status {
      display: flex;
      align-items: center;
      gap: var(--space-8);
    }
    .mt-task-details select,
    .mt-task-details .add {
      font: 400 13px/18px var(--font-sans);
      color: var(--text-primary);
      background: var(--bg-surface);
      border: 1px solid var(--border-control);
      border-radius: var(--radius-sm);
      padding: 2px var(--space-6);
    }
    .mt-task-details .add {
      max-width: 420px;
    }
    .mt-task-details .items {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .mt-task-details .items li {
      display: flex;
      align-items: center;
      gap: var(--space-6);
      font: 400 13px/18px var(--font-sans);
    }
    .mt-task-details .items label {
      display: flex;
      align-items: center;
      gap: var(--space-8);
    }
    .mt-task-details .done {
      color: var(--text-tertiary);
      text-decoration: line-through;
    }
  `,
})
export class TaskDetails {
  readonly entry = input.required<TaskEntry>();
  /** The whole new checklist after a tick, add or remove. */
  readonly checklist = output<ChecklistItem[]>();
  readonly status = output<TaskStatus>();

  protected readonly statuses = TASK_STATUS_ORDER;
  protected readonly labels = TASK_STATUS_LABELS;
  protected readonly max = TASK_CHECKLIST_MAX;
  protected readonly items = computed(() => this.entry().task.checklist ?? []);
  protected readonly draft = signal('');

  protected onStatus(event: Event): void {
    this.status.emit((event.target as HTMLSelectElement).value as TaskStatus);
  }

  protected tick(item: ChecklistItem, done: boolean): void {
    this.checklist.emit(this.items().map((i) => (i.id === item.id ? { ...i, done } : i)));
  }

  protected removeItem(item: ChecklistItem): void {
    this.checklist.emit(this.items().filter((i) => i.id !== item.id));
  }

  protected add(): void {
    const text = this.draft().trim().slice(0, 500);
    if (!text) return;
    const items = this.items();
    this.checklist.emit([...items, { id: itemId(items), text, done: false }]);
    this.draft.set('');
  }
}
