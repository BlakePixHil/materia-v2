import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';

import type { DateOnly, Priority } from '@materia/domain';
import type { QuickAddResult } from '@materia/domain/quick-add';
import { DialogService, formatDateOnly, MT_MENU, MT_ORG_TIMEZONE, MtIcon, MtIconButton, MtKbd } from '@materia/ui';

import { loadQuickAddParser, type QuickAddParser } from './quick-add-loader';
import { TaskDueDialog, type TaskDueDialogData, type TaskDueDialogResult } from './task-due-dialog';
import { PRIORITY_NAMES, PRIORITY_ORDER, type TaskPerson } from './task-view';

export { loadQuickAddParser } from './quick-add-loader';

/** What the quick-add line saves: a title and whatever the tokens set. */
export interface QuickAddTask {
  title: string;
  assigneeUid?: string;
  priority?: Priority;
  dueDate?: DateOnly;
}

/** A piece of the typed line: plain text or a recognised token. */
interface Segment {
  text: string;
  kind: 'assignee' | 'priority' | 'due' | 'unresolved' | null;
}

/**
 * The tasks quick-add line (CORE-08), opened with `c`: `Lodge the inventory @jordan !high fri`
 * becomes a task with an assignee, a priority and a due date. Recognised parts are highlighted as
 * you type, with chips for what they mean underneath; names that match nobody (or several people)
 * are pointed out. The calendar and flag buttons set the due date and priority by hand, and a
 * chip's × drops a date or priority without touching the words typed (CORE-08b). Enter saves and
 * keeps the line open for the next task; Escape closes it.
 */
@Component({
  selector: 'mt-task-quick-add',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/input.css'],
  imports: [MT_MENU, MtIcon, MtIconButton, MtKbd],
  host: { class: 'mt-quick-add' },
  template: `
    <div class="line">
      <div class="mt-input">
        <input
          #field
          type="text"
          autocomplete="off"
          spellcheck="false"
          [attr.aria-label]="label()"
          [attr.aria-describedby]="ids.help + ' ' + ids.summary"
          [attr.aria-invalid]="error() ? true : null"
          [placeholder]="placeholder()"
          [value]="text()"
          (input)="onInput($event)"
          (keydown.enter)="$event.preventDefault(); save()"
          (keydown.escape)="$event.preventDefault(); $event.stopPropagation(); closed.emit()"
        />
      </div>
      <button mtIconButton icon="calendar" size="sm" label="Set a due date" (click)="pickDate()"></button>
      <button mtIconButton icon="flag" size="sm" label="Set a priority" [mtMenuTrigger]="priorityMenu"></button>
    </div>
    @if (text()) {
      <p class="preview" aria-hidden="true">
        @for (segment of segments(); track $index) {
          @if (segment.kind) {
            <mark [attr.data-kind]="segment.kind">{{ segment.text }}</mark>
          } @else {
            <span>{{ segment.text }}</span>
          }
        }
      </p>
    }
    @if (assigneeName() || dueDate() || shownPriority()) {
      <div class="chips">
        @if (assigneeName(); as name) {
          <span class="qa-chip"><mt-icon name="user" [size]="14" />{{ name }}</span>
        }
        @if (shownPriority(); as level) {
          <span class="qa-chip" data-kind="priority">
            <mt-icon name="flag" [size]="14" />{{ priorityNames[level] }}
            <button type="button" class="drop" aria-label="Remove the priority" (click)="dropPriority()">
              <mt-icon name="x" [size]="14" />
            </button>
          </span>
        }
        @if (dueDate(); as due) {
          <span class="qa-chip" data-kind="due">
            <mt-icon name="calendar" [size]="14" />Due {{ formatDue(due) }}
            <button type="button" class="drop" aria-label="Remove the due date" (click)="dropDate()">
              <mt-icon name="x" [size]="14" />
            </button>
          </span>
        }
      </div>
    }
    <p class="mt-sr" [id]="ids.summary">{{ summary() }}</p>
    <div class="problems" aria-live="polite">
      @if (error(); as message) {
        <p class="caption danger">{{ message }}</p>
      }
      @for (problem of problems(); track problem) {
        <p class="caption warn">{{ problem }}</p>
      }
    </div>
    <p class="caption t-3" [id]="ids.help">
      @if (personal()) {
        Type !high for priority and a date like fri or 14/10.
      } @else {
        Type @name to assign, !high for priority and a date like fri or 14/10.
      }
      <mt-kbd keys="enter" /> saves, <mt-kbd keys="esc" /> closes.
    </p>
    <ng-template #priorityMenu>
      <mt-menu aria-label="Set priority to">
        @for (p of priorities; track p) {
          <button mtMenuItem (click)="setPriority(p)">{{ priorityNames[p] }}</button>
        }
      </mt-menu>
    </ng-template>
  `,
  styles: `
    .mt-quick-add {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      padding: var(--space-8);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }
    .mt-quick-add p {
      margin: 0;
    }
    .mt-quick-add .line {
      display: flex;
      align-items: center;
      gap: var(--space-4);
    }
    .mt-quick-add .line > .mt-input {
      flex: 1;
      min-width: 0;
    }
    .mt-quick-add .chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-6);
    }
    .mt-quick-add .qa-chip {
      display: inline-flex;
      align-items: center;
      gap: var(--space-4);
      padding: 1px var(--space-4) 1px var(--space-6);
      border-radius: var(--radius-sm);
      background: var(--bg-selected);
      color: var(--text-brand);
      font: 500 12px/18px var(--font-sans);
    }
    .mt-quick-add .qa-chip[data-kind='priority'] {
      background: var(--bg-warning-subtle);
      color: var(--text-warning);
    }
    .mt-quick-add .qa-chip .drop {
      all: unset;
      display: inline-grid;
      place-items: center;
      width: 16px;
      height: 16px;
      border-radius: var(--radius-xs);
      cursor: pointer;
    }
    .mt-quick-add .qa-chip .drop:hover {
      background: var(--bg-hover);
    }
    .mt-quick-add .qa-chip .drop:focus-visible {
      box-shadow: var(--focus-ring);
    }
    .mt-quick-add .preview {
      font: 400 13px/20px var(--font-sans);
      color: var(--text-secondary);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .mt-quick-add mark {
      border-radius: var(--radius-xs);
      padding: 0 2px;
      background: var(--bg-selected);
      color: var(--text-brand);
    }
    .mt-quick-add mark[data-kind='priority'] {
      background: var(--bg-warning-subtle);
      color: var(--text-warning);
    }
    .mt-quick-add mark[data-kind='unresolved'] {
      background: transparent;
      color: var(--text-danger);
      text-decoration: underline wavy;
    }
    .mt-quick-add .danger {
      color: var(--text-danger);
    }
    .mt-quick-add .warn {
      color: var(--text-primary);
    }
  `,
})
export class TaskQuickAdd {
  /** Who `@name` can assign to (empty for personal tasks). */
  readonly members = input<readonly TaskPerson[]>([]);
  /** Personal tasks: no assignees. */
  readonly personal = input(false);
  readonly label = input('New task');
  readonly placeholder = input('Task title, @name, !priority, due date');

  readonly saved = output<QuickAddTask>();
  readonly closed = output();

  private static next = 0;
  protected readonly ids = (() => {
    const n = TaskQuickAdd.next++;
    return { help: `mt-qa-help-${n}`, summary: `mt-qa-summary-${n}` };
  })();
  private readonly timeZone = inject(MT_ORG_TIMEZONE);
  private readonly dialogs = inject(DialogService);
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  protected readonly text = signal('');
  protected readonly error = signal<string | null>(null);
  private readonly parser = signal<QuickAddParser | null>(null);
  protected readonly priorityNames = PRIORITY_NAMES;
  protected readonly priorities = PRIORITY_ORDER;
  /** Date phrases dismissed with ×: they stay in the title. */
  private readonly ignoredDates = signal<readonly string[]>([]);
  /** A due date picked with the calendar button (`null`: removed), over any typed one. */
  private readonly manualDue = signal<DateOnly | null | undefined>(undefined);
  /** A priority picked from the menu (or removed with ×), over any typed one. */
  private readonly manualPriority = signal<Priority | undefined>(undefined);

  protected readonly result = computed<QuickAddResult>(() => {
    const text = this.text();
    const parser = this.parser();
    const fallback: QuickAddResult = { title: text.replace(/\s+/g, ' ').trim(), tokens: [], unresolved: [] };
    if (!parser || !text.trim()) return fallback;
    const members = this.personal() ? [] : this.members().map((m) => ({ uid: m.uid, displayName: m.name }));
    return parser.parseQuickAdd(text, {
      members,
      now: new Date(),
      timeZone: this.timeZone,
      ignoreDates: this.ignoredDates(),
    });
  });

  /** The due date the task gets: picked by hand, else typed. */
  protected readonly dueDate = computed(() => {
    const manual = this.manualDue();
    return manual === undefined ? this.result().dueDate : (manual ?? undefined);
  });
  /** The priority the task gets: picked by hand, else typed. */
  protected readonly priority = computed(() => this.manualPriority() ?? this.result().priority);
  protected readonly shownPriority = computed(() => {
    const priority = this.priority();
    return priority && priority !== 'none' ? priority : null;
  });
  protected readonly assigneeName = computed(() => {
    const uid = this.result().assigneeUid;
    if (!uid || this.personal()) return null;
    return this.members().find((m) => m.uid === uid)?.name ?? null;
  });

  protected readonly segments = computed<Segment[]>(() => {
    const text = this.text();
    const { tokens, unresolved } = this.result();
    const marks: { start: number; end: number; kind: Segment['kind'] }[] = tokens.map((t) => ({
      start: t.start,
      end: t.end,
      kind: t.kind,
    }));
    if (!this.personal()) {
      for (const problem of unresolved) {
        const start = text.indexOf(problem.text);
        if (start >= 0 && !marks.some((m) => start >= m.start && start < m.end)) {
          marks.push({ start, end: start + problem.text.length, kind: 'unresolved' });
        }
      }
    }
    marks.sort((a, b) => a.start - b.start);
    const out: Segment[] = [];
    let at = 0;
    for (const mark of marks) {
      if (mark.start < at) continue;
      if (mark.start > at) out.push({ text: text.slice(at, mark.start), kind: null });
      out.push({ text: text.slice(mark.start, mark.end), kind: mark.kind });
      at = mark.end;
    }
    if (at < text.length) out.push({ text: text.slice(at), kind: null });
    return out;
  });

  /** "Assigned to Jordan Price · High priority · Due 9 Oct 2026", read with the field. */
  protected readonly summary = computed(() => {
    const result = this.result();
    if (!this.text().trim()) return '';
    const parts: string[] = [];
    if (result.assigneeUid && !this.personal()) {
      const person = this.members().find((m) => m.uid === result.assigneeUid);
      parts.push(`Assigned to ${person?.name ?? 'them'}`);
    }
    const priority = this.priority();
    if (priority) parts.push(`${PRIORITY_NAMES[priority]}${priority === 'none' ? '' : ' priority'}`);
    const due = this.dueDate();
    if (due) parts.push(`Due ${formatDateOnly(due, this.timeZone)}`);
    return parts.length ? parts.join(' · ') : '';
  });

  /** Names that matched nobody, or more than one person. */
  protected readonly problems = computed(() => {
    if (this.personal()) return [];
    const byUid = new Map(this.members().map((m) => [m.uid, m.name] as const));
    return this.result().unresolved.map((problem) =>
      problem.reason === 'unknown'
        ? `No one in the team matches ${problem.text}, so it stays in the title.`
        : `${problem.text} could be ${problem.candidates.map((uid) => byUid.get(uid) ?? 'someone').join(' or ')}. Type more of the name.`,
    );
  });

  constructor() {
    // Offline before the parser loaded: the line still saves, with the text as typed.
    loadQuickAddParser().then(
      (parser) => this.parser.set(parser),
      () => undefined,
    );
    afterNextRender(() => this.focus());
  }

  focus(): void {
    this.field().nativeElement.focus();
  }

  protected formatDue(date: DateOnly): string {
    return formatDateOnly(date, this.timeZone);
  }

  /** The calendar button: the due date dialog, which also takes `fri` or `14 Oct`. */
  protected async pickDate(): Promise<void> {
    const result = await this.dialogs.open<TaskDueDialogData, TaskDueDialogResult | undefined>(TaskDueDialog, {
      data: { count: 1, current: this.dueDate() ?? null, title: 'Due date for the new task' },
    }).result;
    if (result) this.manualDue.set(result.dueDate);
    this.focus();
  }

  protected setPriority(priority: Priority): void {
    this.manualPriority.set(priority);
    this.focus();
  }

  /** × on the date chip: the words stay in the title; only the date goes. */
  protected dropDate(): void {
    const typed = this.result().tokens.find((token) => token.kind === 'due');
    const parser = this.parser();
    if (typed && parser) this.ignoredDates.update((list) => [...list, parser.dateKey(typed.text)]);
    this.manualDue.set(undefined);
    this.focus();
  }

  protected dropPriority(): void {
    this.manualPriority.set('none');
    this.focus();
  }

  protected onInput(event: Event): void {
    this.text.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  protected save(): void {
    const result = this.result();
    if (!result.title) {
      this.error.set('Type a title for the task.');
      return;
    }
    if (result.title.length > 500) {
      this.error.set('Keep the title to 500 characters or fewer.');
      return;
    }
    const task: QuickAddTask = { title: result.title };
    if (result.assigneeUid && !this.personal()) task.assigneeUid = result.assigneeUid;
    const priority = this.priority();
    const dueDate = this.dueDate();
    if (priority) task.priority = priority;
    if (dueDate) task.dueDate = dueDate;
    this.saved.emit(task);
    this.text.set('');
    this.ignoredDates.set([]);
    this.manualDue.set(undefined);
    this.manualPriority.set(undefined);
    this.field().nativeElement.value = '';
  }
}
