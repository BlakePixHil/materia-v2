import { CdkDrag, CdkDragHandle, CdkDropList, CdkDropListGroup, type CdkDragDrop } from '@angular/cdk/drag-drop';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { MtIcon, MtIconButton, MtTaskRow } from '@materia/ui';

import { TaskActions } from './task-actions';
import { TaskDetails } from './task-details';
import type { TaskEntry, TaskSectionVm } from './task-view';
import { isEditable, ShortcutService } from '../../core/shortcuts/shortcut.service';

/** How long focus follows a moved task while the list catches up with the write. */
const FOLLOW_MS = 1500;

/**
 * A list of tasks in sections (CORE-08), for the matter's Tasks tab and My tasks. Keyboard, with
 * focus on a task's title: ↓/↑ or j/k move between tasks, `x` selects (Ctrl/⌘+A selects them all),
 * Space completes or reopens,
 * Enter edits the title, Alt+↑/↓ moves the task within its section (announced politely), Escape
 * clears the selection. With `reorderable`, tasks drag by their handle within and between sections.
 * Writes go through the page's `TaskActions`.
 */
@Component({
  selector: 'mt-task-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [
    CdkDrag,
    CdkDragHandle,
    CdkDropList,
    CdkDropListGroup,
    MtIcon,
    MtIconButton,
    MtTaskRow,
    RouterLink,
    TaskDetails,
  ],
  host: { class: 'mt-task-list', '(keydown)': 'onHostKey($event)' },
  template: `
    <div cdkDropListGroup class="sections">
      @for (section of sections(); track section.id) {
        <section class="section" [attr.data-section]="section.id" [attr.aria-labelledby]="headingId(section)">
          <div class="head-row">
            <span class="rail rail-head">
              <input
                type="checkbox"
                class="select"
                [checked]="sectionState(section) === 'all'"
                [indeterminate]="sectionState(section) === 'some'"
                [attr.aria-label]="'Select every task in ' + section.label"
                title="Select all"
                (change)="toggleSection(section)"
              />
            </span>
            <div class="head" role="heading" [attr.aria-level]="headingLevel()" [id]="headingId(section)">
              {{ section.label }} <span class="count">{{ section.entries.length }}</span>
            </div>
          </div>
          <ul
            class="rows"
            cdkDropList
            [cdkDropListData]="section"
            [cdkDropListDisabled]="!reorderable()"
            [cdkDropListEnterPredicate]="canEnter"
            (cdkDropListDropped)="dropped($event)"
            [attr.aria-labelledby]="headingId(section)"
          >
            @for (entry of section.entries; track entry.key) {
              <li
                class="row"
                cdkDrag
                [cdkDragData]="entry"
                [cdkDragDisabled]="!reorderable() || !entry.editable"
                [attr.data-key]="entry.key"
                [attr.data-selected]="selected().has(entry.key) ? '' : null"
              >
                <span class="rail">
                  <input
                    type="checkbox"
                    class="select"
                    [checked]="selected().has(entry.key)"
                    [attr.aria-label]="'Select ' + entry.task.title"
                    (change)="toggle(entry)"
                  />
                </span>
                <div class="body">
                  <div class="line">
                    @if (reorderable()) {
                      <span class="handle" cdkDragHandle aria-hidden="true" title="Drag to reorder">
                        <mt-icon name="updown" [size]="14" />
                      </span>
                    }
                    <mt-task-row
                      [task]="entry.vm"
                      [editable]="entry.editable"
                      [disabled]="!entry.editable"
                      (done)="actions.toggleDone(entry)"
                      (titleChange)="actions.rename(entry, $event)"
                      (open)="expand(entry)"
                    />
                    @if (entry.matter; as matter) {
                      <a
                        class="matter caption"
                        [routerLink]="['/matters', matter.id, 'tasks']"
                        [attr.aria-label]="
                          matter.number ? 'Open ' + matter.number + ' ' + matter.title : 'Open the matter'
                        "
                        >{{ matter.number || 'Open the matter' }}</a
                      >
                    }
                    <button
                      mtIconButton
                      size="sm"
                      [icon]="expanded().has(entry.key) ? 'chevron-down' : 'chevron-right'"
                      [label]="'Details: ' + entry.task.title"
                      [tooltip]="false"
                      [attr.aria-expanded]="expanded().has(entry.key)"
                      (click)="expand(entry)"
                    ></button>
                  </div>
                  @if (expanded().has(entry.key)) {
                    <mt-task-details
                      [entry]="entry"
                      (checklist)="actions.setChecklist(entry, $event)"
                      (status)="actions.setStatus([entry], $event)"
                      (priority)="actions.bulk([entry], { op: 'priority', priority: $event })"
                      (dueDate)="actions.changeDueDate([entry])"
                    />
                  }
                </div>
              </li>
            }
          </ul>
        </section>
      }
    </div>
    <div class="mt-sr" aria-live="polite" aria-atomic="true">{{ actions.announcement() }}</div>
  `,
  styles: `
    .mt-task-list .sections {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
    }
    .mt-task-list .head-row {
      display: flex;
      align-items: stretch;
    }
    .mt-task-list .head {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      padding: var(--space-4) var(--space-8);
      font: 600 13px/18px var(--font-sans);
      color: var(--text-secondary);
    }
    .mt-task-list .count {
      font-weight: 400;
      color: var(--text-tertiary);
    }
    .mt-task-list .rows {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      min-height: 8px;
    }
    /* Bulk selection lives in its own slate column, apart from the round done check. */
    .mt-task-list .rail {
      flex: none;
      display: flex;
      justify-content: center;
      width: 32px;
      background: var(--bg-sunken);
      border-inline-end: 1px solid var(--border-subtle);
    }
    .mt-task-list .rail-head {
      align-items: center;
      border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    }
    .mt-task-list .rows > .row:last-child > .rail {
      border-radius: 0 0 var(--radius-sm) var(--radius-sm);
    }
    .mt-task-list .rows > .row > .rail {
      align-items: flex-start;
      padding-top: calc((var(--row) - 14px) / 2);
    }
    .mt-task-list .row {
      display: flex;
      background: var(--bg-surface);
    }
    .mt-task-list .row > .body {
      flex: 1;
      min-width: 0;
      border-radius: var(--radius-sm);
    }
    .mt-task-list .row[data-selected] > .body,
    .mt-task-list .row[data-selected] > .rail {
      background: var(--bg-selected);
    }
    .mt-task-list mt-task-row .mt-check {
      border-radius: 50%;
    }
    .mt-task-list .line {
      display: flex;
      align-items: center;
      gap: var(--space-4);
      min-width: 0;
    }
    .mt-task-list .line > mt-task-row {
      flex: 1;
      min-width: 0;
    }
    .mt-task-list .handle {
      display: inline-flex;
      color: var(--icon-default);
      cursor: grab;
      padding: var(--space-4) 0 var(--space-4) var(--space-4);
    }
    .mt-task-list .select {
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: var(--border-focus);
    }
    .mt-task-list .matter {
      white-space: nowrap;
      color: var(--text-link, var(--text-brand));
    }
    .mt-task-list .cdk-drag-preview {
      box-shadow: var(--shadow-dialog);
      background: var(--bg-surface);
      border-radius: var(--radius-sm);
    }
    .mt-task-list .cdk-drag-placeholder {
      opacity: 0.4;
    }
    .mt-task-list .cdk-drag-animating,
    .mt-task-list .rows.cdk-drop-list-dragging .row:not(.cdk-drag-placeholder) {
      transition: transform 200ms ease;
    }
    @media (prefers-reduced-motion: reduce) {
      .mt-task-list .cdk-drag-animating,
      .mt-task-list .rows.cdk-drop-list-dragging .row:not(.cdk-drag-placeholder) {
        transition: none;
      }
    }
  `,
})
export class TaskList {
  readonly sections = input.required<readonly TaskSectionVm[]>();
  /** Tasks can be moved (Alt+↑/↓ and drag). */
  readonly reorderable = input(false);
  /** The level of the section headings. */
  readonly headingLevel = input(3);
  /** Selected task keys (`x`). */
  readonly selection = model<readonly string[]>([]);

  protected readonly actions = inject(TaskActions);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly selected = computed(() => new Set(this.selection()));
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  private readonly flat = computed(() => this.sections().flatMap((section) => section.entries));
  /** A moved task keeps focus while the list re-renders around it. */
  private follow: { key: string; until: number } | null = null;

  /** Tasks only move into sections that take a group. */
  protected readonly canEnter = (drag: CdkDrag<TaskEntry>, drop: CdkDropList<TaskSectionVm>) =>
    drag.dropContainer === drop || drop.data.group !== undefined;

  constructor() {
    effect(() => {
      this.sections();
      untracked(() => afterNextRender(() => this.keepFocus(), { injector: this.injector }));
    });
    // Selected tasks that leave the list (completed in My tasks, deleted) leave the selection.
    effect(() => {
      const keys = new Set(this.flat().map((entry) => entry.key));
      const current = untracked(this.selection);
      const kept = current.filter((key) => keys.has(key));
      if (kept.length !== current.length) untracked(() => this.selection.set(kept));
    });
    // j/k from outside the list jump into it.
    const shortcuts = inject(ShortcutService);
    const has = () => this.flat().length > 0;
    const cleanups = [
      shortcuts.register({
        combo: 'j',
        description: 'Next task',
        group: 'Tasks',
        scope: 'component',
        when: has,
        handler: () => this.focusAt(0),
      }),
      shortcuts.register({
        combo: 'k',
        description: 'Previous task',
        group: 'Tasks',
        scope: 'component',
        when: has,
        handler: () => this.focusAt(this.flat().length - 1),
      }),
      // Listed in the cheat sheet; the focused task handles them.
      ...[
        ['x', 'Select the focused task'],
        ['mod+a', 'Select every listed task'],
        ['space', 'Complete or reopen the focused task'],
        ['alt+up', 'Move the focused task up'],
        ['alt+down', 'Move the focused task down'],
      ].map(([combo, description]) =>
        shortcuts.register({
          combo: combo as string,
          description: description as string,
          group: 'Tasks',
          scope: 'component',
          when: () => false,
          handler: () => undefined,
        }),
      ),
    ];
    inject(DestroyRef).onDestroy(() => cleanups.forEach((cleanup) => cleanup()));
  }

  protected headingId(section: TaskSectionVm): string {
    return `mt-tasks-${section.id.replace(/[^a-z0-9-]/gi, '-')}`;
  }

  protected toggle(entry: TaskEntry): void {
    const current = this.selection();
    this.selection.set(
      current.includes(entry.key) ? current.filter((key) => key !== entry.key) : [...current, entry.key],
    );
  }

  /** Whether none, some or all of a section's tasks are selected (the rail header's state). */
  protected sectionState(section: TaskSectionVm): 'none' | 'some' | 'all' {
    const picked = section.entries.filter((entry) => this.selected().has(entry.key)).length;
    if (!picked) return 'none';
    return picked === section.entries.length ? 'all' : 'some';
  }

  /** The rail header: selects every task in the section, or clears them when all are selected. */
  protected toggleSection(section: TaskSectionVm): void {
    const keys = section.entries.map((entry) => entry.key);
    const all = this.sectionState(section) === 'all';
    const rest = this.selection().filter((key) => !keys.includes(key));
    this.selection.set(all ? rest : [...rest, ...keys]);
  }

  /** Ctrl/⌘+A on a task: every listed task is selected (again: none). */
  private selectAll(): void {
    const keys = this.flat().map((entry) => entry.key);
    const all = keys.length > 0 && keys.every((key) => this.selected().has(key));
    this.selection.set(all ? [] : keys);
    this.say(all ? 'Selection cleared.' : `${keys.length === 1 ? '1 task' : `${keys.length} tasks`} selected.`);
  }

  protected expand(entry: TaskEntry): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (next.has(entry.key)) next.delete(entry.key);
      else next.add(entry.key);
      return next;
    });
  }

  /** Keys pressed inside a task's row (they bubble up from its title, checkbox or buttons). */
  protected onHostKey(event: KeyboardEvent): void {
    const row = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('li.row');
    const key = row?.dataset['key'];
    if (!key) return;
    for (const section of this.sections()) {
      const index = section.entries.findIndex((e) => e.key === key);
      const entry = section.entries[index];
      if (entry) {
        this.onKey(event, section, entry, index);
        return;
      }
    }
  }

  private onKey(event: KeyboardEvent, section: TaskSectionVm, entry: TaskEntry, index: number): void {
    if (event.isComposing || isEditable(event.target)) return;
    const { key } = event;
    if (event.altKey && !event.ctrlKey && !event.metaKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      event.preventDefault();
      this.moveBy(section, entry, index, key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && key.toLowerCase() === 'a') {
      event.preventDefault();
      this.selectAll();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const at = this.flat().findIndex((e) => e.key === entry.key);
    const onTitle = (event.target as HTMLElement).classList?.contains('mt-task-title');
    let handled = true;
    switch (key) {
      case 'ArrowDown':
      case 'j':
        this.focusAt(Math.min(at + 1, this.flat().length - 1));
        break;
      case 'ArrowUp':
      case 'k':
        this.focusAt(Math.max(at - 1, 0));
        break;
      case 'Home':
        this.focusAt(0);
        break;
      case 'End':
        this.focusAt(this.flat().length - 1);
        break;
      case 'x':
        this.toggle(entry);
        break;
      case ' ':
        // On the title, Space completes; on a checkbox or button it does what it always does.
        if (onTitle) void this.actions.toggleDone(entry);
        else handled = false;
        break;
      case 'Escape':
        if (this.selection().length) this.selection.set([]);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  }

  private moveBy(section: TaskSectionVm, entry: TaskEntry, index: number, delta: -1 | 1): void {
    if (!this.reorderable()) return;
    if (!entry.editable) {
      this.say('You can’t move this task.');
      return;
    }
    const to = index + delta;
    if (to < 0 || to >= section.entries.length) {
      this.say(`${entry.task.title} is already ${delta < 0 ? 'first' : 'last'} in ${section.label}.`);
      return;
    }
    this.follow = { key: entry.key, until: Date.now() + FOLLOW_MS };
    this.actions.move(section, entry, to);
  }

  private say(message: string): void {
    this.actions.announcement.set('');
    queueMicrotask(() => this.actions.announcement.set(message));
  }

  protected dropped(event: CdkDragDrop<TaskSectionVm, TaskSectionVm, TaskEntry>): void {
    const entry = event.item.data;
    const target = event.container.data;
    this.follow = { key: entry.key, until: Date.now() + FOLLOW_MS };
    if (event.previousContainer === event.container) {
      if (event.previousIndex !== event.currentIndex) this.actions.move(target, entry, event.currentIndex);
    } else {
      this.actions.moveTo(target, entry, event.currentIndex);
    }
  }

  /** Focuses a task's title (or its row's first control while the title is being edited). */
  focusAt(index: number): void {
    const entry = this.flat()[index];
    if (entry) this.titleOf(entry.key)?.focus();
  }

  private titleOf(key: string): HTMLElement | null {
    const row = [...this.host.nativeElement.querySelectorAll<HTMLElement>('li.row')].find(
      (li) => li.dataset['key'] === key,
    );
    return row?.querySelector<HTMLElement>('.mt-task-title') ?? null;
  }

  private keepFocus(): void {
    if (!this.follow) return;
    if (Date.now() > this.follow.until) {
      this.follow = null;
      return;
    }
    const active = document.activeElement;
    // Someone who has moved on elsewhere keeps their focus.
    if (active && active !== document.body && !this.host.nativeElement.contains(active)) return;
    const title = this.titleOf(this.follow.key);
    if (title && active !== title) title.focus();
  }
}
