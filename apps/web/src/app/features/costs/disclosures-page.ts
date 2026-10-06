import { ChangeDetectionStrategy, Component, computed, inject, signal, ViewEncapsulation } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { OrgContext } from '@materia/data-access';
import {
  disclosureReportRepository,
  MEMBER_LIST_QUERY,
  membersRepository,
  OUTSTANDING_DISCLOSURES_QUERY,
  type DisclosureReportRow,
  type WithId,
} from '@materia/data-access/repository';
import {
  addDays,
  compareDates,
  DISCLOSURE_REMINDER_DAYS,
  DISCLOSURE_STATUS_LABELS,
  DISCLOSURE_UPDATE_REASON_LABELS,
  disclosureNeedText,
  joinNames,
  type DateOnly,
} from '@materia/domain';
import {
  formatDateOnly,
  MT_TODAY,
  MtBadge,
  MtEmptyState,
  MtNote,
  MtSegmentedControl,
  type MtDateInput,
  type MtOption,
} from '@materia/ui';

import { errorCopy } from '../../core/error-copy';

type Whose = 'all' | 'mine';
const WHOSE: MtOption<Whose>[] = [
  { value: 'all', label: 'All matters' },
  { value: 'mine', label: 'My matters' },
];

/** Matters a disclosure is chased on: live and not closed. */
const CHASED = new Set(['lead', 'open', 'on_hold']);

export interface DisclosureLine {
  id: string;
  number: string;
  title: string;
  responsibleUid: string;
  status: 'required' | 'update_required';
  need: string;
  since?: DateOnly | undefined;
  /** Past the 7-day reminder. */
  overdue: boolean;
  why: string;
}

/** The report's lines: outstanding disclosures on live matters, oldest first. Exported for tests. */
export function disclosureLines(rows: readonly WithId<DisclosureReportRow>[], today: DateOnly): DisclosureLine[] {
  const lines: DisclosureLine[] = [];
  for (const row of rows) {
    const d = row.costsDisclosure;
    if (!d || (d.status !== 'required' && d.status !== 'update_required')) continue;
    if (row.deletedAt || !CHASED.has(row.status)) continue;
    const since = d.requiredSince;
    lines.push({
      id: row.id,
      number: row.number,
      title: row.title,
      responsibleUid: row.responsibleUid,
      status: d.status,
      need: disclosureNeedText({
        ...d,
        basisEstimateCents: d.basisEstimateCents ?? d.estimateCents,
        jurisdiction: row.jurisdiction,
      }),
      since,
      overdue:
        d.status === 'update_required' ||
        (!!since && compareDates(addDays(since, DISCLOSURE_REMINDER_DAYS), today) <= 0),
      why:
        d.status === 'update_required'
          ? (joinNames((d.updateReasons ?? []).map((reason) => DISCLOSURE_UPDATE_REASON_LABELS[reason])) ?? '')
          : '',
    });
  }
  return lines.sort(
    (a, b) => (a.since ?? '9999-12-31').localeCompare(b.since ?? '9999-12-31') || a.number.localeCompare(b.number),
  );
}

/**
 * `/billing/disclosures` (BILL-06, billing.view, flag `billing.costsDisclosure`): matters whose
 * costs disclosure is due and not yet given, or needs an update after a significant estimate
 * change, oldest first, with what each needs and who is responsible. Those past the 7-day reminder
 * are marked overdue. Each links to the matter's Overview, where the disclosure is generated and
 * recorded as sent.
 */
@Component({
  selector: 'mt-disclosures-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [FormsModule, RouterLink, MtBadge, MtEmptyState, MtNote, MtSegmentedControl],
  host: { class: 'mt-col mt-disclosures-page' },
  template: `
    <div class="mt-row head">
      <h1 class="title-l">Costs disclosures</h1>
      <span class="caption t-3" data-testid="disclosures-count">{{ countText() }}</span>
      <span class="mt-ml">
        <mt-segmented-control
          label="Show"
          name="whose"
          [options]="whoseOptions"
          [ngModel]="whose()"
          (ngModelChange)="whose.set($event)"
        />
      </span>
    </div>
    <p class="caption t-2 intro">
      Matters whose costs disclosure is due and not yet given, or needs an update. Generate it and record it as sent
      from the matter’s Overview.
    </p>
    @switch (report.status()) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading disclosures…</p>
      }
      @case ('error') {
        <mt-note tone="danger">{{ error() }}</mt-note>
      }
      @default {
        @if (lines().length) {
          <div class="table-wrap">
            <table data-testid="disclosures">
              <caption class="mt-sr">
                Outstanding costs disclosures, oldest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">Matter</th>
                  <th scope="col">Responsible</th>
                  <th scope="col">Status</th>
                  <th scope="col">What’s needed</th>
                  <th scope="col">Due since</th>
                </tr>
              </thead>
              <tbody>
                @for (line of lines(); track line.id) {
                  <tr data-testid="disclosure-row">
                    <td class="matter">
                      <a [routerLink]="['/matters', line.id, 'overview']">{{ line.number }}</a>
                      <span class="caption t-3">{{ line.title }}</span>
                    </td>
                    <td>{{ memberName(line.responsibleUid) }}</td>
                    <td>
                      <mt-badge [tone]="line.overdue ? 'danger' : 'warning'">{{ statusLabel(line) }}</mt-badge>
                    </td>
                    <td>
                      {{ line.need }}
                      @if (line.why) {
                        <span class="caption t-3 why">Because {{ line.why }}.</span>
                      }
                    </td>
                    <td class="when">{{ line.since ? date(line.since) : '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <mt-empty-state
            icon="billing"
            title="No disclosures outstanding"
            [description]="
              whose() === 'mine'
                ? 'Every one of your matters has its costs disclosure given or not needed.'
                : 'Every matter has its costs disclosure given or not needed.'
            "
          />
        }
      }
    }
  `,
  styles: `
    .mt-disclosures-page {
      gap: var(--space-16);
      min-width: 0;
    }
    .mt-disclosures-page h1,
    .mt-disclosures-page .intro {
      margin: 0;
    }
    .mt-disclosures-page .head {
      align-items: center;
      gap: var(--space-8) var(--space-12);
      flex-wrap: wrap;
    }
    .mt-disclosures-page .table-wrap {
      overflow-x: auto;
    }
    .mt-disclosures-page table {
      width: 100%;
      border-collapse: collapse;
    }
    .mt-disclosures-page th,
    .mt-disclosures-page td {
      padding: var(--space-8);
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid var(--border-subtle);
    }
    .mt-disclosures-page thead th {
      font: 500 12px/16px var(--font-sans);
      color: var(--text-tertiary);
    }
    .mt-disclosures-page .matter .caption,
    .mt-disclosures-page .why {
      display: block;
    }
    .mt-disclosures-page .when {
      white-space: nowrap;
    }
  `,
})
export class DisclosuresPage {
  private readonly context = inject(OrgContext);
  private readonly today = inject(MT_TODAY);
  protected readonly report = disclosureReportRepository().watchQuery(OUTSTANDING_DISCLOSURES_QUERY);
  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 }, { live: false });

  protected readonly whoseOptions = WHOSE;
  protected readonly whose = signal<Whose>('all');
  protected readonly error = computed(() => errorCopy(this.report.error()));
  protected readonly lines = computed(() => {
    const lines = disclosureLines(this.report.value(), this.today());
    const me = this.context.uid();
    return this.whose() === 'mine' ? lines.filter((line) => line.responsibleUid === me) : lines;
  });
  protected readonly countText = computed(() => {
    const lines = this.lines();
    const overdue = lines.filter((line) => line.overdue).length;
    if (!lines.length) return '';
    return `${lines.length} outstanding${overdue ? `, ${overdue} overdue` : ''}`;
  });

  protected memberName(uid: string): string {
    return this.members.value().find((member) => member.id === uid)?.displayName ?? 'Former member';
  }

  protected statusLabel(line: DisclosureLine): string {
    return line.overdue && line.status === 'required' ? 'Overdue' : DISCLOSURE_STATUS_LABELS[line.status];
  }

  protected date(value: string): string {
    return formatDateOnly(value as MtDateInput);
  }
}
