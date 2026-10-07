import { inject, Injectable, Injector, runInInjectionContext, signal } from '@angular/core';

import {
  deadlineCallables,
  matterDeadlineRepository,
  matterTaskRepository,
  type DeadlineItem,
  type MatterEventItem,
  type Repository,
  type WithId,
} from '@materia/data-access/repository';
import {
  deadlineChangeSummary,
  requiresTypedConfirmation,
  type DeadlineOutcome,
  type RecomputeSummary,
} from '@materia/domain';
import { DialogService, MT_TODAY, ToastService } from '@materia/ui';

// The dialogs load when one opens (`import()`), so pages that only show deadlines, like Today,
// don't download them.
import type {
  CompleteDeadlineDialogData,
  CompleteDeadlineDialogResult,
  ConfirmChangeDialogData,
  OverrideDeadlineDialogData,
  OverrideDeadlineDialogResult,
} from './deadline-dialogs';
import {
  deadlineErrorCopy,
  eventKindLabel,
  recomputeSummaryText,
  type ChangeRowVm,
  type DeadlineRowVm,
} from './deadline-view';
import type { EventDialogData, EventDialogResult } from './event-dialog';
import type { ManualDeadlineDialogData, ManualDeadlineDialogResult } from './manual-deadline-dialog';
import { CALLABLES } from '../../core/data/callables';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const OUTCOME_DONE: Record<DeadlineOutcome, string> = {
  done: 'Deadline marked done',
  waived: 'Deadline waived',
  missed: 'Deadline recorded as missed',
};

/** Who a manual deadline can go to, and who it goes to by default. */
export interface ManualDeadlineContext {
  people: readonly { uid: string; name: string }[];
  assigneeUid: string;
}

/** A new manual deadline's context: also its matter's flag, which it copies (CORE-10b; the rules check it). */
export interface NewManualDeadlineContext extends ManualDeadlineContext {
  privileged: boolean;
}

/**
 * What the deadline lists do (CORE-10), shared by the Deadlines screen and the matter's Deadlines
 * tab; provide it on the page. Status, dates and decisions go through the `deadlines-*` callables
 * (the rules refuse them as direct writes) and wait for the server; manual deadlines are written
 * directly. Every outcome is announced through `announcement` (a polite live region) and a toast.
 */
@Injectable()
export class DeadlineActions {
  private readonly injector = inject(Injector);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly today = inject(MT_TODAY);
  private readonly api = deadlineCallables(inject(CALLABLES));
  private readonly deadlineRepos = new Map<string, Repository<DeadlineItem>>();

  /** The latest outcome, for the page's polite live region. */
  readonly announcement = signal('');
  /** Keys (deadline, change or event) with a call on its way. */
  readonly busy = signal<ReadonlySet<string>>(new Set());

  isBusy(key: string): boolean {
    return this.busy().has(key);
  }

  private say(message: string): void {
    // Cleared first so the same words are announced again.
    this.announcement.set('');
    queueMicrotask(() => this.announcement.set(message));
  }

  private async run<T>(key: string, failure: string, work: () => Promise<T>): Promise<T | undefined> {
    this.busy.update((keys) => new Set(keys).add(key));
    try {
      return await work();
    } catch (error) {
      const description = deadlineErrorCopy(error);
      this.toasts.show({ title: failure, description, tone: 'danger' });
      this.say(`${failure}. ${description}`);
      return undefined;
    } finally {
      this.busy.update((keys) => {
        const next = new Set(keys);
        next.delete(key);
        return next;
      });
    }
  }

  private deadlines(matterId: string): Repository<DeadlineItem> {
    let found = this.deadlineRepos.get(matterId);
    if (!found) {
      found = runInInjectionContext(this.injector, () => matterDeadlineRepository(() => matterId));
      this.deadlineRepos.set(matterId, found);
    }
    return found;
  }

  // ---------- closing ----------

  /** Acknowledges a critical deadline (`deadlines-acknowledge`, CORE-11), which stops it escalating. */
  async acknowledge(row: DeadlineRowVm): Promise<boolean> {
    const { deadline, matterId } = row;
    const result = await this.run(row.key, 'The deadline wasn’t acknowledged', () =>
      this.api.acknowledge({ matterId, deadlineId: deadline.id }),
    );
    if (!result) return false;
    this.toasts.show({ title: 'Deadline acknowledged', tone: 'success' });
    this.say(`Acknowledged: ${deadline.title}.`);
    return true;
  }

  /** Done, waived or missed (`deadlines-complete`), offering to close its linked task too. */
  async complete(row: DeadlineRowVm, outcome: DeadlineOutcome): Promise<boolean> {
    const { deadline, matterId } = row;
    const { CompleteDeadlineDialog } = await import('./deadline-dialogs');
    const answer = await this.dialogs.open<CompleteDeadlineDialogData, CompleteDeadlineDialogResult | undefined>(
      CompleteDeadlineDialog,
      { data: { title: deadline.title, outcome, today: this.today(), linkedTask: !!deadline.taskId } },
    ).result;
    if (!answer) return false;
    const result = await this.run(row.key, 'The deadline didn’t change', () =>
      this.api.complete({ matterId, deadlineId: deadline.id, outcome, ...answer }),
    );
    if (!result) return false;
    const done = result.completedTaskIds.length
      ? `${OUTCOME_DONE[outcome]}, with ${plural(result.completedTaskIds.length, 'linked task')}`
      : OUTCOME_DONE[outcome];
    this.toasts.show({ title: done, tone: 'success' });
    this.say(`${done}: ${deadline.title}.`);
    if (result.openLinkedTaskIds.length && !answer.completeLinkedTasks && !deadline.taskId) {
      await this.offerLinkedTasks(matterId, result.openLinkedTaskIds);
    }
    return true;
  }

  private async offerLinkedTasks(matterId: string, taskIds: readonly string[]): Promise<void> {
    const one = taskIds.length === 1;
    const ok = await this.dialogs.confirm({
      title: one ? 'Mark the linked task done too?' : `Mark ${taskIds.length} linked tasks done too?`,
      body: one ? 'A task on the matter is linked to this deadline.' : 'Tasks on the matter are linked to it.',
      confirmLabel: one ? 'Mark task done' : 'Mark tasks done',
      cancelLabel: 'Leave open',
    });
    if (!ok) return;
    const tasks = runInInjectionContext(this.injector, () => matterTaskRepository(() => matterId));
    await this.run(`tasks:${matterId}`, 'The linked task didn’t update', () =>
      Promise.all(taskIds.map((id) => tasks.update(id, { status: 'done' }))),
    );
    this.say(one ? 'Linked task marked done.' : `${plural(taskIds.length, 'linked task')} marked done.`);
  }

  // ---------- overrides ----------

  /** Sets a computed deadline's date by hand, with a reason (`deadlines-override`). */
  async override(row: DeadlineRowVm): Promise<void> {
    const { deadline } = row;
    const computedDate = deadline.computed?.dueDate;
    const { OverrideDeadlineDialog } = await import('./deadline-dialogs');
    const answer = await this.dialogs.open<OverrideDeadlineDialogData, OverrideDeadlineDialogResult | undefined>(
      OverrideDeadlineDialog,
      {
        data: {
          title: deadline.title,
          dueDate: deadline.dueDate,
          computedDate: computedDate !== deadline.dueDate || deadline.override ? computedDate : undefined,
        },
      },
    ).result;
    if (!answer) return;
    const result = await this.run(row.key, 'The date wasn’t overridden', () =>
      this.api.override({ matterId: row.matterId, deadlineId: deadline.id, ...answer }),
    );
    if (!result) return;
    if (result.overrideConflict) {
      this.toasts.show({
        title: 'Date overridden, but the rule computes an earlier date',
        description: 'The deadline is flagged until the rule’s date is no longer earlier than yours.',
        tone: 'neutral',
        duration: 10_000,
      });
      this.say('Date overridden. The rule computes an earlier date, so the deadline is flagged.');
      return;
    }
    this.toasts.show({ title: 'Date overridden', tone: 'success' });
    this.say(`Date overridden: ${deadline.title}.`);
  }

  /** Back to the rule's date. */
  async clearOverride(row: DeadlineRowVm): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: 'Go back to the computed date?',
      body: `${row.deadline.title} takes the date its rule computes again.`,
      confirmLabel: 'Use computed date',
    });
    if (!ok) return;
    const result = await this.run(row.key, 'The override wasn’t cleared', () =>
      this.api.override({ matterId: row.matterId, deadlineId: row.deadline.id, dueDate: null }),
    );
    if (!result) return;
    this.toasts.show({ title: 'Back to the computed date', tone: 'success' });
    this.say(`Back to the computed date: ${row.deadline.title}.`);
  }

  // ---------- proposals ----------

  /**
   * Accepts or rejects a proposed change (`deadlines-resolveChange`). Accepting a change to a
   * critical deadline asks for the matter number typed first.
   */
  async resolve(row: ChangeRowVm, accept: boolean): Promise<boolean> {
    const { change, matterId } = row;
    let confirmation: string | undefined;
    if (accept && requiresTypedConfirmation(change)) {
      const matterNumber = row.matter?.number;
      if (!matterNumber || matterNumber === 'Restricted') {
        this.toasts.show({ title: 'Open the matter to accept this change', tone: 'neutral' });
        return false;
      }
      const { ConfirmChangeDialog } = await import('./deadline-dialogs');
      confirmation = await this.dialogs.open<ConfirmChangeDialogData, string | undefined>(ConfirmChangeDialog, {
        data: { title: change.title, summary: deadlineChangeSummary(change), matterNumber, intoPast: change.intoPast },
      }).result;
      if (!confirmation) return false;
    }
    const result = await this.run(row.key, accept ? 'The change wasn’t accepted' : 'The change wasn’t rejected', () =>
      this.api.resolveChange({ matterId, changeId: change.id, accept, ...(confirmation ? { confirmation } : {}) }),
    );
    if (!result) return false;
    if (result.status === 'superseded') {
      this.toasts.show({
        title: 'That change no longer applies',
        description: 'The deadline changed again since it was proposed.',
        tone: 'neutral',
      });
      this.say(`That change to ${change.title} no longer applies.`);
      return true;
    }
    const message = accept ? 'Change accepted' : 'Change rejected';
    this.toasts.show({ title: message, tone: 'success' });
    this.say(`${message}: ${change.title}.`);
    return true;
  }

  // ---------- manual deadlines ----------

  /** Adds a manual deadline (written directly; queued offline). */
  async addManual(matterId: string, context: NewManualDeadlineContext): Promise<void> {
    const { ManualDeadlineDialog } = await import('./manual-deadline-dialog');
    const fields = await this.dialogs.open<ManualDeadlineDialogData, ManualDeadlineDialogResult | undefined>(
      ManualDeadlineDialog,
      { data: { people: context.people, assigneeUid: context.assigneeUid } },
    ).result;
    if (!fields) return;
    this.deadlines(matterId)
      .create({ ...fields, reminders: [], privileged: context.privileged })
      .catch((error: unknown) =>
        this.toasts.show({ title: 'The deadline didn’t save', description: deadlineErrorCopy(error), tone: 'danger' }),
      );
    this.say(`Added ${fields.title}.`);
  }

  async editManual(row: DeadlineRowVm, context: ManualDeadlineContext): Promise<void> {
    const { deadline } = row;
    const { ManualDeadlineDialog } = await import('./manual-deadline-dialog');
    const fields = await this.dialogs.open<ManualDeadlineDialogData, ManualDeadlineDialogResult | undefined>(
      ManualDeadlineDialog,
      { data: { deadline, people: context.people, assigneeUid: context.assigneeUid } },
    ).result;
    if (!fields) return;
    this.deadlines(row.matterId)
      .update(deadline.id, fields, fields.dueTime || !deadline.dueTime ? {} : { remove: ['dueTime'] })
      .catch((error: unknown) =>
        this.toasts.show({ title: 'The deadline didn’t save', description: deadlineErrorCopy(error), tone: 'danger' }),
      );
    this.say(`Saved ${fields.title}.`);
  }

  async removeManual(row: DeadlineRowVm): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: `Delete “${row.deadline.title}”?`,
      body: 'It’s removed from the matter’s deadlines.',
      confirmLabel: 'Delete deadline',
      tone: 'danger',
    });
    if (!ok) return;
    this.deadlines(row.matterId)
      .softDelete(row.deadline.id)
      .catch((error: unknown) =>
        this.toasts.show({
          title: 'The deadline didn’t delete',
          description: deadlineErrorCopy(error),
          tone: 'danger',
        }),
      );
    this.say(`Deleted ${row.deadline.title}.`);
  }

  // ---------- events ----------

  /** Records an event, or edits one, and says what the recompute changed. */
  async recordEvent(matterId: string, event?: WithId<MatterEventItem>): Promise<RecomputeSummary | undefined> {
    const { EventDialog } = await import('./event-dialog');
    const answer = await this.dialogs.open<EventDialogData, EventDialogResult | undefined>(EventDialog, {
      data: { event, today: this.today(), matterId },
    }).result;
    if (!answer) return undefined;
    return this.saveEvent(matterId, answer, event?.id);
  }

  /** `deadlines-upsertEvent`, with a toast saying what changed (proposals to review, new deadlines). */
  async saveEvent(matterId: string, event: EventDialogResult, eventId?: string): Promise<RecomputeSummary | undefined> {
    const result = await this.run(eventId ?? `event:${matterId}`, 'The event didn’t save', () =>
      this.api.upsertEvent({ matterId, ...(eventId ? { eventId } : {}), ...event }),
    );
    if (!result) return undefined;
    this.reportRecompute(`${eventKindLabel(event.kind)} saved`, result.recompute);
    return result.recompute;
  }

  async deleteEvent(matterId: string, event: WithId<MatterEventItem>): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: `Delete the ${eventKindLabel(event.kind).toLowerCase()} event?`,
      body: 'Deadlines worked out from it are proposed for removal. Nothing is removed until a lawyer accepts.',
      confirmLabel: 'Delete event',
      tone: 'danger',
    });
    if (!ok) return;
    const result = await this.run(event.id, 'The event didn’t delete', () =>
      this.api.deleteEvent({ matterId, eventId: event.id }),
    );
    if (result) this.reportRecompute('Event deleted', result.recompute);
  }

  /** A toast and an announcement for a save that recomputed the deadlines. */
  reportRecompute(title: string, summary: RecomputeSummary): void {
    const changes = recomputeSummaryText(summary);
    this.toasts.show({
      title,
      ...(changes ? { description: `${changes}.` } : {}),
      tone: summary.proposed.length ? 'neutral' : 'success',
      ...(summary.proposed.length ? { duration: 10_000 } : {}),
    });
    this.say(changes ? `${title}. ${changes}.` : `${title}.`);
  }
}
