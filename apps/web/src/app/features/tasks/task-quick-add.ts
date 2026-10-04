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
import { formatDateOnly, MT_ORG_TIMEZONE, MtKbd } from '@materia/ui';

import { PRIORITY_NAMES, type TaskPerson } from './task-view';

/** What the quick-add line saves: a title and whatever the tokens set. */
export interface QuickAddTask {
  title: string;
  assigneeUid?: string;
  priority?: Priority;
  dueDate?: DateOnly;
}

type Parse = (typeof import('./quick-add-parser'))['parseQuickAdd'];

/**
 * The parser brings chrono-node, so it loads in its own chunk: preloaded when a task list opens (so
 * quick-add still understands tokens after going offline), and retried if the fetch failed.
 */
let parser: Promise<Parse> | null = null;
export function loadQuickAddParser(): Promise<Parse> {
  parser ??= import('./quick-add-parser')
    .then((m) => m.parseQuickAdd)
    .catch((error: unknown) => {
      parser = null;
      throw error;
    });
  return parser;
}

/** A piece of the typed line: plain text or a recognised token. */
interface Segment {
  text: string;
  kind: 'assignee' | 'priority' | 'due' | 'unresolved' | null;
}

/**
 * The tasks quick-add line (CORE-08), opened with `c`: `Lodge the inventory @jordan !high due fri`
 * becomes a task with an assignee, a priority and a due date. Recognised parts are highlighted as
 * you type, with what they mean underneath; names that match nobody (or several people) are
 * pointed out. Enter saves and keeps the line open for the next task; Escape closes it.
 */
@Component({
  selector: 'mt-task-quick-add',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/input.css'],
  imports: [MtKbd],
  host: { class: 'mt-quick-add' },
  template: `
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
    <p class="caption t-2 summary" [id]="ids.summary">{{ summary() }}</p>
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
        Type !high for priority and due fri for a due date.
      } @else {
        Type @name to assign, !high for priority and due fri for a due date.
      }
      <mt-kbd keys="enter" /> saves, <mt-kbd keys="esc" /> closes.
    </p>
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
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  protected readonly text = signal('');
  protected readonly error = signal<string | null>(null);
  private readonly parse = signal<Parse | null>(null);

  protected readonly result = computed<QuickAddResult>(() => {
    const text = this.text();
    const parse = this.parse();
    const fallback: QuickAddResult = { title: text.replace(/\s+/g, ' ').trim(), tokens: [], unresolved: [] };
    if (!parse || !text.trim()) return fallback;
    const members = this.personal() ? [] : this.members().map((m) => ({ uid: m.uid, displayName: m.name }));
    return parse(text, { members, now: new Date(), timeZone: this.timeZone });
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
    if (result.priority)
      parts.push(`${PRIORITY_NAMES[result.priority]}${result.priority === 'none' ? '' : ' priority'}`);
    if (result.dueDate) parts.push(`Due ${formatDateOnly(result.dueDate, this.timeZone)}`);
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
      (parse) => this.parse.set(parse),
      () => undefined,
    );
    afterNextRender(() => this.focus());
  }

  focus(): void {
    this.field().nativeElement.focus();
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
    if (result.priority) task.priority = result.priority;
    if (result.dueDate) task.dueDate = result.dueDate;
    this.saved.emit(task);
    this.text.set('');
    this.field().nativeElement.value = '';
  }
}
