import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can } from '@materia/data-access';
import { forMatter, MATTER_TASKS_QUERY, matterTaskRepository } from '@materia/data-access/repository';
import { isOpenTask, type Priority, type TaskStatus } from '@materia/domain';
import {
  MtButton,
  MtEmptyState,
  MtNote,
  type MtOption,
  MtSegmentedControl,
  MtSkeleton,
  ToastService,
} from '@materia/ui';

import { MatterScreen } from './matter-screen';
import { duePendingText } from './matter-view';
import { onIntent } from '../../core/commands/intents';
import { errorCopy } from '../../core/error-copy';
import { ShortcutService } from '../../core/shortcuts/shortcut.service';
import { TaskActions } from '../tasks/task-actions';
import { TaskList } from '../tasks/task-list';
import { loadQuickAddParser, TaskQuickAdd, type QuickAddTask } from '../tasks/task-quick-add';
import {
  inOrder,
  isClosed,
  orderAfterLast,
  sectionsByGroup,
  sectionsByStage,
  taskEntry,
  tasksByGroup,
  uniqueGroups,
} from '../tasks/task-view';
import { TasksBulkBar } from '../tasks/tasks-bulk-bar';

type GroupBy = 'stage' | 'group';
const GROUP_BY_KEY = 'materia.tasks.groupBy';

function storedGroupBy(): GroupBy {
  try {
    return localStorage.getItem(GROUP_BY_KEY) === 'group' ? 'group' : 'stage';
  } catch {
    return 'stage';
  }
}

/**
 * A matter's Tasks tab (CORE-08): its tasks grouped by stage (template tasks carry their stage's
 * name) or by their own group, in their manual order. `c` opens the quick-add line; tasks are
 * completed, renamed, reordered, ticked and changed in bulk from the list; "Templates" adds a task
 * group template's tasks (CORE-08f). Listens to the matter's tasks only while this tab is shown.
 */
@Component({
  selector: 'mt-matter-tasks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  providers: [TaskActions],
  imports: [
    FormsModule,
    MtButton,
    MtEmptyState,
    MtNote,
    MtSegmentedControl,
    MtSkeleton,
    TaskList,
    TaskQuickAdd,
    TasksBulkBar,
  ],
  host: { class: 'mt-matter-tasks' },
  template: `
    <div class="mt-row head">
      <h2 class="title-m">Tasks</h2>
      <span class="caption t-3">{{ openCount() === 1 ? '1 open' : openCount() + ' open' }}</span>
      <span class="mt-ml tools">
        <button
          type="button"
          class="mt-chip"
          [attr.aria-pressed]="hideDone()"
          [attr.data-selected]="hideDone() ? '' : null"
          (click)="hideDone.set(!hideDone())"
        >
          Hide done
        </button>
        <mt-segmented-control
          label="Group tasks by"
          [options]="groupOptions"
          [ngModel]="groupBy()"
          (ngModelChange)="setGroupBy($event)"
        />
        @if (canEdit()) {
          <button
            mtButton
            variant="secondary"
            size="sm"
            iconStart="list"
            aria-label="Task group templates"
            (click)="openTemplates()"
          >
            Templates
          </button>
          <button #addButton mtButton variant="primary" size="sm" iconStart="plus" kbd="c" (click)="openQuickAdd()">
            Add task
          </button>
        }
      </span>
    </div>
    @if (adding()) {
      <mt-task-quick-add [members]="screen.assignees()" (saved)="create($event)" (closed)="closeQuickAdd()" />
    }
    @switch (tasks.status()) {
      @case ('loading') {
        <mt-skeleton label="Loading tasks…" />
      }
      @case ('error') {
        <mt-note tone="danger">
          {{ loadError() }}
          <button mtButton size="sm" (click)="tasks.refresh()">Try again</button>
        </mt-note>
      }
      @default {
        @if (sections().length) {
          @if (groupBy() === 'group' && !groupNames().length && canEdit()) {
            <p class="caption t-3 hint">
              No groups yet. Open a task’s details to give it a group, or select tasks and choose Group.
            </p>
          }
          <mt-task-list
            [sections]="sections()"
            [reorderable]="canEdit()"
            [headingLevel]="3"
            [groups]="groupSuggestions()"
            [(selection)]="selection"
          />
        } @else {
          <mt-empty-state
            icon="check-circle"
            [title]="tasks.value().length ? 'Every task is done' : 'No tasks yet'"
            [description]="
              canEdit()
                ? 'Press c to add one: a title, then @name, !priority or a due date.'
                : 'Tasks on this matter show here.'
            "
            [headingLevel]="3"
          />
        }
      }
    }
    @if (selectedEntries().length) {
      <mt-tasks-bulk-bar
        [count]="selectedEntries().length"
        [people]="screen.assignees()"
        [busy]="actions.busy()"
        (status)="setStatus($event)"
        (assign)="assign($event)"
        (dueDate)="actions.changeDueDate(selectedEntries())"
        (priority)="setPriority($event)"
        [groupable]="true"
        (group)="actions.changeGroup(selectedEntries(), groupSuggestions())"
        (remove)="remove()"
        (clear)="selection.set([])"
      />
    }
  `,
  styles: `
    .mt-matter-tasks {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      max-width: 960px;
    }
    .mt-matter-tasks .head {
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-8);
    }
    .mt-matter-tasks h2 {
      margin: 0;
    }
    .mt-matter-tasks .hint {
      margin: 0;
    }
    .mt-matter-tasks .tools {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-8);
    }
    .mt-matter-tasks .mt-chip {
      display: inline-flex;
      align-items: center;
      height: 28px;
      padding: 0 10px;
      border-radius: var(--radius-full);
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      font: 500 12px/16px var(--font-sans);
      color: var(--text-secondary);
      cursor: pointer;
    }
    .mt-matter-tasks .mt-chip[data-selected] {
      background: var(--bg-selected);
      border-color: var(--border-focus);
      color: var(--text-brand);
    }
    .mt-matter-tasks .mt-chip:focus-visible {
      box-shadow: var(--focus-ring);
      outline: none;
    }
  `,
})
export class MatterTasks {
  protected readonly screen = inject(MatterScreen);
  protected readonly actions = inject(TaskActions);
  private readonly toasts = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly id = this.screen.id;
  private readonly repo = matterTaskRepository(this.id);
  private readonly addButton = viewChild('addButton', { read: ElementRef<HTMLElement> });

  private readonly canTask = can('task.edit');
  protected readonly canEdit = computed(() => this.canTask() && !this.screen.readOnly());

  protected readonly tasks = this.repo.watchQuery(forMatter(this.id, MATTER_TASKS_QUERY));
  protected readonly loadError = computed(() => errorCopy(this.tasks.error()));
  protected readonly openCount = computed(() => this.tasks.value().filter((task) => isOpenTask(task)).length);

  protected readonly groupOptions: MtOption<GroupBy>[] = [
    { value: 'stage', label: 'Stage' },
    { value: 'group', label: 'Group' },
  ];
  protected readonly groupBy = signal<GroupBy>(storedGroupBy());
  protected readonly hideDone = signal(false);
  protected readonly adding = signal(false);
  protected readonly selection = signal<readonly string[]>([]);

  private readonly entries = computed(() => {
    const members = this.screen.memberList();
    const canEdit = this.canEdit();
    return inOrder(this.tasks.value())
      .filter((task) => !this.hideDone() || !isClosed(task.status))
      .map((task) => taskEntry(task, { members, canEdit, note: duePendingText(task) }));
  });
  protected readonly sections = computed(() =>
    this.groupBy() === 'stage'
      ? sectionsByStage(this.entries(), this.screen.stages())
      : sectionsByGroup(this.entries()),
  );
  /** The groups on this matter's tasks, in list order (CORE-08e). */
  protected readonly groupNames = computed(() => uniqueGroups(inOrder(this.tasks.value()).map((task) => task.group)));
  /** What the Group field and dialog suggest: the groups, then the stages not already among them. */
  protected readonly groupSuggestions = computed(() =>
    uniqueGroups([...this.groupNames(), ...this.screen.stages().map((stage) => stage.title)]),
  );
  protected readonly selectedEntries = computed(() => {
    const keys = new Set(this.selection());
    return this.entries().filter((entry) => keys.has(entry.key));
  });

  constructor() {
    // Quick-add understands its tokens even if the connection drops before it's first opened.
    loadQuickAddParser().catch(() => undefined);
    const shortcuts = inject(ShortcutService);
    const cleanups = [
      shortcuts.register({
        combo: 'c',
        description: 'Add a task',
        group: 'Tasks',
        scope: 'route',
        when: () => this.canEdit(),
        handler: () => this.openQuickAdd(),
      }),
      shortcuts.register({
        combo: 'esc',
        description: 'Clear the selected tasks',
        group: 'Tasks',
        scope: 'route',
        when: () => this.selection().length > 0,
        handler: () => this.selection.set([]),
      }),
    ];
    inject(DestroyRef).onDestroy(() => cleanups.forEach((cleanup) => cleanup()));
    // ⌘K's "Add task" on this matter (CORE-15).
    onIntent(
      'add-task',
      () => this.openQuickAdd(),
      () => !!this.screen.matter.value(),
    );
  }

  protected setGroupBy(value: GroupBy | null): void {
    const next = value === 'group' ? 'group' : 'stage';
    this.groupBy.set(next);
    try {
      localStorage.setItem(GROUP_BY_KEY, next);
    } catch {
      // Not remembered (private window); the default stands next time.
    }
  }

  protected openQuickAdd(): void {
    if (!this.canEdit()) return;
    this.adding.set(true);
  }

  protected closeQuickAdd(): void {
    this.adding.set(false);
    afterNextRender(() => this.addButton()?.nativeElement.focus(), { injector: this.injector });
  }

  /** Adds the task at the end of the list. Not awaited: offline, it's saved when back online. */
  protected create(task: QuickAddTask): void {
    const order = orderAfterLast(this.tasks.value());
    this.repo
      .create({ ...task, status: 'todo', order })
      .catch((error: unknown) =>
        this.toasts.show({ title: 'The task didn’t save', description: errorCopy(error), tone: 'danger' }),
      );
    this.actions.announcement.set(`Added ${task.title}.`);
  }

  /**
   * "Templates" (CORE-08f): picks a task group template (or saves one of this matter's groups as
   * one), then adds its tasks after the last task.
   */
  protected async openTemplates(): Promise<void> {
    if (!this.canEdit()) return;
    const template = await this.actions.openTaskGroupTemplates(tasksByGroup(inOrder(this.tasks.value())));
    const matterId = this.id();
    if (!template || !matterId) return;
    this.actions.addTaskGroup(matterId, template, orderAfterLast(this.tasks.value()));
  }

  protected setStatus(status: TaskStatus): void {
    void this.actions.setStatus(this.selectedEntries(), status);
  }

  protected assign(uid: string | null): void {
    const name = uid ? this.screen.memberName(uid) : undefined;
    void this.actions.bulk(this.selectedEntries(), { op: 'assignee', assigneeUid: uid }, name);
  }

  protected setPriority(priority: Priority): void {
    void this.actions.bulk(this.selectedEntries(), { op: 'priority', priority });
  }

  protected async remove(): Promise<void> {
    if (await this.actions.remove(this.selectedEntries())) this.selection.set([]);
  }
}
