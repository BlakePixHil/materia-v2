import {
  afterNextRender,
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
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
import { MtIconButton } from '../icon-button/icon-button';
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

/** How far (px) a row must be swiped to complete or snooze it, and to count as a swipe at all. */
const SWIPE_COMMIT_PX = 72;
const SWIPE_START_PX = 10;
/** A click this soon (ms) after a swipe is the swipe's own. */
const SWIPE_CLICK_MS = 400;

/**
 * TaskRow (`mt-task-row`): a task in a list. The checkbox emits `done`; the title emits `open`, or with
 * `editable` turns into an input (Enter saves and emits `titleChange`, Escape cancels). Long titles
 * truncate with the full title in a tooltip.
 *
 * `snoozable` adds a "Snooze to tomorrow" button (`snooze`), shown on hover and focus, and always on a
 * touch screen. `swipeable` (MOB-02) lets a finger swipe the row right to complete it or left to
 * snooze it; the checkbox and the button stay as the accessible ways to do the same.
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
  imports: [MtIcon, MtIconButton, MtDeadlineChip, MtAvatar, MtMatterTag, MtPriorityIcon, MtTooltip],
  host: {
    class: 'mt-task',
    '[attr.data-done]': 'task().done ? "" : null',
    '[attr.data-id]': 'task().id',
    '[attr.data-swipeable]': 'swipes() ? "" : null',
    '[attr.data-swipe]': 'swipe()',
    '[attr.data-dragging]': 'dragging() ? "" : null',
    '[style.--mt-swipe]': 'offset() ? offset() + "px" : null',
    '(pointerdown)': 'swipeStart($event)',
    '(pointermove)': 'swipeMove($event)',
    '(pointerup)': 'swipeEnd($event)',
    '(pointercancel)': 'swipeCancel()',
  },
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
    @if (snoozable() && !task().done) {
      <button
        mtIconButton
        class="mt-task-snooze"
        icon="clock"
        size="sm"
        [label]="'Snooze to tomorrow: ' + task().title"
        [disabled]="disabled()"
        (click)="snooze.emit()"
      ></button>
    }
  `,
})
export class MtTaskRow {
  readonly task = input.required<TaskRowVm>();
  /** The title can be edited in place. */
  readonly editable = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Offers "Snooze to tomorrow" (`snooze`). */
  readonly snoozable = input(false, { transform: booleanAttribute });
  /** A finger can swipe it right to complete, or left to snooze when `snoozable` (MOB-02). */
  readonly swipeable = input(false, { transform: booleanAttribute });

  /** The checkbox was toggled: the new done state. */
  readonly done = output<boolean>();
  /** The title was edited: the new title (trimmed, non-empty, changed). */
  readonly titleChange = output<string>();
  /** The title was activated (when not editable). */
  readonly open = output();
  /** "Snooze to tomorrow": its button, or a swipe to the left. */
  readonly snooze = output();

  protected readonly swipes = computed(() => this.swipeable() && !this.disabled() && !this.editing());
  /** How far the row is dragged, in px: right completes, left snoozes. */
  protected readonly offset = signal(0);
  protected readonly dragging = signal(false);
  /** What letting go now would do. */
  protected readonly swipe = computed(() => {
    const offset = this.offset();
    if (offset > 0 && !this.task().done) return 'done';
    if (offset < 0 && this.snoozable() && !this.task().done) return 'snooze';
    return null;
  });
  private start: { x: number; y: number; id: number } | null = null;
  /** When the last swipe ended (ms): the click that ends a swipe isn't a tap. */
  private swipedAt = -Infinity;

  protected readonly editing = signal(false);
  private readonly editor = viewChild<ElementRef<HTMLInputElement>>('editor');
  private readonly titleButton = viewChild<ElementRef<HTMLButtonElement>>('titleButton');
  private readonly injector = inject(Injector);

  constructor() {
    // A swipe can end with a click on whatever was under the finger: it isn't a tap on the title or
    // the checkbox. Capturing at the row runs before their own handlers.
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const guard = (event: Event) => {
      if (event.timeStamp - this.swipedAt > SWIPE_CLICK_MS) return;
      this.swipedAt = -Infinity;
      event.preventDefault();
      event.stopPropagation();
    };
    host.addEventListener('click', guard, { capture: true });
    inject(DestroyRef).onDestroy(() => host.removeEventListener('click', guard, { capture: true }));
  }

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

  protected swipeStart(event: PointerEvent): void {
    if (!this.swipes() || event.pointerType !== 'touch' || !event.isPrimary) return;
    this.start = { x: event.clientX, y: event.clientY, id: event.pointerId };
  }

  protected swipeMove(event: PointerEvent): void {
    const start = this.start;
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!this.dragging()) {
      // Scrolling the list wins until the finger has clearly moved sideways.
      if (Math.abs(dy) > SWIPE_START_PX && Math.abs(dy) > Math.abs(dx)) {
        this.start = null;
        return;
      }
      if (Math.abs(dx) < SWIPE_START_PX) return;
      this.dragging.set(true);
      (event.currentTarget as Element | null)?.setPointerCapture?.(event.pointerId);
    }
    // Only directions that do something follow the finger; the other resists.
    const allowed = dx > 0 ? !this.task().done : this.snoozable() && !this.task().done;
    this.offset.set(allowed ? dx : dx / 4);
  }

  protected swipeEnd(event?: PointerEvent): void {
    if (this.dragging()) this.swipedAt = event?.timeStamp ?? performance.now();
    const action = Math.abs(this.offset()) >= SWIPE_COMMIT_PX ? this.swipe() : null;
    this.swipeCancel();
    if (action === 'done') this.done.emit(true);
    else if (action === 'snooze') this.snooze.emit();
  }

  protected swipeCancel(): void {
    this.start = null;
    this.dragging.set(false);
    this.offset.set(0);
  }

  private finish(): void {
    this.editing.set(false);
    afterNextRender(() => this.titleButton()?.nativeElement.focus(), { injector: this.injector });
  }
}
