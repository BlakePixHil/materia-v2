import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';

import { can } from '@materia/data-access';
import { latestMigrationRuns, migrationCallables, migrationRunsRepository } from '@materia/data-access/repository';
import type { MigrationReviewResult } from '@materia/domain';
import { MtButton, MtProgress } from '@materia/ui';

import { plural, progressText } from './migration-view';
import { CALLABLES } from '../../core/data/callables';

/**
 * Today's card for an imported practice (MIG-08): while owners and admins haven't finished
 * reviewing what the legacy migration flagged, how far they are and the way in. Nothing for anyone
 * else, for a practice that was never imported, or once the review is done (the callable marks
 * the run reviewed when nothing is open, and the card goes).
 */
@Component({
  selector: 'mt-today-import',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MtButton, MtProgress],
  // The card is the column's item, so the host takes no gap in Today's column when there's no card.
  host: { style: 'display: contents' },
  template: `
    @if (review(); as r) {
      @if (pending() && r.open) {
        <section class="mt-card" data-pad data-section="import" aria-labelledby="mt-today-import">
          <div class="mt-card-h">
            <h2 class="mt-card-title" id="mt-today-import">Check your import</h2>
          </div>
          <p class="caption t-2 intro">
            Your practice came across from the old materia. A few records need your eye before you rely on them.
          </p>
          <mt-progress [value]="r.percent" label="Reviewed" [valueLabel]="r.percent + '%'" />
          <p class="label">{{ progressText(r) }}</p>
          <div class="mt-row actions">
            <a mtButton size="sm" variant="primary" routerLink="/settings/migration/review"
              >Review {{ plural(r.open, 'item') }}</a
            >
            <a mtButton size="sm" variant="ghost" routerLink="/settings/migration">What came across</a>
          </div>
        </section>
      }
    }
  `,
  styles: `
    section {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    p {
      margin: 0;
    }
    .actions {
      gap: var(--space-8);
      flex-wrap: wrap;
    }
  `,
})
export class TodayImportCard {
  private readonly api = migrationCallables(inject(CALLABLES));
  private readonly canReview = can('org.settings');
  private readonly runs = migrationRunsRepository().watchQuery(() => (this.canReview() ? { pageSize: 50 } : null));
  /** The latest run succeeded and its review isn't finished. */
  protected readonly pending = computed(() => {
    const latest = latestMigrationRuns(this.runs.value()).latest;
    return latest?.status === 'succeeded' && !latest.reviewedAt;
  });
  protected readonly review = signal<MigrationReviewResult | null>(null);

  protected readonly progressText = progressText;
  protected readonly plural = plural;

  constructor() {
    effect(() => {
      if (!this.pending()) return;
      untracked(() => void this.load());
    });
  }

  private async load(): Promise<void> {
    try {
      this.review.set(await this.api.review({ limit: 0 }));
    } catch {
      // The card is a shortcut: Settings → Import still has everything.
      this.review.set(null);
    }
  }
}
