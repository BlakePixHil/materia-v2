import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';
import { RouterLink } from '@angular/router';

import { can, OrgContext } from '@materia/data-access';
import {
  deadlineGroupRepository,
  deadlinesDueQuery,
  INSIGHTS_DRILL_LIMIT,
  openedInPeriod,
  openedMattersQuery,
  openedMattersRepository,
  type DeadlineItem,
} from '@materia/data-access/repository';
import { dateOnlyAt, type DateOnly, type DeadlineResult, type MatterType } from '@materia/domain';
import { injectDialogRef, MtButton, MtDateOnlyPipe, MtDialog, MtEmptyState } from '@materia/ui';

import { DEADLINE_DRILL } from './insights-view';

/** What a drill-down lists: matters of a type opened in the period, or deadlines due in it by result. */
export type InsightsDrillData =
  | {
      kind: 'matters';
      type: MatterType;
      /** "Probate matters opened". */
      title: string;
      periodLabel: string;
      start: DateOnly;
      end: DateOnly;
      timeZone: string;
    }
  | {
      kind: 'deadlines';
      result: DeadlineResult;
      /** "Deadlines met late". */
      title: string;
      periodLabel: string;
      start: DateOnly;
      end: DateOnly;
    };

interface DrillRow {
  id: string;
  primary: string;
  secondary: string;
  date: DateOnly;
  link: string[];
}

/** Whether a done deadline was met on time or late (INS-01: late when recorded after its due date). */
export function deadlineMatchesResult(row: DeadlineItem, result: DeadlineResult): boolean {
  if (row.deletedAt || !row.dueDate) return false;
  if (result !== 'metOnTime' && result !== 'metLate') return true;
  const late = !!row.resolution?.on && row.resolution.on > row.dueDate;
  return result === 'metLate' ? late : !late;
}

/**
 * An Insights drill-down (INS-02): the records behind a bar, in a dialog, each linking to its
 * matter. Read once from Firestore with the period's bounds, the same records INS-01 counted.
 */
@Component({
  selector: 'mt-insights-drill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtDateOnlyPipe, MtDialog, MtEmptyState, RouterLink],
  template: `
    <mt-dialog size="md" [title]="data.title" [description]="data.periodLabel">
      @if (rows.isLoading() || !context.role()) {
        <div class="drill-loading" aria-busy="true">
          <span class="mt-sr">Loading</span>
          @for (i of [1, 2, 3]; track i) {
            <span class="mt-skel" style="height: 32px"></span>
          }
        </div>
      } @else if (rows.error()) {
        <p class="t-danger" role="alert" style="margin: 0">These couldn’t be loaded.</p>
      } @else if (list().length === 0) {
        <mt-empty-state title="Nothing to list" description="None of these are visible to you." [headingLevel]="3" />
      } @else {
        <ul class="drill-list" data-drill-list>
          @for (row of list(); track row.id) {
            <li>
              <a [routerLink]="row.link" (click)="ref.close()">
                <span class="primary">{{ row.primary }}</span>
                <span class="caption t-3">{{ row.secondary }}</span>
              </a>
              <span class="mono-s t-3">{{ row.date | dateOnly }}</span>
            </li>
          }
        </ul>
        @if (capped()) {
          <p class="caption t-3" style="margin: 8px 0 0">Showing the first {{ limit }}.</p>
        }
      }
      <ng-container mtDialogFooter>
        <button mtButton variant="secondary" (click)="ref.close()">Close</button>
      </ng-container>
    </mt-dialog>
  `,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/skel.css'],
  styles: `
    .drill-loading {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .drill-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
    }
    .drill-list li {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 0;
      border-top: 1px solid var(--border-subtle);
    }
    .drill-list li:first-child {
      border-top: 0;
    }
    .drill-list a {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-width: 0;
      color: inherit;
      text-decoration: none;
      border-radius: var(--radius-xs);
    }
    .drill-list a:hover .primary {
      text-decoration: underline;
    }
    .drill-list a:focus-visible {
      box-shadow: var(--focus-ring);
      outline: none;
    }
    .drill-list .primary {
      font: 500 13px/18px var(--font-sans);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
})
export class InsightsDrill {
  protected readonly ref = injectDialogRef<InsightsDrillData, undefined>();
  protected readonly data = this.ref.data;
  protected readonly limit = INSIGHTS_DRILL_LIMIT;
  protected readonly context = inject(OrgContext);
  private readonly privilegedVisible = can('privileged.view');
  private readonly matters = openedMattersRepository();
  private readonly deadlines = deadlineGroupRepository();

  protected readonly rows = resource({
    params: () => (this.context.role() ? { privilegedVisible: this.privilegedVisible() } : undefined),
    loader: ({ params }) => this.load(params.privilegedVisible),
  });
  private readonly loaded = computed(() => (this.rows.hasValue() ? this.rows.value() : null));
  protected readonly list = computed(() => this.loaded()?.rows ?? []);
  protected readonly capped = computed(() => this.loaded()?.capped ?? false);

  private async load(privilegedVisible: boolean): Promise<{ rows: DrillRow[]; capped: boolean }> {
    const data = this.data;
    if (data.kind === 'matters') {
      const found = await this.matters.query(
        openedMattersQuery(data.type, data.start, data.end, { privilegedVisible }),
      );
      const rows = found
        .filter((row) => openedInPeriod(row, data.start, data.end, data.timeZone))
        .map((row) => ({
          id: row.id,
          primary: `${row.number} ${row.title}`,
          secondary: row.status === 'closed' || row.status === 'archived' ? 'Closed' : 'Open',
          date: dateOnlyAt(row.createdAt, data.timeZone),
          link: ['/matters', row.id],
        }));
      return { rows, capped: found.length >= INSIGHTS_DRILL_LIMIT };
    }
    const found = await this.deadlines.query(deadlinesDueQuery(DEADLINE_DRILL[data.result], data.start, data.end));
    const rows = found
      .filter((row) => deadlineMatchesResult(row, data.result))
      .map((row) => ({
        id: row.id,
        primary: row.title,
        secondary: row.critical ? 'Critical' : row.kind === 'statutory' ? 'Statutory' : 'Deadline',
        date: row.dueDate as DateOnly,
        link: ['/matters', row.matterId ?? '', 'deadlines'],
      }));
    return { rows, capped: found.length >= INSIGHTS_DRILL_LIMIT };
  }
}
