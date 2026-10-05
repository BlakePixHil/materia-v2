import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, ViewEncapsulation } from '@angular/core';

import { can } from '@materia/data-access';
import {
  forMatter,
  MATTER_DEADLINES_QUERY,
  MATTER_EVENTS_QUERY,
  matterDeadlineChangeRepository,
  matterDeadlineRepository,
  matterEventRepository,
  PENDING_CHANGES_QUERY,
} from '@materia/data-access/repository';
import { compareDeadlines, needsReview, STATUTORY_DISABLED_MESSAGE } from '@materia/domain';
import { formatDateOnly, MtButton, MtEmptyState, MtIconButton, MtNote } from '@materia/ui';

import { DeadlineActions } from './deadline-actions';
import { DeadlineRow, type DeadlineRowAction } from './deadline-row';
import { deadlineErrorCopy, isClosedDeadline, type ChangeRowVm, type DeadlineRowVm } from './deadline-view';
import { PendingChanges } from './pending-changes';
import { statutoryDisabled } from './statutory-flag';
import { MatterScreen } from '../matter-detail/matter-screen';
import { eventKindLabel } from '../matter-detail/matter-view';

/**
 * A matter's Deadlines tab (CORE-10): proposed changes to decide, deadlines to review (already past
 * when computed), the open deadlines with their traces (a waiting one says why), the events they're
 * computed from (recorded, edited and deleted here), and the closed ones. Manual deadlines are added
 * here. Listens to the matter's deadlines, proposals and events only while the tab is shown.
 */
@Component({
  selector: 'mt-matter-deadlines',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  providers: [DeadlineActions],
  imports: [DeadlineRow, MtButton, NgTemplateOutlet, MtEmptyState, MtIconButton, MtNote, PendingChanges],
  host: { class: 'mt-matter-deadlines' },
  template: `
    <div class="head">
      <h2 class="title-m">Deadlines</h2>
      <span class="caption t-3">{{ openRows().length === 1 ? '1 open' : openRows().length + ' open' }}</span>
      <span class="mt-ml tools">
        @if (canEditEvents()) {
          <button mtButton size="sm" iconStart="calendar" [disabled]="eventBusy()" (click)="recordEvent()">
            Record event
          </button>
        }
        @if (canAdd()) {
          <button mtButton variant="primary" size="sm" iconStart="plus" (click)="addDeadline()">Add deadline</button>
        }
      </span>
    </div>
    <p class="mt-sr" aria-live="polite">{{ actions.announcement() }}</p>
    @if (statutoryOff()) {
      <mt-note tone="warning">{{ statutoryMessage }}</mt-note>
    }

    @if (changeRows().length) {
      <section class="block" aria-labelledby="mt-md-changes">
        <h3 class="title-s" id="mt-md-changes">Changes to review</h3>
        <p class="caption t-2 hint">
          The events changed, so these dates would move. Nothing changes until a lawyer accepts.
        </p>
        <mt-pending-changes
          [changes]="changeRows()"
          [canResolve]="canDecide()"
          [isBusy]="isBusy"
          (accept)="actions.resolve($event, true)"
          (reject)="actions.resolve($event, false)"
        />
      </section>
    }

    @switch (deadlines.status()) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading deadlines…</p>
      }
      @case ('error') {
        <mt-note tone="danger">
          {{ loadError() }}
          <button mtButton size="sm" (click)="deadlines.refresh()">Try again</button>
        </mt-note>
      }
      @default {
        @if (reviewRows().length) {
          <section class="block" aria-labelledby="mt-md-review">
            <h3 class="title-s" id="mt-md-review">Needs review</h3>
            <p class="caption t-2 hint">Already past when they were computed: decide what happened to each.</p>
            <ul class="rows">
              @for (row of reviewRows(); track row.key) {
                <li>
                  <ng-container *ngTemplateOutlet="rowTemplate; context: { $implicit: row }" />
                </li>
              }
            </ul>
          </section>
        }
        <section class="block" aria-labelledby="mt-md-open">
          <h3 class="title-s" id="mt-md-open">Open</h3>
          @if (openRows().length) {
            <ul class="rows">
              @for (row of openRows(); track row.key) {
                <li>
                  <ng-container *ngTemplateOutlet="rowTemplate; context: { $implicit: row }" />
                </li>
              }
            </ul>
          } @else {
            <mt-empty-state
              icon="calendar"
              title="No open deadlines"
              [description]="
                canAdd()
                  ? 'Record the matter’s events to compute its deadlines, or add one yourself.'
                  : 'Deadlines on this matter show here.'
              "
              [headingLevel]="4"
            />
          }
        </section>
      }
    }

    <section class="block" aria-labelledby="mt-md-events">
      <h3 class="title-s" id="mt-md-events">Events</h3>
      <p class="caption t-2 hint">Deadlines are computed from these dates.</p>
      @if (eventRows().length) {
        <ol class="rows events">
          @for (event of eventRows(); track event.id) {
            <li [attr.data-event]="event.kind">
              <span class="date caption t-2">{{ date(event.date) }}</span>
              <span class="mt-grow">
                {{ eventLabel(event.kind) }}
                @if (event.label && event.label !== eventLabel(event.kind)) {
                  <span class="caption t-3">· {{ event.label }}</span>
                }
              </span>
              @if (canEditEvents()) {
                <button
                  mtIconButton
                  icon="compose"
                  size="sm"
                  [label]="'Edit ' + eventLabel(event.kind)"
                  [disabled]="actions.isBusy(event.id)"
                  (click)="editEvent(event)"
                ></button>
                <button
                  mtIconButton
                  icon="trash"
                  size="sm"
                  [label]="'Delete ' + eventLabel(event.kind)"
                  [disabled]="actions.isBusy(event.id)"
                  (click)="deleteEvent(event)"
                ></button>
              }
            </li>
          }
        </ol>
      } @else {
        <p class="caption t-3">No events recorded yet.</p>
      }
    </section>

    @if (closedRows().length) {
      <details class="closed">
        <summary class="title-s">Closed ({{ closedRows().length }})</summary>
        <ul class="rows">
          @for (row of closedRows(); track row.key) {
            <li>
              <ng-container *ngTemplateOutlet="rowTemplate; context: { $implicit: row }" />
            </li>
          }
        </ul>
      </details>
    }

    <ng-template #rowTemplate let-row>
      <mt-deadline-row
        [row]="row"
        [assignee]="assignee(row)"
        [canComplete]="canAdd()"
        [canDecide]="canDecide() && !screen.deleted()"
        [canEdit]="canAdd()"
        [busy]="actions.isBusy(row.key)"
        (action)="act(row, $event)"
      />
    </ng-template>
  `,
  styles: `
    .mt-matter-deadlines {
      display: flex;
      flex-direction: column;
      gap: var(--space-20);
      max-width: 960px;
    }
    .mt-matter-deadlines .head {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-8);
    }
    .mt-matter-deadlines h2,
    .mt-matter-deadlines h3 {
      margin: 0;
    }
    .mt-matter-deadlines .tools {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-8);
    }
    .mt-matter-deadlines .block {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      min-width: 0;
    }
    .mt-matter-deadlines .hint {
      margin: 0;
    }
    .mt-matter-deadlines .rows {
      list-style: none;
      margin: 0;
      padding: 0;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }
    .mt-matter-deadlines .rows > li + li {
      border-top: 1px solid var(--border-subtle);
    }
    .mt-matter-deadlines .events > li {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      padding: var(--space-8) var(--space-12);
      font: 400 13px/18px var(--font-sans);
    }
    .mt-matter-deadlines .events .date {
      flex: none;
      min-width: 7.5em;
    }
    .mt-matter-deadlines .closed summary {
      cursor: pointer;
      margin-bottom: var(--space-8);
      width: fit-content;
    }
    .mt-matter-deadlines .closed summary:focus-visible {
      box-shadow: var(--focus-ring);
      outline: none;
      border-radius: var(--radius-sm);
    }
  `,
})
export class MatterDeadlines {
  protected readonly screen = inject(MatterScreen);
  protected readonly actions = inject(DeadlineActions);
  private readonly id = this.screen.id;

  private readonly canTask = can('task.edit');
  private readonly canOverride = can('deadline.override');
  protected readonly canAdd = computed(() => this.canTask() && !this.screen.deleted());
  protected readonly canDecide = computed(() => this.canOverride() && !this.screen.deleted());
  protected readonly canEditEvents = this.screen.editable;
  protected readonly statutoryMessage = STATUTORY_DISABLED_MESSAGE;
  protected readonly statutoryOff = statutoryDisabled(() => [this.screen.value()?.jurisdiction]);

  protected readonly deadlines = matterDeadlineRepository(this.id).watchQuery(
    forMatter(this.id, MATTER_DEADLINES_QUERY),
  );
  protected readonly loadError = computed(() => deadlineErrorCopy(this.deadlines.error()));
  private readonly changes = matterDeadlineChangeRepository(this.id).watchQuery(
    forMatter(this.id, PENDING_CHANGES_QUERY),
  );
  private readonly events = matterEventRepository(this.id).watchQuery(forMatter(this.id, MATTER_EVENTS_QUERY));

  private readonly matterRef = computed(() => {
    const matter = this.screen.value();
    return matter
      ? { id: matter.id, number: matter.number, title: matter.title, jurisdiction: matter.jurisdiction }
      : undefined;
  });
  private readonly rows = computed<DeadlineRowVm[]>(() => {
    const matterId = this.id() ?? '';
    const matter = this.matterRef();
    return [...this.deadlines.value()]
      .sort(compareDeadlines)
      .map((deadline) => ({ key: `${matterId}/${deadline.id}`, matterId, deadline, matter }));
  });
  protected readonly reviewRows = computed(() => this.rows().filter((row) => needsReview(row.deadline)));
  protected readonly openRows = computed(() =>
    this.rows().filter(
      (row) => (row.deadline.status === 'upcoming' || row.deadline.status === 'blocked') && !needsReview(row.deadline),
    ),
  );
  protected readonly closedRows = computed(() => this.rows().filter((row) => isClosedDeadline(row.deadline.status)));
  protected readonly changeRows = computed<ChangeRowVm[]>(() => {
    const matterId = this.id() ?? '';
    const matter = this.matterRef();
    return [...this.changes.value()]
      .sort((a, b) => Number(b.critical) - Number(a.critical) || a.title.localeCompare(b.title))
      .map((change) => ({ key: `${matterId}/${change.id}`, matterId, change, matter }));
  });
  protected readonly eventRows = computed(() => this.events.value());
  protected readonly eventBusy = computed(() => this.actions.isBusy(`event:${this.id() ?? ''}`));

  protected readonly isBusy = (key: string) => this.actions.isBusy(key);
  protected readonly eventLabel = eventKindLabel;

  protected date(value: string): string {
    return formatDateOnly(value);
  }

  protected assignee(row: DeadlineRowVm): string | undefined {
    const uid = row.deadline.assigneeUid;
    return uid ? this.screen.memberName(uid) : undefined;
  }

  private manualContext() {
    const matter = this.screen.value();
    return { people: this.screen.assignees(), assigneeUid: matter?.responsibleUid ?? this.screen.me() ?? '' };
  }

  protected addDeadline(): void {
    const matterId = this.id();
    if (matterId) void this.actions.addManual(matterId, this.manualContext());
  }

  protected recordEvent(): void {
    const matterId = this.id();
    if (matterId) void this.actions.recordEvent(matterId);
  }

  protected editEvent(event: ReturnType<MatterDeadlines['eventRows']>[number]): void {
    const matterId = this.id();
    if (matterId) void this.actions.recordEvent(matterId, event);
  }

  protected deleteEvent(event: ReturnType<MatterDeadlines['eventRows']>[number]): void {
    const matterId = this.id();
    if (matterId) void this.actions.deleteEvent(matterId, event);
  }

  protected act(row: DeadlineRowVm, action: DeadlineRowAction): void {
    switch (action) {
      case 'done':
      case 'waived':
      case 'missed':
        void this.actions.complete(row, action);
        return;
      case 'override':
        void this.actions.override(row);
        return;
      case 'clear_override':
        void this.actions.clearOverride(row);
        return;
      case 'edit':
        void this.actions.editManual(row, this.manualContext());
        return;
      case 'delete':
        void this.actions.removeManual(row);
        return;
    }
  }
}
