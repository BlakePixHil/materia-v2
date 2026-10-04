import { inject, Injectable, Injector, runInInjectionContext, signal } from '@angular/core';

import {
  matterDeadlinesRepository,
  matterTaskRepository,
  personalTaskRepository,
  taskCallables,
  writeTaskOrders,
  type MatterDeadline,
  type Repository,
  type TaskItem,
} from '@materia/data-access/repository';
import {
  asksToCompleteDeadline,
  openChecklistItems,
  planMove,
  TASK_BULK_MAX,
  toggledStatus,
  type BulkTaskChange,
  type ChecklistItem,
  type TaskStatus,
} from '@materia/domain';
import { DialogService, ToastService } from '@materia/ui';

import { TaskDueDialog, type TaskDueDialogData, type TaskDueDialogResult } from './task-due-dialog';
import {
  bulkSummary,
  clientWrite,
  isClosed,
  moveAnnouncement,
  usesBulkCallable,
  type TaskEntry,
  type TaskRecord,
  type TaskSectionVm,
} from './task-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What the task lists do to tasks (CORE-08), shared by the matter's Tasks tab and My tasks.
 * Provide it on the page. Writes are client-direct through the repositories (the rules check
 * them), so they queue offline and sync later: nothing here waits for the server before the list
 * moves on, and a write that fails shows a toast. More than `TASK_CLIENT_BATCH_MAX` selected tasks
 * change through `tasks-bulkUpdate` instead.
 */
@Injectable()
export class TaskActions {
  private readonly injector = inject(Injector);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly callables = taskCallables(inject(CALLABLES));
  private readonly personal = personalTaskRepository();
  private readonly matterRepos = new Map<string, Repository<TaskItem>>();
  private readonly deadlineRepos = new Map<string, Repository<MatterDeadline>>();

  /** The latest move or change, for the lists' polite live region. */
  readonly announcement = signal('');
  /** A bulk change is on its way to the server. */
  readonly busy = signal(false);

  /** The repository a task is written through: its matter's, or the person's own. */
  repoFor(matterId: string | null | undefined): Repository<TaskItem> {
    if (!matterId) return this.personal;
    let found = this.matterRepos.get(matterId);
    if (!found) {
      found = runInInjectionContext(this.injector, () => matterTaskRepository(() => matterId));
      this.matterRepos.set(matterId, found);
    }
    return found;
  }

  private deadlinesFor(matterId: string): Repository<MatterDeadline> {
    let found = this.deadlineRepos.get(matterId);
    if (!found) {
      found = runInInjectionContext(this.injector, () => matterDeadlinesRepository(() => matterId));
      this.deadlineRepos.set(matterId, found);
    }
    return found;
  }

  /** Runs a write without waiting for it (it may be queued offline); a failure shows a toast. */
  private write(work: Promise<unknown>, failure: string): void {
    work.catch((error: unknown) => this.toasts.show({ title: failure, description: errorCopy(error), tone: 'danger' }));
  }

  private say(message: string): void {
    // Clear first so the same words are announced again.
    this.announcement.set('');
    queueMicrotask(() => this.announcement.set(message));
  }

  // ---------- one task ----------

  /** Space and the checkbox: an open task becomes done (after the confirms), a closed one reopens. */
  async toggleDone(entry: TaskEntry): Promise<void> {
    if (!entry.editable) return;
    const next = toggledStatus(entry.task.status);
    if (next === 'done') await this.complete([entry]);
    else await this.setStatus([entry], next);
  }

  rename(entry: TaskEntry, title: string): void {
    if (!entry.editable) return;
    this.write(this.repoFor(entry.ref.matterId).update(entry.task.id, { title }), 'The title didn’t save');
    this.say(`Renamed to ${title}.`);
  }

  setChecklist(entry: TaskEntry, checklist: ChecklistItem[]): void {
    if (!entry.editable) return;
    this.write(this.repoFor(entry.ref.matterId).update(entry.task.id, { checklist }), 'The checklist didn’t save');
  }

  /**
   * Moves a task within its section (Alt+Up/Down, drag) to `toIndex` of the section without it:
   * new orders from `planMove`, written in chunks by `writeTaskOrders`.
   */
  move(section: TaskSectionVm, entry: TaskEntry, toIndex: number): void {
    if (!entry.editable) return;
    const items = section.entries.map((e) => ({ id: e.task.id, order: e.task.order }));
    const updates = planMove(items, [entry.task.id], toIndex);
    if (!updates.length) return;
    this.write(writeTaskOrders(this.repoFor(entry.ref.matterId), updates), 'The new order didn’t save');
    this.say(moveAnnouncement(entry.task.title, toIndex, section.entries.length, section.label));
  }

  /** Drag into another section: the task takes that section's group, placed at `toIndex`. */
  moveTo(target: TaskSectionVm, entry: TaskEntry, toIndex: number): void {
    if (!entry.editable || target.group === undefined) return;
    const items = [...target.entries, entry].map((e) => ({ id: e.task.id, order: e.task.order }));
    const updates = planMove(items, [entry.task.id], toIndex);
    const own = updates.find((u) => u.id === entry.task.id);
    const others = updates.filter((u) => u.id !== entry.task.id);
    const repo = this.repoFor(entry.ref.matterId);
    const patch: Record<string, unknown> = { ...(own ? { order: own.order } : {}) };
    if (target.group) patch['group'] = target.group;
    this.write(
      Promise.all([
        repo.update(entry.task.id, patch, target.group ? {} : { remove: ['group'] }),
        writeTaskOrders(repo, others),
      ]),
      'The move didn’t save',
    );
    this.say(moveAnnouncement(entry.task.title, toIndex, target.entries.length + 1, target.label));
  }

  // ---------- status ----------

  /**
   * Completes tasks: asks first when checklist items are still open, and afterwards offers to mark
   * linked deadlines as done too. Done tasks get an Undo.
   */
  async complete(entries: readonly TaskEntry[]): Promise<boolean> {
    const targets = entries.filter((e) => e.editable && !isClosed(e.task.status));
    if (!targets.length) return false;
    const unticked = targets.reduce((sum, e) => sum + openChecklistItems(e.task), 0);
    if (unticked) {
      const one = targets.length === 1;
      const ok = await this.dialogs.confirm({
        title: one ? 'Complete this task anyway?' : `Complete ${plural(targets.length, 'task')} anyway?`,
        body: `${plural(unticked, 'checklist item')} ${unticked === 1 ? 'isn’t' : 'aren’t'} ticked yet.`,
        confirmLabel: 'Complete anyway',
      });
      if (!ok) return false;
    }
    await this.applyStatus(targets, 'done');
    const linked = targets.filter((e) => e.ref.matterId && asksToCompleteDeadline(e.task, 'done'));
    if (linked.length) await this.offerDeadlines(linked);
    return true;
  }

  private async offerDeadlines(linked: readonly TaskEntry[]): Promise<void> {
    const one = linked.length === 1;
    const ok = await this.dialogs.confirm({
      title: one ? 'Mark the deadline as done too?' : 'Mark the deadlines as done too?',
      body: one
        ? `“${linked[0]?.task.title}” is linked to a deadline on the matter.`
        : `${plural(linked.length, 'task')} you completed are linked to deadlines.`,
      confirmLabel: one ? 'Mark deadline done' : 'Mark deadlines done',
      cancelLabel: 'Leave open',
    });
    if (!ok) return;
    for (const entry of linked) {
      const { matterId } = entry.ref;
      const deadlineId = entry.task.deadlineId;
      if (!matterId || !deadlineId) continue;
      this.write(this.deadlinesFor(matterId).update(deadlineId, { status: 'done' }), 'The deadline didn’t update');
    }
    this.say(one ? 'Deadline marked done.' : `${plural(linked.length, 'deadline')} marked done.`);
  }

  /** Any status change; `done` goes through `complete` for its confirms. */
  async setStatus(entries: readonly TaskEntry[], status: TaskStatus): Promise<void> {
    if (status === 'done') {
      await this.complete(entries);
      return;
    }
    await this.applyStatus(
      entries.filter((e) => e.editable && e.task.status !== status),
      status,
    );
  }

  private async applyStatus(entries: readonly TaskEntry[], status: TaskStatus): Promise<void> {
    if (!entries.length) return;
    const before = entries.map((e) => [e, e.task.status] as const);
    const ok = await this.apply(entries, { op: 'status', status });
    if (!ok || status !== 'done') return;
    this.toasts.show({
      title: entries.length === 1 ? 'Task done' : `${plural(entries.length, 'task')} done`,
      tone: 'success',
      action: {
        label: 'Undo',
        run: () => {
          for (const [entry, previous] of before) {
            this.write(
              this.repoFor(entry.ref.matterId).update(entry.task.id, { status: previous }),
              'Couldn’t undo that',
            );
          }
          this.say('Undone.');
        },
      },
    });
  }

  // ---------- bulk ----------

  /** Asks for a due date (or clearing it), then changes it on the tasks. */
  async changeDueDate(entries: readonly TaskEntry[]): Promise<void> {
    const targets = entries.filter((e) => e.editable);
    if (!targets.length) return;
    const first = targets[0]?.task.dueDate;
    const same = targets.every((e) => e.task.dueDate === first);
    const result = await this.dialogs.open<TaskDueDialogData, TaskDueDialogResult | undefined>(TaskDueDialog, {
      data: { count: targets.length, current: same ? (first ?? null) : null },
    }).result;
    if (!result) return;
    await this.bulk(targets, { op: 'dueDate', dueDate: result.dueDate });
  }

  async remove(entries: readonly TaskEntry[]): Promise<boolean> {
    const targets = entries.filter((e) => e.editable);
    if (!targets.length) return false;
    const one = targets.length === 1;
    const ok = await this.dialogs.confirm({
      title: one ? `Delete “${targets[0]?.task.title}”?` : `Delete ${plural(targets.length, 'task')}?`,
      body: one ? 'It’s removed from the task list.' : 'They’re removed from the task list.',
      confirmLabel: one ? 'Delete task' : 'Delete tasks',
      tone: 'danger',
    });
    if (!ok) return false;
    return this.bulk(targets, { op: 'delete' });
  }

  /** A change from the bulk bar, with a toast saying what happened. */
  async bulk(entries: readonly TaskEntry[], change: BulkTaskChange, personName?: string): Promise<boolean> {
    if (change.op === 'status') {
      await this.setStatus(entries, change.status);
      return true;
    }
    const targets = entries.filter((e) => e.editable);
    if (!targets.length) return false;
    const ok = await this.apply(targets, change);
    if (ok) {
      const summary = bulkSummary(change, targets.length, personName);
      this.toasts.show({ title: summary, tone: 'success' });
      this.say(`${summary}.`);
    }
    return ok;
  }

  /**
   * Writes one change to the tasks: directly (at most `TASK_CLIENT_BATCH_MAX`, without waiting, so
   * it works offline), or through `tasks-bulkUpdate` above that.
   */
  private async apply(entries: readonly TaskEntry[], change: BulkTaskChange): Promise<boolean> {
    if (usesBulkCallable(entries.length)) {
      this.busy.set(true);
      try {
        let skipped = 0;
        // One call per TASK_BULK_MAX tasks (the callable's limit).
        for (let at = 0; at < entries.length; at += TASK_BULK_MAX) {
          const tasks = entries.slice(at, at + TASK_BULK_MAX).map((e) => e.ref);
          const result = await this.callables.bulkUpdate({ tasks, change });
          skipped += result.skipped.filter((s) => s.reason !== 'unchanged').length;
        }
        if (skipped) {
          this.toasts.show({
            title: `${plural(skipped, 'task')} ${skipped === 1 ? 'wasn’t' : 'weren’t'} changed`,
            description:
              skipped === 1
                ? 'It was deleted, or is on a matter you can’t change.'
                : 'They were deleted, or are on a matter you can’t change.',
            tone: 'neutral',
          });
        }
        return true;
      } catch (error) {
        this.toasts.show({ title: 'Those tasks didn’t change', description: errorCopy(error), tone: 'danger' });
        return false;
      } finally {
        this.busy.set(false);
      }
    }
    for (const entry of entries) this.writeOne(entry.task, change);
    return true;
  }

  private writeOne(task: TaskRecord, change: BulkTaskChange): void {
    const planned = clientWrite(task, change);
    if (!planned) return;
    const repo = this.repoFor(task.matterId);
    if (planned.kind === 'delete') {
      this.write(repo.softDelete(task.id), 'A task didn’t delete');
      return;
    }
    this.write(repo.update(task.id, planned.patch, { remove: planned.remove }), 'A task didn’t update');
  }
}
