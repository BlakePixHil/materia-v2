import { ChangeDetectionStrategy, Component, computed, inject, signal, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';

import { latestMigrationRuns, migrationCallables, migrationRunsRepository } from '@materia/data-access/repository';
import { MIGRATION_REVIEW_CODES, type MigrationReviewResult } from '@materia/domain';
import { formatDateOnly, MtBadge, MtButton, MtEmptyState, MtNote, MtProgress, MT_ORG_TIMEZONE } from '@materia/ui';

import { importRows, plural, progressText, warningGroups } from './migration-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';

/**
 * Import from materia (`/settings/migration`, MIG-08; owners and admins, shown once the practice has
 * a legacy migration run): the onboarding step for a practice brought across from the old materia.
 * What came across (the run's counts), what to check by reason (the review codes), progress, and
 * the way into the review queue and the matters. The run itself is the migration tool's (MIG-06);
 * a rollback says so here.
 */
@Component({
  selector: 'mt-migration-summary-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [RouterLink, MtBadge, MtButton, MtEmptyState, MtNote, MtProgress],
  styleUrls: ['../../../../../../libs/ui/src/generated/components/table.css'],
  host: { class: 'mt-migration-summary mt-col' },
  template: `
    <header class="mt-col head">
      @if (importRun(); as run) {
        <span class="eyebrow t-3" data-imported>{{ eyebrow(run.mode, run.finishedAt ?? run.startedAt) }}</span>
      }
      <h1 class="title-l">Bring in your matters</h1>
      <p class="body t-2">
        Your matters, contacts and documents came across from the old materia. Check the records it flagged, then work
        from your matters as usual. Nothing is left in the old system.
      </p>
    </header>

    @if (!runs.value().length) {
      @if (runs.status() === 'ready') {
        <mt-empty-state
          icon="inbox"
          title="Nothing imported"
          description="Bringing a practice across from the old materia is done with you by the Materia team."
        />
      } @else {
        <p role="status" class="caption t-3">Loading…</p>
      }
    } @else {
      @if (rolledBack()) {
        <mt-note tone="warning" data-rolled-back>
          The latest import was rolled back, so its records are gone. Once it’s loaded again, what came across shows
          here.
        </mt-note>
      } @else if (latest()?.status === 'running') {
        <mt-note tone="info">An import is running. What came across fills in as it finishes.</mt-note>
      } @else if (latest()?.status === 'failed') {
        <mt-note tone="danger">The latest import stopped part way. The Materia team will run it again.</mt-note>
      }
      @if (loadError(); as message) {
        <mt-note tone="danger">{{ message }}</mt-note>
      }

      @if (review(); as r) {
        @if (!rolledBack()) {
          <section class="mt-card progress" data-pad aria-labelledby="mt-import-progress" data-section="progress">
            <h2 class="mt-card-title" id="mt-import-progress">Your review</h2>
            <mt-progress
              [value]="r.percent"
              label="Reviewed"
              [tone]="r.open ? 'brand' : 'success'"
              size="md"
              [valueLabel]="r.percent + '%'"
            />
            <p class="label" data-progress>{{ progressText(r) }}</p>
            <div class="mt-row actions">
              @if (r.open) {
                <a mtButton variant="primary" size="sm" routerLink="/settings/migration/review" iconEnd="arrow-right"
                  >Review {{ plural(r.open, 'item') }}</a
                >
              }
              <a mtButton [variant]="r.open ? 'secondary' : 'primary'" size="sm" routerLink="/matters"
                >Open my matters</a
              >
            </div>
          </section>
        }
      }

      @if (importRun(); as run) {
        @if (rows().length) {
          <section class="mt-card" data-pad aria-labelledby="mt-import-came" data-section="came-across">
            <h2 class="mt-card-title" id="mt-import-came">What came across</h2>
            <div class="table-wrap">
              <table class="mt-table">
                <thead>
                  <tr>
                    <th scope="col">Records</th>
                    <th scope="col" class="num">Count</th>
                    <th scope="col"><span class="mt-sr">Status</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of rows(); track row.file) {
                    <tr [attr.data-file]="row.file">
                      <td>{{ row.label }}</td>
                      <td class="num">{{ row.count.toLocaleString('en-AU') }}</td>
                      <td>
                        @if (row.open) {
                          <mt-badge tone="warning">{{ row.open }} to check</mt-badge>
                        } @else {
                          <mt-badge tone="success">Brought across</mt-badge>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
      }

      @if (toCheck().length) {
        <section class="mt-card" data-pad aria-labelledby="mt-import-check" data-section="to-check">
          <h2 class="mt-card-title" id="mt-import-check">What to check</h2>
          <ul class="reasons">
            @for (reason of toCheck(); track reason.code) {
              <li [attr.data-code]="reason.code">
                <div class="mt-col text">
                  <span class="label"
                    >{{ reason.label }} <span class="t-3">· {{ reason.open }}</span></span
                  >
                  <span class="caption t-2">{{ reason.help }}</span>
                </div>
                <a
                  mtButton
                  size="sm"
                  variant="ghost"
                  routerLink="/settings/migration/review"
                  [queryParams]="{ code: reason.code }"
                  >Review<span class="mt-sr"> {{ reason.label }}</span></a
                >
              </li>
            }
          </ul>
        </section>
      }

      @if (warnings().length) {
        <section class="mt-card" data-pad aria-labelledby="mt-import-left" data-section="left-alone">
          <h2 class="mt-card-title" id="mt-import-left">Left as they were</h2>
          <p class="caption t-2">The import didn’t change these. The Materia team has the list.</p>
          <ul class="reasons">
            @for (group of warnings(); track group.code) {
              <li [attr.data-warning]="group.code">
                <span class="label">{{ group.label }}</span
                ><span class="t-3">{{ group.count }}</span>
              </li>
            }
          </ul>
        </section>
      }
    }
  `,
  styles: `
    .mt-migration-summary {
      gap: var(--space-16);
      max-width: 860px;
    }
    .mt-migration-summary .head {
      gap: var(--space-8);
    }
    .mt-migration-summary .head h1,
    .mt-migration-summary .head p {
      margin: 0;
    }
    .mt-migration-summary .head p {
      max-width: 600px;
    }
    .mt-migration-summary .mt-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
    }
    .mt-migration-summary .mt-card p {
      margin: 0;
    }
    .mt-migration-summary .actions {
      gap: var(--space-8);
      flex-wrap: wrap;
    }
    .mt-migration-summary .table-wrap {
      margin: 0 calc(-1 * var(--space-16));
      overflow-x: auto;
    }
    .mt-migration-summary .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .mt-migration-summary .reasons {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .mt-migration-summary .reasons li {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-12);
      padding: var(--space-8) 0;
      border-top: 1px solid var(--border-subtle);
    }
    .mt-migration-summary .reasons li:first-child {
      border-top: 0;
    }
    .mt-migration-summary .reasons .text {
      gap: 2px;
      min-width: 0;
    }
  `,
})
export class MigrationSummaryPage {
  private readonly api = migrationCallables(inject(CALLABLES));
  private readonly timeZone = inject(MT_ORG_TIMEZONE);
  protected readonly runs = migrationRunsRepository().watchQuery({ pageSize: 50 });
  protected readonly review = signal<MigrationReviewResult | null>(null);
  protected readonly loadError = signal<string | null>(null);

  protected readonly progressText = progressText;
  protected readonly plural = plural;

  private readonly picked = computed(() => latestMigrationRuns(this.runs.value()));
  protected readonly latest = computed(() => this.picked().latest);
  protected readonly importRun = computed(() => this.picked().import);
  protected readonly rolledBack = computed(() => {
    const status = this.latest()?.status;
    return status === 'rolled_back' || status === 'rolling_back';
  });
  protected readonly rows = computed(() => importRows(this.importRun()?.counts ?? {}, this.review()));
  protected readonly toCheck = computed(() =>
    this.rolledBack()
      ? []
      : (this.review()?.codes ?? [])
          .filter((count) => count.open > 0)
          .map((count) => ({ ...count, ...MIGRATION_REVIEW_CODES[count.code] })),
  );
  /** The import's own warnings, and every later delta's. */
  protected readonly warnings = computed(() => {
    const run = this.importRun();
    if (!run || this.rolledBack()) return [];
    const since = run.startedAt.getTime();
    return warningGroups(
      this.runs
        .value()
        .filter((each) => each.runId === run.runId || (each.mode === 'delta' && each.startedAt.getTime() > since))
        .flatMap((each) => each.warnings),
    );
  });

  constructor() {
    void this.load();
  }

  protected eyebrow(mode: string, at: Date): string {
    const day = formatDateOnly(at, this.timeZone);
    return `${mode === 'rehearsal' ? 'Practice run' : 'Imported'} from materia · ${day}`;
  }

  private async load(): Promise<void> {
    try {
      this.review.set(await this.api.review({ limit: 0 }));
    } catch (error) {
      this.loadError.set(errorCopy(error));
    }
  }
}
