import { ChangeDetectionStrategy, Component, computed, input, output, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';

import { deadlineFlags, deadlineTraceText, deadlineTraceView } from '@materia/domain';
import { formatDateOnly, MT_MENU, MtBadge, MtButton, MtDeadlineChip, MtIconButton } from '@materia/ui';

import {
  canConfirmMissed,
  DEADLINE_FLAG_LABELS,
  DEADLINE_STATUS_LABELS,
  deadlineKindLabel,
  isClosedDeadline,
  isManual,
  type DeadlineRowVm,
} from './deadline-view';

/** What a row asks its list to do. */
export type DeadlineRowAction =
  'done' | 'acknowledge' | 'waived' | 'missed' | 'override' | 'clear_override' | 'edit' | 'delete';

/**
 * One deadline in a list (CORE-10): its title, kind and flags; the DeadlineChip with the trace in
 * its tooltip; a waiting deadline's reason; the trace itself behind "How it’s worked out"; and the
 * actions the member's role allows (Mark done, then a menu: waive, confirm missed, override, edit).
 */
@Component({
  selector: 'mt-deadline-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MT_MENU, MtBadge, MtButton, MtDeadlineChip, MtIconButton, RouterLink],
  host: {
    class: 'mt-deadline-row',
    '[attr.data-deadline]': 'row().deadline.id',
    '[attr.data-status]': 'row().deadline.status',
  },
  template: `
    @let deadline = row().deadline;
    <div class="body">
      <div class="line">
        <span class="title">{{ deadline.title }}</span>
        <span class="caption t-3">{{ kind() }}</span>
        @for (flag of flags(); track flag) {
          <mt-badge [tone]="flag === 'override_conflict' ? 'danger' : 'warning'">{{ flagLabels[flag] }}</mt-badge>
        }
        @if (deadline.override) {
          <mt-badge tone="info">Overridden</mt-badge>
        }
      </div>
      <div class="caption t-3 meta">
        @if (showMatter() && row().matter; as matter) {
          <a [routerLink]="['/matters', row().matterId, 'deadlines']">{{ matter.number }} · {{ matter.title }}</a>
        }
        @if (assignee()) {
          <span>{{ assignee() }}</span>
        }
        @if (deadline.dueTime) {
          <span>By {{ deadline.dueTime }}</span>
        }
        @if (closedText(); as text) {
          <span>{{ text }}</span>
        }
      </div>
      @if (deadline.status === 'blocked') {
        <p class="caption waiting">Waiting: {{ deadline.blockedReason ?? 'not computed yet' }}</p>
      }
      <details class="trace">
        <summary class="caption">How it’s worked out</summary>
        <div class="caption trace-body">
          <p class="heading">{{ trace().heading }}</p>
          @if (trace().citation; as citation) {
            <p class="t-2">{{ citation }}</p>
          }
          @if (trace().lines.length) {
            <ol>
              @for (line of trace().lines; track $index) {
                <li>{{ line }}</li>
              }
            </ol>
          }
          @for (note of trace().notes; track $index) {
            <p class="note">{{ note }}</p>
          }
        </div>
      </details>
    </div>
    <div class="side">
      @if (deadline.dueDate; as due) {
        @if (deadline.status === 'upcoming' || deadline.status === 'done') {
          <mt-deadline-chip
            [due]="due"
            [critical]="deadline.critical"
            [completed]="deadline.status === 'done'"
            [trace]="traceText()"
          />
        } @else {
          <span class="caption t-2">{{ dateText() }}</span>
        }
      }
      @if (deadline.status !== 'upcoming' && deadline.status !== 'done') {
        <mt-badge [tone]="deadline.status === 'missed' ? 'danger' : 'neutral'">{{ statusLabel() }}</mt-badge>
      }
      @if (deadline.status === 'upcoming' && canComplete()) {
        <button mtButton size="sm" iconStart="check" [disabled]="busy()" (click)="action.emit('done')">
          Mark done<span class="mt-sr">: {{ deadline.title }}</span>
        </button>
      }
      @if (menuItems().length) {
        <button
          mtIconButton
          icon="more"
          size="sm"
          [label]="'More actions for ' + deadline.title"
          [disabled]="busy()"
          [mtMenuTrigger]="menu"
        ></button>
      }
    </div>
    <ng-template #menu>
      <mt-menu [attr.aria-label]="'Actions for ' + deadline.title">
        @for (item of menuItems(); track item.action) {
          <button mtMenuItem [tone]="item.danger ? 'danger' : undefined" (click)="action.emit(item.action)">
            {{ item.label }}
          </button>
        }
      </mt-menu>
    </ng-template>
  `,
  styles: `
    .mt-deadline-row {
      display: flex;
      align-items: flex-start;
      gap: var(--space-12);
      padding: 10px var(--space-12);
      min-width: 0;
    }
    .mt-deadline-row .body {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .mt-deadline-row .line,
    .mt-deadline-row .meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-6) var(--space-8);
    }
    .mt-deadline-row .title {
      font: 500 14px/20px var(--font-sans);
      color: var(--text-primary);
      overflow-wrap: anywhere;
    }
    .mt-deadline-row .meta a {
      color: var(--text-brand);
    }
    .mt-deadline-row .waiting {
      margin: 0;
      color: var(--text-secondary);
    }
    .mt-deadline-row .trace summary {
      cursor: pointer;
      color: var(--text-secondary);
      width: fit-content;
    }
    .mt-deadline-row .trace summary:focus-visible {
      box-shadow: var(--focus-ring);
      outline: none;
      border-radius: var(--radius-sm);
    }
    .mt-deadline-row .trace-body {
      margin-top: var(--space-6);
      padding: var(--space-8) var(--space-12);
      border-left: 2px solid var(--border-default);
      color: var(--text-secondary);
    }
    .mt-deadline-row .trace-body p,
    .mt-deadline-row .trace-body ol {
      margin: 0 0 var(--space-4);
    }
    .mt-deadline-row .trace-body ol {
      padding-left: var(--space-16);
      font-family: var(--font-mono);
      overflow-wrap: anywhere;
    }
    .mt-deadline-row .trace-body .heading {
      color: var(--text-primary);
      font-weight: 500;
    }
    .mt-deadline-row .side {
      flex: none;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: var(--space-8);
    }
    @media (max-width: 640px) {
      .mt-deadline-row {
        flex-direction: column;
      }
      .mt-deadline-row .side {
        justify-content: flex-start;
      }
    }
  `,
})
export class DeadlineRow {
  readonly row = input.required<DeadlineRowVm>();
  /** Name the matter (the Deadlines screen; not on the matter's own tab). */
  readonly showMatter = input(false);
  readonly assignee = input<string>();
  /** Mark done (task.edit). */
  readonly canComplete = input(false);
  /** Waive, confirm missed and override (deadline.override). */
  readonly canDecide = input(false);
  /** Edit and delete a manual deadline (task.edit). */
  readonly canEdit = input(false);
  readonly busy = input(false);
  readonly action = output<DeadlineRowAction>();

  protected readonly flagLabels = DEADLINE_FLAG_LABELS;
  protected readonly kind = computed(() => deadlineKindLabel(this.row().deadline.kind));
  protected readonly flags = computed(() => deadlineFlags(this.row().deadline));
  protected readonly trace = computed(() => deadlineTraceView(this.row().deadline));
  protected readonly traceText = computed(() => deadlineTraceText(this.row().deadline));
  protected readonly statusLabel = computed(() => DEADLINE_STATUS_LABELS[this.row().deadline.status]);
  protected readonly dateText = computed(() => formatDateOnly(this.row().deadline.dueDate ?? null));
  protected readonly closedText = computed(() => {
    const { status, resolution } = this.row().deadline;
    if (!resolution || !isClosedDeadline(status)) return null;
    const on = `${DEADLINE_STATUS_LABELS[status]} ${formatDateOnly(resolution.on)}`;
    return resolution.reason ? `${on}: ${resolution.reason}` : on;
  });

  protected readonly menuItems = computed(() => {
    const deadline = this.row().deadline;
    const items: { action: DeadlineRowAction; label: string; danger?: boolean }[] = [];
    const open = deadline.status === 'upcoming';
    const manual = isManual(deadline);
    // CORE-11: acknowledging a critical deadline stops it escalating.
    if (open && deadline.critical && !deadline.ackAt && this.canComplete()) {
      items.push({ action: 'acknowledge', label: 'Acknowledge' });
    }
    if (open && manual && this.canEdit()) items.push({ action: 'edit', label: 'Edit…' });
    if (this.canDecide() && !manual && (open || deadline.status === 'blocked')) {
      items.push({ action: 'override', label: 'Override date…' });
      if (deadline.override) items.push({ action: 'clear_override', label: 'Use computed date' });
    }
    if (open && this.canDecide()) {
      items.push({ action: 'waived', label: 'Waive…' });
      if (canConfirmMissed(deadline)) items.push({ action: 'missed', label: 'Confirm missed…', danger: true });
    }
    if (open && manual && this.canEdit()) items.push({ action: 'delete', label: 'Delete…', danger: true });
    return items;
  });
}
