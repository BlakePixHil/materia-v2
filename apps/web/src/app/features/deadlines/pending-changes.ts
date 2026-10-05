import { ChangeDetectionStrategy, Component, computed, input, output, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';

import { deadlineChangeSummary, isUrgentChange, requiresTypedConfirmation } from '@materia/domain';
import { MtBadge, MtButton, MtIcon } from '@materia/ui';

import { CHANGE_CAUSE_LABELS, type ChangeRowVm } from './deadline-view';

/**
 * Proposed changes to computed deadlines waiting for a lawyer (CORE-10): each with what moves
 * (`deadlineChangeSummary`), why, and Accept and Reject. A critical deadline moved into the past
 * puts a red banner above the list (`isUrgentChange`). Accepting a critical change asks for the
 * matter number (the page's `DeadlineActions` does).
 */
@Component({
  selector: 'mt-pending-changes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtBadge, MtButton, MtIcon, RouterLink],
  host: { class: 'mt-pending-changes' },
  template: `
    @if (urgent().length) {
      <div class="urgent" role="alert">
        <mt-icon name="alert" />
        <p>
          <strong
            >{{ urgent().length === 1 ? 'A critical deadline' : urgent().length + ' critical deadlines' }} would move
            into the past.</strong
          >
          Check {{ urgent().length === 1 ? 'it' : 'them' }} now: {{ urgentTitles() }}.
        </p>
      </div>
    }
    <ul class="list">
      @for (row of changes(); track row.key) {
        @let change = row.change;
        <li [attr.data-change]="change.id">
          <div class="body">
            <div class="line">
              <span class="title">{{ change.title }}</span>
              @if (change.critical) {
                <mt-badge tone="danger">Critical</mt-badge>
              }
              @if (change.intoPast) {
                <mt-badge tone="warning">Into the past</mt-badge>
              }
            </div>
            <p class="caption summary">{{ summary(row) }}</p>
            <p class="caption t-3 meta">
              @if (showMatter() && row.matter; as matter) {
                <a [routerLink]="['/matters', row.matterId, 'deadlines']">{{ matter.number }} · {{ matter.title }}</a>
                ·
              }
              {{ cause(row) }}
              @if (needsNumber(row)) {
                · Accepting needs the matter number
              }
            </p>
          </div>
          @if (canResolve()) {
            <div class="actions">
              <button mtButton size="sm" variant="primary" [disabled]="isBusy()(row.key)" (click)="accept.emit(row)">
                Accept<span class="mt-sr">: {{ change.title }}</span>
              </button>
              <button mtButton size="sm" [disabled]="isBusy()(row.key)" (click)="reject.emit(row)">
                Reject<span class="mt-sr">: {{ change.title }}</span>
              </button>
            </div>
          }
        </li>
      }
    </ul>
  `,
  styles: `
    .mt-pending-changes {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-pending-changes .urgent {
      display: flex;
      gap: var(--space-8);
      align-items: flex-start;
      padding: var(--space-12) var(--space-16);
      border-radius: var(--radius-md);
      background: var(--bg-danger-subtle);
      border: 1px solid var(--border-danger);
      color: var(--text-danger);
      font: 400 13px/18px var(--font-sans);
    }
    .mt-pending-changes .urgent p {
      margin: 0;
    }
    .mt-pending-changes .urgent mt-icon {
      flex: none;
      width: 16px;
      height: 16px;
      margin-top: 1px;
    }
    .mt-pending-changes .list {
      list-style: none;
      margin: 0;
      padding: 0;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }
    .mt-pending-changes .list > li {
      display: flex;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: var(--space-12);
      padding: 10px var(--space-12);
    }
    .mt-pending-changes .list > li + li {
      border-top: 1px solid var(--border-subtle);
    }
    .mt-pending-changes .body {
      flex: 1 1 260px;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .mt-pending-changes .line {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-6);
      align-items: center;
    }
    .mt-pending-changes .title {
      font: 500 14px/20px var(--font-sans);
      overflow-wrap: anywhere;
    }
    .mt-pending-changes .summary,
    .mt-pending-changes .meta {
      margin: 0;
    }
    .mt-pending-changes .meta a {
      color: var(--text-brand);
    }
    .mt-pending-changes .actions {
      display: flex;
      gap: var(--space-8);
      align-items: center;
    }
  `,
})
export class PendingChanges {
  readonly changes = input.required<readonly ChangeRowVm[]>();
  readonly showMatter = input(false);
  /** Accept and Reject (deadline.override). */
  readonly canResolve = input(false);
  readonly isBusy = input<(key: string) => boolean>(() => false);
  readonly accept = output<ChangeRowVm>();
  readonly reject = output<ChangeRowVm>();

  protected readonly urgent = computed(() => this.changes().filter((row) => isUrgentChange(row.change)));
  protected readonly urgentTitles = computed(() =>
    this.urgent()
      .map((row) => (row.matter ? `${row.change.title} (${row.matter.number})` : row.change.title))
      .join('; '),
  );

  protected summary(row: ChangeRowVm): string {
    return deadlineChangeSummary(row.change);
  }

  protected cause(row: ChangeRowVm): string {
    return CHANGE_CAUSE_LABELS[row.change.cause] ?? 'Recomputed';
  }

  protected needsNumber(row: ChangeRowVm): boolean {
    return requiresTypedConfirmation(row.change);
  }
}
