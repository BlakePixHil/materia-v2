import {
  afterNextRender,
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { can, OrgContext } from '@materia/data-access';
import {
  matterDetailRepository,
  MEMBER_LIST_QUERY,
  membersRepository,
  myOpenTasksQuery,
  personalTaskRepository,
  taskGroupRepository,
} from '@materia/data-access/repository';
import { MatterTypeSchema, sectionMyTasks, type MatterType, type Priority, type TaskStatus } from '@materia/domain';
import {
  MATTER_TYPE_LABELS,
  MT_MENU,
  MT_TODAY,
  MtButton,
  MtEmptyState,
  MtIcon,
  MtNote,
  ToastService,
} from '@materia/ui';

import { TaskActions } from './task-actions';
import { TaskList } from './task-list';
import { loadQuickAddParser, TaskQuickAdd, type QuickAddTask } from './task-quick-add';
import {
  orderAfterLast,
  PRIORITY_NAMES,
  PRIORITY_ORDER,
  taskEntry,
  type TaskEntry,
  type TaskMatterRef,
  type TaskSectionVm,
} from './task-view';
import { TasksBulkBar } from './tasks-bulk-bar';
import { errorCopy } from '../../core/error-copy';
import { ShortcutService } from '../../core/shortcuts/shortcut.service';

/** The type filter's option for personal tasks (they're on no matter). */
const PERSONAL = 'personal';
type TypeFilter = MatterType | typeof PERSONAL;

/** Sections the Today screen shows; the rest are on `/tasks`. */
const TODAY_SECTIONS = new Set(['overdue', 'today', 'this_week']);

/**
 * My tasks (CORE-08): every open task assigned to me across matters, and my personal tasks, from
 * the `tasks` collection group, in Overdue, Today, This week, Later and No date (today in the org's
 * time zone). Filters by matter type and priority; `c` adds a personal task. `compact` (the Today
 * screen) shows only what's due this week, without filters.
 */
@Component({
  selector: 'mt-my-tasks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  providers: [TaskActions],
  imports: [MT_MENU, MtButton, MtEmptyState, MtIcon, MtNote, RouterLink, TaskList, TaskQuickAdd, TasksBulkBar],
  host: { class: 'mt-my-tasks' },
  template: `
    @if (!compact()) {
      <div class="bar" role="group" aria-label="Filters">
        <button
          type="button"
          class="mt-chip"
          [attr.data-selected]="types().length ? '' : null"
          [mtMenuTrigger]="typeMenu"
        >
          {{ typeText() }}<mt-icon name="chevron-down" />
        </button>
        <button
          type="button"
          class="mt-chip"
          [attr.data-selected]="priorities().length ? '' : null"
          [mtMenuTrigger]="priorityMenu"
        >
          {{ priorityText() }}<mt-icon name="chevron-down" />
        </button>
        @if (types().length || priorities().length) {
          <button mtButton variant="ghost" size="sm" (click)="clearFilters()">Clear filters</button>
        }
        <button
          #addButton
          class="mt-ml"
          mtButton
          variant="primary"
          size="sm"
          iconStart="plus"
          kbd="c"
          (click)="adding.set(true)"
        >
          Add personal task
        </button>
      </div>
      @if (adding()) {
        <mt-task-quick-add
          [personal]="true"
          label="New personal task"
          placeholder="Task title, !priority, due date"
          (saved)="create($event)"
          (closed)="closeQuickAdd()"
        />
      }
    }
    @switch (tasks.status()) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading your tasks…</p>
      }
      @case ('error') {
        <mt-note tone="danger">
          {{ loadError() }}
          <button mtButton size="sm" (click)="tasks.refresh()">Try again</button>
        </mt-note>
      }
      @default {
        @if (sections().length) {
          <mt-task-list [sections]="sections()" [headingLevel]="headingLevel()" [(selection)]="selection" />
        } @else if (filtered()) {
          <mt-empty-state
            icon="search"
            title="No tasks match"
            description="Nothing assigned to you matches these filters."
            [headingLevel]="headingLevel()"
          >
            <button mtButton size="sm" (click)="clearFilters()">Clear filters</button>
          </mt-empty-state>
        } @else {
          <mt-empty-state
            icon="check-circle"
            [title]="compact() ? 'Nothing due this week' : 'Nothing assigned to you'"
            [description]="
              compact()
                ? 'Tasks due later or without a date are in My tasks.'
                : 'Open tasks assigned to you, and your personal tasks, show here.'
            "
            [headingLevel]="headingLevel()"
          >
            @if (compact()) {
              <a mtButton size="sm" routerLink="/tasks">Open my tasks</a>
            }
          </mt-empty-state>
        }
      }
    }
    @if (selectedEntries().length) {
      <mt-tasks-bulk-bar
        [count]="selectedEntries().length"
        [people]="assignable()"
        [busy]="actions.busy()"
        (status)="setStatus($event)"
        (assign)="assign($event)"
        (dueDate)="actions.changeDueDate(selectedEntries())"
        (priority)="setPriority($event)"
        (remove)="remove()"
        (clear)="selection.set([])"
      />
    }

    <ng-template #typeMenu>
      <mt-menu aria-label="Matter type">
        @for (type of typeOptions; track type) {
          <button mtMenuItemCheckbox [checked]="types().includes(type)" (checkedChange)="toggleType(type, $event)">
            {{ typeLabel(type) }}
          </button>
        }
      </mt-menu>
    </ng-template>
    <ng-template #priorityMenu>
      <mt-menu aria-label="Priority">
        @for (priority of priorityOptions; track priority) {
          <button
            mtMenuItemCheckbox
            [checked]="priorities().includes(priority)"
            (checkedChange)="togglePriority(priority, $event)"
          >
            {{ priorityNames[priority] }}
          </button>
        }
      </mt-menu>
    </ng-template>
  `,
  styles: `
    .mt-my-tasks {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      min-width: 0;
    }
    .mt-my-tasks .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-6);
    }
    .mt-my-tasks .mt-chip {
      display: inline-flex;
      align-items: center;
      gap: var(--space-6);
      height: 28px;
      padding: 0 10px;
      border-radius: var(--radius-full);
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      font: 500 12px/16px var(--font-sans);
      color: var(--text-secondary);
      cursor: pointer;
      white-space: nowrap;
    }
    .mt-my-tasks .mt-chip[data-selected] {
      background: var(--bg-selected);
      border-color: var(--border-focus);
      color: var(--text-brand);
    }
    .mt-my-tasks .mt-chip:focus-visible {
      box-shadow: var(--focus-ring);
      outline: none;
    }
    .mt-my-tasks .mt-chip mt-icon {
      width: 13px;
      height: 13px;
    }
  `,
})
export class MyTasks {
  /** The Today screen's short version: this week's sections, no filters or quick-add. */
  readonly compact = input(false, { transform: booleanAttribute });
  readonly headingLevel = input(2);

  protected readonly actions = inject(TaskActions);
  private readonly context = inject(OrgContext);
  private readonly today = inject(MT_TODAY);
  private readonly toasts = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly addButton = viewChild('addButton', { read: ElementRef<HTMLElement> });
  private readonly canEdit = can('task.edit');

  protected readonly tasks = taskGroupRepository().watchQuery(() => {
    const uid = this.context.uid();
    return uid ? myOpenTasksQuery(uid) : null;
  });
  protected readonly loadError = computed(() => errorCopy(this.tasks.error()));
  private readonly personal = personalTaskRepository();
  private readonly mattersRepo = matterDetailRepository();

  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 }, { live: false });
  private readonly memberList = computed(() =>
    this.members.value().map((m) => ({ uid: m.id, name: m.displayName, status: m.status, role: m.role })),
  );
  protected readonly assignable = computed(() =>
    this.memberList()
      .filter((m) => m.status === 'active' && m.role !== 'readonly')
      .map(({ uid, name }) => ({ uid, name })),
  );

  /** The matters the tasks are on, read once each (number, title and type). */
  private readonly matters = signal<ReadonlyMap<string, TaskMatterRef>>(new Map());
  private readonly requested = new Set<string>();

  protected readonly typeOptions: TypeFilter[] = [...MatterTypeSchema.options, PERSONAL];
  protected readonly priorityOptions = PRIORITY_ORDER;
  protected readonly priorityNames = PRIORITY_NAMES;
  protected readonly types = signal<readonly TypeFilter[]>([]);
  protected readonly priorities = signal<readonly Priority[]>([]);
  protected readonly filtered = computed(() => !this.compact() && this.types().length + this.priorities().length > 0);
  protected readonly adding = signal(false);
  protected readonly selection = signal<readonly string[]>([]);

  private readonly entries = computed<TaskEntry[]>(() => {
    const members = this.memberList();
    const matters = this.matters();
    const canEdit = this.canEdit();
    const types = this.compact() ? [] : this.types();
    const priorities = this.compact() ? [] : this.priorities();
    return this.tasks
      .value()
      .filter((task) => !priorities.length || priorities.includes(task.priority))
      .map((task) => {
        const matterId = task.matterId ?? null;
        const matter = matterId ? (matters.get(matterId) ?? { id: matterId, number: '', title: '' }) : null;
        return taskEntry(task, { members, canEdit, matter });
      })
      .filter((entry) => {
        if (!types.length) return true;
        if (!entry.matter) return types.includes(PERSONAL);
        return !!entry.matter.type && types.includes(entry.matter.type);
      });
  });
  protected readonly sections = computed<TaskSectionVm[]>(() => {
    const byKey = new Map(this.entries().map((entry) => [entry.key, entry] as const));
    const rows = this.entries().map((entry) => ({ ...entry.task, id: entry.key }));
    return sectionMyTasks(rows, this.today())
      .filter((section) => section.tasks.length && (!this.compact() || TODAY_SECTIONS.has(section.id)))
      .map((section) => ({
        id: section.id,
        label: section.label,
        entries: section.tasks.map((row) => byKey.get(row.id) as TaskEntry),
      }));
  });
  protected readonly selectedEntries = computed(() => {
    const keys = new Set(this.selection());
    return this.entries().filter((entry) => keys.has(entry.key));
  });

  protected readonly typeText = computed(() => {
    const types = this.types();
    if (!types.length) return 'Matter type';
    return types.length === 1 ? this.typeLabel(types[0] as TypeFilter) : `Matter type: ${types.length}`;
  });
  protected readonly priorityText = computed(() => {
    const priorities = this.priorities();
    if (!priorities.length) return 'Priority';
    return priorities.length === 1 ? PRIORITY_NAMES[priorities[0] as Priority] : `Priority: ${priorities.length}`;
  });

  constructor() {
    // Quick-add understands its tokens even if the connection drops before it's first opened.
    afterNextRender(() => {
      if (!this.compact()) loadQuickAddParser().catch(() => undefined);
    });
    effect(() => {
      const ids = [
        ...new Set(
          this.tasks
            .value()
            .map((task) => task.matterId)
            .filter((id): id is string => !!id),
        ),
      ].filter((id) => !this.requested.has(id));
      if (!ids.length) return;
      ids.forEach((id) => this.requested.add(id));
      untracked(() => void this.loadMatters(ids));
    });
    const shortcuts = inject(ShortcutService);
    const cleanups = [
      shortcuts.register({
        combo: 'c',
        description: 'Add a personal task',
        group: 'Tasks',
        scope: 'route',
        when: () => !this.compact(),
        handler: () => this.adding.set(true),
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
  }

  protected typeLabel(type: TypeFilter): string {
    return type === PERSONAL ? 'Personal' : MATTER_TYPE_LABELS[type];
  }

  private async loadMatters(ids: string[]): Promise<void> {
    const found = await Promise.all(ids.map((id) => this.mattersRepo.get(id).catch(() => null)));
    this.matters.update((map) => {
      const next = new Map(map);
      found.forEach((matter, i) => {
        const id = ids[i] as string;
        next.set(
          id,
          matter
            ? { id, number: matter.number, title: matter.title, type: matter.type }
            : { id, number: 'Restricted', title: 'Restricted matter' },
        );
      });
      return next;
    });
  }

  protected toggleType(type: TypeFilter, on: boolean): void {
    this.types.update((list) => (on ? [...new Set([...list, type])] : list.filter((t) => t !== type)));
  }

  protected togglePriority(priority: Priority, on: boolean): void {
    this.priorities.update((list) => (on ? [...new Set([...list, priority])] : list.filter((p) => p !== priority)));
  }

  protected clearFilters(): void {
    this.types.set([]);
    this.priorities.set([]);
  }

  protected closeQuickAdd(): void {
    this.adding.set(false);
    afterNextRender(() => this.addButton()?.nativeElement.focus(), { injector: this.injector });
  }

  /** A personal task (only I see it). Not awaited: offline, it's saved when back online. */
  protected create(task: QuickAddTask): void {
    const own = this.tasks.value().filter((t) => !t.matterId);
    this.personal
      .create({ ...task, status: 'todo', order: orderAfterLast(own) })
      .catch((error: unknown) =>
        this.toasts.show({ title: 'The task didn’t save', description: errorCopy(error), tone: 'danger' }),
      );
    this.actions.announcement.set(`Added ${task.title}.`);
  }

  protected setStatus(status: TaskStatus): void {
    void this.actions.setStatus(this.selectedEntries(), status);
  }

  protected assign(uid: string | null): void {
    const name = this.assignable().find((p) => p.uid === uid)?.name;
    void this.actions.bulk(this.selectedEntries(), { op: 'assignee', assigneeUid: uid }, name);
  }

  protected setPriority(priority: Priority): void {
    void this.actions.bulk(this.selectedEntries(), { op: 'priority', priority });
  }

  protected async remove(): Promise<void> {
    if (await this.actions.remove(this.selectedEntries())) this.selection.set([]);
  }
}
