import {
  afterNextRender,
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  inject,
  input,
  output,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';

import type { MatterType, Priority } from '@materia/domain';

import { type DeadlineVm, MtDeadlineChip } from '../deadline-chip/deadline-chip';
import { MtIcon } from '../icon/icon';
import { MtAvatar, type MtAvatarPerson, MtMatterTag, MtPriorityIcon } from '../markers/markers';
import { MtTooltip } from '../tooltip/tooltip';

/** What a TaskRow shows. Feature code maps a task (and its matter) to this. */
export interface TaskRowVm {
  id: string;
  title: string;
  done: boolean;
  /** Secondary line, such as "WE-142 · Whitfield". */
  subtitle?: string | undefined;
  matterType?: MatterType | undefined;
  assignee?: MtAvatarPerson | null | undefined;
  deadline?: DeadlineVm | null | undefined;
  priority?: Priority | undefined;
}

/**
 * TaskRow (`mt-task-row`): a task in a list. The checkbox emits `done`; the title emits `open`, or with
 * `editable` turns into an input (Enter saves and emits `titleChange`, Escape cancels). Long titles
 * truncate with the full title in a tooltip.
 */
@Component({
  selector: 'mt-task-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/task.css',
    '../../generated/components/check.css',
    '../../generated/components/layout.css',
  ],
  imports: [MtIcon, MtDeadlineChip, MtAvatar, MtMatterTag, MtPriorityIcon, MtTooltip],
  host: { class: 'mt-task', '[attr.data-done]': 'task().done ? "" : null', '[attr.data-id]': 'task().id' },
  template: `
    <button
      type="button"
      class="mt-check"
      role="checkbox"
      [attr.aria-checked]="task().done"
      [attr.data-checked]="task().done ? '' : null"
      [attr.aria-label]="'Done: ' + task().title"
      [disabled]="disabled()"
      [attr.data-disabled]="disabled() ? '' : null"
      (click)="done.emit(!task().done)"
    >
      <mt-icon name="check" />
    </button>
    <div class="mt-grow">
      @if (editing()) {
        <input
          #editor
          class="tt mt-task-edit"
          [value]="task().title"
          [attr.aria-label]="'Task title'"
          (keydown.enter)="$event.preventDefault(); commit(editor.value)"
          (keydown.escape)="$event.preventDefault(); cancel()"
          (blur)="commit(editor.value)"
        />
      } @else {
        <button
          #titleButton
          type="button"
          class="tt mt-ell mt-task-title"
          [mtTooltip]="task().title"
          [attr.aria-label]="editable() ? 'Edit title: ' + task().title : null"
          (click)="activate()"
        >
          {{ task().title }}
        </button>
      }
      @if (task().subtitle; as subtitle) {
        <div class="ts mt-ell">{{ subtitle }}</div>
      }
    </div>
    @if (task().matterType; as type) {
      <mt-matter-tag [type]="type" />
    }
    @if (task().deadline; as deadline) {
      <mt-deadline-chip
        [due]="deadline.due"
        [completed]="!!deadline.completed || task().done"
        [critical]="!!deadline.critical"
        [trace]="deadline.trace"
      />
    }
    @if (task().priority; as level) {
      @if (level !== 'none') {
        <mt-priority-icon [level]="level" />
      }
    }
    @if (task().assignee; as person) {
      <mt-avatar
        [name]="person.name"
        [src]="person.src ?? null"
        [colorKey]="person.id ?? person.name"
        size="sm"
        [tooltip]="true"
      />
    }
  `,
})
export class MtTaskRow {
  readonly task = input.required<TaskRowVm>();
  /** The title can be edited in place. */
  readonly editable = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });

  /** The checkbox was toggled: the new done state. */
  readonly done = output<boolean>();
  /** The title was edited: the new title (trimmed, non-empty, changed). */
  readonly titleChange = output<string>();
  /** The title was activated (when not editable). */
  readonly open = output();

  protected readonly editing = signal(false);
  private readonly editor = viewChild<ElementRef<HTMLInputElement>>('editor');
  private readonly titleButton = viewChild<ElementRef<HTMLButtonElement>>('titleButton');
  private readonly injector = inject(Injector);

  protected activate(): void {
    if (!this.editable()) {
      this.open.emit();
      return;
    }
    this.editing.set(true);
    afterNextRender(
      () => {
        const input = this.editor()?.nativeElement;
        input?.focus();
        input?.select();
      },
      { injector: this.injector },
    );
  }

  protected commit(value: string): void {
    if (!this.editing()) return;
    const title = value.trim();
    this.finish();
    if (title && title !== this.task().title) this.titleChange.emit(title);
  }

  protected cancel(): void {
    this.finish();
  }

  private finish(): void {
    this.editing.set(false);
    afterNextRender(() => this.titleButton()?.nativeElement.focus(), { injector: this.injector });
  }
}
