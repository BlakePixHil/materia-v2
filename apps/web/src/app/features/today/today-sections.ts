import { ChangeDetectionStrategy, Component, computed, inject, ViewEncapsulation } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { can } from '@materia/data-access';
import { deadlineChangeSummary, deadlineTraceText, groupDueItems, type TodayEscalationLike } from '@materia/domain';
import {
  MtBadge,
  MtButton,
  MtDeadlineChip,
  MtEmptyState,
  MtIcon,
  MtIconButton,
  MtMatterTag,
  MtNote,
  MtSkeleton,
  MtTaskRow,
} from '@materia/ui';

import { TodayData } from './today-data';
import { dueState, matterLabel, taskLink, TODAY_COPY, type TodayChangeVm, type TodayDeadlineVm } from './today-view';
import { DeadlineActions } from '../deadlines/deadline-actions';
import type { ChangeRowVm, DeadlineRowVm } from '../deadlines/deadline-view';
import { TaskActions } from '../tasks/task-actions';
import type { TaskEntry } from '../tasks/task-view';

/*
 * The Today screen's cards (CORE-14). Every row a person can move to with j/k carries
 * `data-today-item` (with its kind and key); its link or title is what gets focus.
 */

const asDeadlineRow = (vm: TodayDeadlineVm): DeadlineRowVm => ({
  key: vm.rowKey,
  matterId: vm.matterId,
  deadline: vm.deadline,
  matter: vm.matter,
});
const asChangeRow = (vm: TodayChangeVm): ChangeRowVm => ({
  key: vm.rowKey,
  matterId: vm.matterId,
  change: vm.change,
  matter: vm.matter,
});

/** Shared by the cards: closing a deadline, completing a task, opening a task. */
abstract class TodayCard {
  protected readonly data = inject(TodayData);
  protected readonly deadlines = inject(DeadlineActions);
  protected readonly tasks = inject(TaskActions);
  private readonly router = inject(Router);
  protected readonly copy = TODAY_COPY;
  protected readonly canEdit = can('task.edit');
  protected readonly matterLabel = matterLabel;

  protected trace(vm: TodayDeadlineVm): string {
    return deadlineTraceText(vm.deadline);
  }

  protected async markDone(vm: TodayDeadlineVm): Promise<void> {
    if (await this.deadlines.complete(asDeadlineRow(vm), 'done')) this.data.refreshDeadlines();
  }

  protected acknowledge(row: TodayEscalationLike): void {
    void this.data.acknowledge(row);
  }

  protected complete(entry: TaskEntry): void {
    void this.tasks.complete([entry]);
  }

  protected openTask(entry: TaskEntry): void {
    void this.router.navigate(taskLink(entry));
  }

  protected taskLink = taskLink;
}

/** Needs attention: urgent changes, escalations, overdue deadlines, then the other changes (live). */
@Component({
  selector: 'mt-today-attention',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../../../../../libs/ui/src/generated/components/timeline.css',
    '../../../../../../libs/ui/src/generated/components/tl.css',
  ],
  imports: [MtBadge, MtButton, MtDeadlineChip, MtEmptyState, MtIcon, MtNote, MtSkeleton, RouterLink],
  host: {
    class: 'mt-card mt-today-card',
    role: 'region',
    'aria-labelledby': 'mt-today-attention',
    'data-pad': '',
    'data-section': 'attention',
  },
  template: `
    <div class="mt-card-h">
      <h2 class="mt-card-title" id="mt-today-attention">Needs attention</h2>
      @if (attention().items.length) {
        <span class="mt-count">{{ attention().items.length }}</span>
      }
    </div>
    @if (urgent().length) {
      <div class="urgent" role="alert">
        <mt-icon name="alert" />
        <p>
          <strong>{{ urgent().length === 1 ? 'A critical deadline' : urgent().length + ' critical deadlines' }}</strong>
          would move into the past. Check {{ urgent().length === 1 ? 'it' : 'them' }} first.
        </p>
      </div>
    }
    @switch (data.attentionStatus()) {
      @case ('loading') {
        <mt-skeleton label="Loading what needs attention…" [count]="3" />
      }
      @case ('error') {
        <mt-note tone="danger">Overdue deadlines and changes didn’t load. They show again once you reload.</mt-note>
      }
      @default {
        @if (attention().items.length) {
          <ol class="mt-timeline" aria-labelledby="mt-today-attention">
            @for (item of attention().items; track item.key) {
              @switch (item.kind) {
                @case ('change') {
                  @let vm = item.change;
                  <li
                    class="mt-tl"
                    data-today-item
                    data-kind="change"
                    [attr.data-key]="item.key"
                    [attr.data-state]="vm.urgent ? 'overdue' : null"
                  >
                    <span class="node" aria-hidden="true"><mt-icon [name]="vm.urgent ? 'alert' : 'updown'" /></span>
                    <div class="body">
                      <div class="tt">
                        <a data-today-focus [routerLink]="['/matters', vm.matterId, 'deadlines']"
                          ><span class="mt-sr">Change to review: </span>{{ vm.change.title }}</a
                        >
                        @if (vm.change.critical) {
                          <mt-badge tone="danger">Critical</mt-badge>
                        }
                        @if (vm.change.intoPast) {
                          <mt-badge tone="warning">Into the past</mt-badge>
                        }
                      </div>
                      <div class="rule">
                        {{ summary(vm) }}
                        @if (matterLabel(vm.matter); as label) {
                          · {{ label }}
                        }
                      </div>
                    </div>
                    @if (canDecide()) {
                      <div class="side">
                        <button
                          mtButton
                          size="sm"
                          variant="primary"
                          [disabled]="deadlines.isBusy(vm.rowKey)"
                          (click)="resolve(vm, true)"
                        >
                          Accept<span class="mt-sr">: {{ vm.change.title }}</span>
                        </button>
                        <button
                          mtButton
                          size="sm"
                          [disabled]="deadlines.isBusy(vm.rowKey)"
                          (click)="resolve(vm, false)"
                        >
                          Reject<span class="mt-sr">: {{ vm.change.title }}</span>
                        </button>
                      </div>
                    }
                  </li>
                }
                @case ('overdue') {
                  @let vm = item.deadline;
                  <li
                    class="mt-tl"
                    data-today-item
                    data-kind="deadline"
                    data-state="overdue"
                    [attr.data-key]="item.key"
                  >
                    <span class="node" aria-hidden="true"><mt-icon name="alert" /></span>
                    <div class="body">
                      <div class="tt">
                        <a data-today-focus [routerLink]="['/matters', vm.matterId, 'deadlines']"
                          ><span class="mt-sr">Overdue: </span>{{ vm.deadline.title }}</a
                        >
                      </div>
                      @if (matterLabel(vm.matter); as label) {
                        <div class="rule">{{ label }}</div>
                      }
                    </div>
                    <div class="side">
                      @if (vm.deadline.dueDate; as due) {
                        <mt-deadline-chip [due]="due" [critical]="vm.deadline.critical" [trace]="trace(vm)" />
                      }
                      @if (canEdit()) {
                        <button
                          mtButton
                          size="sm"
                          iconStart="check"
                          [disabled]="deadlines.isBusy(vm.rowKey)"
                          (click)="markDone(vm)"
                        >
                          Mark done<span class="mt-sr">: {{ vm.deadline.title }}</span>
                        </button>
                      }
                    </div>
                  </li>
                }
                @case ('escalation') {
                  <li class="mt-tl" data-today-item data-kind="escalation" [attr.data-key]="item.key">
                    <span class="node" aria-hidden="true"><mt-icon name="flag" /></span>
                    <div class="body">
                      <div class="tt">
                        @if (item.matter; as matter) {
                          <a data-today-focus [routerLink]="['/matters', matter.id]"
                            ><span class="mt-sr">Escalation: </span>{{ item.escalation.title }}</a
                          >
                        } @else {
                          <span data-today-focus tabindex="-1">{{ item.escalation.title }}</span>
                        }
                      </div>
                      @if (matterLabel(item.matter); as label) {
                        <div class="rule">{{ label }}</div>
                      }
                    </div>
                    @if (canEdit()) {
                      <div class="side">
                        <button mtButton size="sm" iconStart="check" (click)="acknowledge(item.escalation)">
                          Acknowledge<span class="mt-sr">: {{ item.escalation.title }}</span>
                        </button>
                      </div>
                    }
                  </li>
                }
              }
            }
          </ol>
          @if (attention().truncated) {
            <p class="caption t-3 more">
              Showing the first {{ attention().items.length }}. <a routerLink="/deadlines">See every deadline</a>
            </p>
          }
        } @else {
          <mt-empty-state
            icon="check-circle"
            [title]="copy.attentionClear.title"
            [description]="copy.attentionClear.description"
          />
        }
      }
    }
  `,
})
export class TodayAttention extends TodayCard {
  protected readonly canDecide = can('deadline.override');
  protected readonly attention = this.data.attention;
  protected readonly urgent = computed(() =>
    this.attention().items.filter((item) => item.kind === 'change' && item.change.urgent),
  );

  protected summary(vm: TodayChangeVm): string {
    return deadlineChangeSummary(vm.change);
  }

  protected resolve(vm: TodayChangeVm, accept: boolean): void {
    void this.deadlines.resolve(asChangeRow(vm), accept);
  }
}

/** Due today and this week: my deadlines and tasks, merged by date then priority (read once). */
@Component({
  selector: 'mt-today-due',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../../../../../libs/ui/src/generated/components/timeline.css',
    '../../../../../../libs/ui/src/generated/components/tl.css',
  ],
  imports: [MtDeadlineChip, MtEmptyState, MtIcon, MtIconButton, MtNote, MtSkeleton, RouterLink],
  host: {
    class: 'mt-card mt-today-card',
    role: 'region',
    'aria-labelledby': 'mt-today-due',
    'data-pad': '',
    'data-section': 'due',
  },
  template: `
    <div class="mt-card-h">
      <h2 class="mt-card-title" id="mt-today-due">Due today and this week</h2>
      <a class="mt-ml caption" routerLink="/deadlines">All deadlines</a>
    </div>
    @switch (data.dueStatus()) {
      @case ('loading') {
        <mt-skeleton label="Loading this week…" [count]="3" />
      }
      @case ('error') {
        <mt-note tone="danger">This week’s deadlines and tasks didn’t load. They show again once you reload.</mt-note>
      }
      @default {
        @for (group of groups(); track group.id) {
          <section class="mt-timeline-day" [attr.aria-labelledby]="'mt-today-due-' + group.id">
            <h3 class="mt-timeline-date" [id]="'mt-today-due-' + group.id">{{ group.label }}</h3>
            <ol class="mt-timeline">
              @for (item of group.items; track item.key) {
                @if (item.kind === 'deadline') {
                  @let vm = item.deadline;
                  <li
                    class="mt-tl"
                    data-today-item
                    data-kind="deadline"
                    [attr.data-key]="item.key"
                    [attr.data-state]="state(item.dueDate)"
                  >
                    <span class="node" aria-hidden="true"><mt-icon name="clock" /></span>
                    <div class="body">
                      <div class="tt">
                        <a data-today-focus [routerLink]="['/matters', vm.matterId, 'deadlines']"
                          ><span class="mt-sr">Deadline: </span>{{ vm.deadline.title }}</a
                        >
                      </div>
                      <div class="rule">
                        {{ matterLabel(vm.matter) }}
                        @if (vm.deadline.dueTime) {
                          · By {{ vm.deadline.dueTime }}
                        }
                      </div>
                    </div>
                    <div class="side">
                      <mt-deadline-chip [due]="item.dueDate" [critical]="vm.deadline.critical" [trace]="trace(vm)" />
                      @if (canEdit()) {
                        <button
                          mtIconButton
                          size="sm"
                          icon="check"
                          [label]="'Mark done: ' + vm.deadline.title"
                          [disabled]="deadlines.isBusy(vm.rowKey)"
                          (click)="markDone(vm)"
                        ></button>
                      }
                    </div>
                  </li>
                } @else {
                  @let entry = item.entry;
                  <li
                    class="mt-tl"
                    data-today-item
                    data-kind="task"
                    [attr.data-key]="item.key"
                    [attr.data-state]="state(item.dueDate)"
                  >
                    <span class="node" aria-hidden="true"><mt-icon name="check-circle" /></span>
                    <div class="body">
                      <div class="tt">
                        <a data-today-focus [routerLink]="taskLink(entry)"
                          ><span class="mt-sr">Task: </span>{{ entry.task.title }}</a
                        >
                      </div>
                      @if (entry.vm.subtitle; as subtitle) {
                        <div class="rule">{{ subtitle }}</div>
                      }
                    </div>
                    <div class="side">
                      <mt-deadline-chip [due]="item.dueDate" />
                      @if (entry.editable) {
                        <button
                          mtIconButton
                          size="sm"
                          icon="check"
                          [label]="'Complete: ' + entry.task.title"
                          (click)="complete(entry)"
                        ></button>
                      }
                    </div>
                  </li>
                }
              }
            </ol>
          </section>
        } @empty {
          <mt-empty-state icon="calendar" [title]="copy.weekClear.title" [description]="copy.weekClear.description" />
        }
        @if (data.due().truncated) {
          <p class="caption t-3 more">
            Showing the first {{ data.due().items.length }}. <a routerLink="/deadlines">See every deadline</a> or
            <a routerLink="/tasks">all your tasks</a>
          </p>
        }
      }
    }
  `,
})
export class TodayDue extends TodayCard {
  protected readonly groups = computed(() => groupDueItems(this.data.due().items, this.data.today()));

  protected state(date: Parameters<typeof dueState>[0]): string {
    return dueState(date, this.data.today());
  }
}

/** My tasks, short: my next open tasks with a date, with a link to `/tasks` (read once). */
@Component({
  selector: 'mt-today-tasks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtEmptyState, MtNote, MtSkeleton, MtTaskRow, RouterLink],
  host: {
    class: 'mt-card mt-today-card',
    role: 'region',
    'aria-labelledby': 'mt-today-tasks',
    'data-pad': '',
    'data-section': 'tasks',
  },
  template: `
    <div class="mt-card-h">
      <h2 class="mt-card-title" id="mt-today-tasks">My tasks</h2>
      @if (data.counts().openTasks; as open) {
        <span class="mt-count">{{ open }}</span>
      }
      <a class="mt-ml caption" routerLink="/tasks">All my tasks</a>
    </div>
    @switch (data.myTasksStatus()) {
      @case ('loading') {
        <mt-skeleton label="Loading your tasks…" [count]="3" />
      }
      @case ('error') {
        <mt-note tone="danger">Your tasks didn’t load. They show again once you reload.</mt-note>
      }
      @default {
        @if (data.myTasks().length) {
          <ul class="tasks" aria-labelledby="mt-today-tasks">
            @for (item of data.myTasks(); track item.key) {
              <li data-today-item data-kind="task" [attr.data-key]="item.key">
                <mt-task-row
                  [task]="item.entry.vm"
                  [disabled]="!item.entry.editable"
                  (done)="tasks.toggleDone(item.entry)"
                  (open)="openTask(item.entry)"
                />
              </li>
            }
          </ul>
        } @else {
          <mt-empty-state
            icon="check-circle"
            [title]="copy.tasksClear.title"
            [description]="copy.tasksClear.description"
          >
            <a class="caption" routerLink="/tasks">Open my tasks</a>
          </mt-empty-state>
        }
      }
    }
    <div class="mt-sr" aria-live="polite" aria-atomic="true">{{ tasks.announcement() }}</div>
  `,
})
export class TodayTasks extends TodayCard {}

/** The matters I opened lately (`users/{uid}/recent`, read once). */
@Component({
  selector: 'mt-today-recent',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtEmptyState, MtMatterTag, MtSkeleton, RouterLink],
  host: {
    class: 'mt-card mt-today-card',
    role: 'region',
    'aria-labelledby': 'mt-today-recent',
    'data-pad': '',
    'data-section': 'recent',
  },
  template: `
    <div class="mt-card-h">
      <h2 class="mt-card-title" id="mt-today-recent">Recent matters</h2>
      <a class="mt-ml caption" routerLink="/matters">All matters</a>
    </div>
    @if (data.recentStatus() === 'loading') {
      <mt-skeleton label="Loading recent matters…" [count]="3" />
    } @else if (data.recentMatters().length) {
      <ul class="recent" aria-labelledby="mt-today-recent">
        @for (matter of data.recentMatters(); track matter.id) {
          <li data-today-item data-kind="matter" [attr.data-key]="'matter:' + matter.id">
            <a data-today-focus [routerLink]="['/matters', matter.id]">
              <span class="num">{{ matter.number }}</span
              >&ngsp;<span class="name">{{ matter.title }}</span>
            </a>
            @if (matter.type; as type) {
              <mt-matter-tag [type]="type" />
            }
          </li>
        }
      </ul>
    } @else {
      <mt-empty-state icon="matters" [title]="copy.recentEmpty.title" [description]="copy.recentEmpty.description" />
    }
  `,
})
export class TodayRecent extends TodayCard {}
