import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';

import { TASK_CHECKLIST_MAX, type ChecklistItem, type Priority, type TaskStatus } from '@materia/domain';
import { formatDateOnly, MT_ORG_TIMEZONE, MtButton, MtIconButton } from '@materia/ui';

import { PRIORITY_NAMES, PRIORITY_ORDER, TASK_STATUS_LABELS, TASK_STATUS_ORDER, type TaskEntry } from './task-view';

let nextId = 0;
let nextListId = 0;
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
 * A task's details under its row (CORE-08): its status, priority, due date and (on a matter's Tasks
 * tab, CORE-08e) group, and its checklist
 * ticked, added to and removed inline. The add field shows only while adding (CORE-08c): "Add item"
 * opens it, Enter adds and keeps it open for the next one, Escape (or leaving it empty) closes it.
 * "Templates" beside it applies a checklist template (CORE-08d). Read-only for people who can't
 * edit the task.
 */
@Component({
  selector: 'mt-task-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtButton, MtIconButton],
  host: { class: 'mt-task-details' },
  template: `
    <div class="fields">
      <label class="field caption t-2">
        Status
        <select [disabled]="!entry().editable" (change)="onStatus($event)">
          @for (status of statuses; track status) {
            <option [value]="status" [selected]="status === entry().task.status">{{ labels[status] }}</option>
          }
        </select>
      </label>
      <label class="field caption t-2">
        Priority
        <select [disabled]="!entry().editable" (change)="onPriority($event)">
          @for (p of priorities; track p) {
            <option [value]="p" [selected]="p === (entry().task.priority ?? 'none')">{{ priorityNames[p] }}</option>
          }
        </select>
      </label>
      <span class="field caption t-2">
        Due
        <button
          mtButton
          variant="ghost"
          size="sm"
          iconStart="calendar"
          [disabled]="!entry().editable"
          [attr.aria-label]="dueText() ? 'Due date: ' + dueText() + '. Change it' : 'Set a due date'"
          (click)="dueDate.emit()"
        >
          {{ dueText() || 'Set a date' }}
        </button>
      </span>
      @if (groups(); as names) {
        <label class="field caption t-2">
          Group
          <input
            class="group"
            type="text"
            maxlength="120"
            placeholder="No group"
            [attr.list]="listId"
            [disabled]="!entry().editable"
            [value]="entry().task.group ?? ''"
            (keydown.enter)="$event.preventDefault(); $any($event.target).blur()"
            (keydown.escape)="resetGroup($event)"
            (change)="onGroup($event)"
          />
          <datalist [id]="listId">
            @for (name of names; track name) {
              <option [value]="name"></option>
            }
          </datalist>
        </label>
      }
    </div>
    @if (items().length) {
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
        }
      </ul>
    }
    @if (entry().editable) {
      <div class="checklist-actions">
        @if (items().length < max) {
          @if (adding()) {
            <input
              #addField
              class="add"
              type="text"
              [attr.aria-label]="'Add a checklist item to ' + entry().task.title"
              placeholder="Add a checklist item, then Enter"
              [value]="draft()"
              (input)="draft.set($any($event.target).value)"
              (keydown.enter)="$event.preventDefault(); add()"
              (keydown.escape)="$event.preventDefault(); $event.stopPropagation(); stopAdding(true)"
              (blur)="draft().trim() ? null : stopAdding(false)"
            />
          } @else {
            <button
              #addButton
              class="start"
              mtButton
              variant="ghost"
              size="sm"
              iconStart="plus"
              [attr.aria-label]="'Add a checklist item to ' + entry().task.title"
              (click)="startAdding()"
            >
              Add checklist item
            </button>
          }
        }
        <button
          class="templates"
          mtButton
          variant="ghost"
          size="sm"
          iconStart="list"
          [attr.aria-label]="'Checklist templates for ' + entry().task.title"
          (click)="templates.emit()"
        >
          Templates
        </button>
      </div>
    } @else if (!items().length) {
      <p class="caption t-3 empty">No checklist items.</p>
    }
  `,
  styles: `
    .mt-task-details {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-8);
      padding: var(--space-4) var(--space-8) var(--space-12) 56px;
    }
    .mt-task-details .fields {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-8) var(--space-16);
    }
    .mt-task-details .field {
      display: flex;
      align-items: center;
      gap: var(--space-8);
    }
    .mt-task-details select,
    .mt-task-details .group,
    .mt-task-details .add {
      font: 400 13px/18px var(--font-sans);
      color: var(--text-primary);
      background-color: var(--bg-surface);
      border: 1px solid var(--border-control);
      border-radius: var(--radius-sm);
      padding: 3px var(--space-8);
    }
    /* Our own chevron, with room to breathe at the end of the control. */
    .mt-task-details select {
      appearance: none;
      padding-right: 28px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23868B98' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      cursor: pointer;
    }
    .mt-task-details select:disabled {
      cursor: default;
      background-color: var(--bg-disabled);
    }
    .mt-task-details .group {
      width: 180px;
    }
    .mt-task-details .group:disabled {
      background-color: var(--bg-disabled);
    }
    .mt-task-details select:focus-visible,
    .mt-task-details .group:focus-visible,
    .mt-task-details .add:focus-visible {
      outline: none;
      border-color: var(--border-focus);
      box-shadow: var(--focus-ring);
    }
    .mt-task-details .add {
      flex: 1 1 240px;
      max-width: 420px;
      box-sizing: border-box;
    }
    .mt-task-details .checklist-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      align-self: stretch;
      gap: var(--space-4) var(--space-8);
    }
    .mt-task-details .start {
      margin-left: calc(-1 * var(--space-8));
    }
    .mt-task-details .empty {
      margin: 0;
    }
    .mt-task-details .items {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      align-self: stretch;
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
  readonly priority = output<Priority>();
  /** The due date button: the page asks for the new date. */
  readonly dueDate = output();
  /** "Templates": the page opens the checklist templates dialog (CORE-08d). */
  readonly templates = output();
  /**
   * The groups to suggest for the Group field (CORE-08e); `null` hides the field (My tasks, whose
   * sections are by date).
   */
  readonly groups = input<readonly string[] | null>(null);
  /** The new group, or `null` to take the task out of its group. */
  readonly group = output<string | null>();

  private readonly timeZone = inject(MT_ORG_TIMEZONE);
  private readonly injector = inject(Injector);
  private readonly addField = viewChild<ElementRef<HTMLInputElement>>('addField');
  private readonly addButton = viewChild('addButton', { read: ElementRef<HTMLButtonElement> });

  protected readonly statuses = TASK_STATUS_ORDER;
  protected readonly labels = TASK_STATUS_LABELS;
  protected readonly priorities = PRIORITY_ORDER;
  protected readonly priorityNames = PRIORITY_NAMES;
  protected readonly max = TASK_CHECKLIST_MAX;
  protected readonly items = computed(() => this.entry().task.checklist ?? []);
  protected readonly dueText = computed(() => {
    const due = this.entry().task.dueDate;
    return due ? formatDateOnly(due, this.timeZone) : '';
  });
  protected readonly listId = `mt-task-groups-${nextListId++}`;
  protected readonly draft = signal('');
  protected readonly adding = signal(false);

  protected onStatus(event: Event): void {
    this.status.emit((event.target as HTMLSelectElement).value as TaskStatus);
  }

  protected onPriority(event: Event): void {
    this.priority.emit((event.target as HTMLSelectElement).value as Priority);
  }

  /** Enter or leaving the field: a changed group is saved; a cleared one takes the task out. */
  protected onGroup(event: Event): void {
    const field = event.target as HTMLInputElement;
    const next = field.value.trim();
    if (next === (this.entry().task.group?.trim() ?? '')) return;
    this.group.emit(next || null);
  }

  /** Escape puts the saved group back. */
  protected resetGroup(event: Event): void {
    const field = event.target as HTMLInputElement;
    if (field.value === (this.entry().task.group ?? '')) return;
    event.preventDefault();
    event.stopPropagation();
    field.value = this.entry().task.group ?? '';
  }

  protected tick(item: ChecklistItem, done: boolean): void {
    this.checklist.emit(this.items().map((i) => (i.id === item.id ? { ...i, done } : i)));
  }

  protected removeItem(item: ChecklistItem): void {
    this.checklist.emit(this.items().filter((i) => i.id !== item.id));
  }

  protected startAdding(): void {
    this.adding.set(true);
    afterNextRender(() => this.addField()?.nativeElement.focus(), { injector: this.injector });
  }

  /** Escape (focus goes back to "Add checklist item") or leaving the field empty. */
  protected stopAdding(refocus: boolean): void {
    this.adding.set(false);
    this.draft.set('');
    if (refocus) afterNextRender(() => this.addButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected add(): void {
    const text = this.draft().trim().slice(0, 500);
    if (!text) return;
    const items = this.items();
    this.checklist.emit([...items, { id: itemId(items), text, done: false }]);
    this.draft.set('');
    const field = this.addField()?.nativeElement;
    if (field) field.value = '';
  }
}
