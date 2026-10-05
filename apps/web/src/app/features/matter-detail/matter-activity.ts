import { ChangeDetectionStrategy, Component, computed, inject, ViewEncapsulation } from '@angular/core';

import { forMatter, MATTER_ACTIVITY_QUERY, matterActivityRepository } from '@materia/data-access/repository';
import { MtButton, MtEmptyState, MtNote } from '@materia/ui';
import { MtTimeline } from '@materia/ui/timeline';

import { MatterScreen } from './matter-screen';
import { errorCopy } from '../../core/error-copy';
import { activityItem } from '../notes/note-view';

/**
 * A matter's Activity tab (CORE-13): the feed the server writes (tasks, notes, documents, stages,
 * deadlines…), newest first and grouped by day, with the member's name in front of each line
 * ("Priya Shah added a note"). 25 at a time; "Load more" reads the next page. Listens to the
 * matter's activity only while this tab is shown.
 */
@Component({
  selector: 'mt-matter-activity',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtButton, MtEmptyState, MtNote, MtTimeline],
  host: { class: 'mt-matter-activity' },
  template: `
    <div class="mt-row head">
      <h2 class="title-m">Activity</h2>
    </div>
    @switch (activity.status()) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading activity…</p>
      }
      @case ('error') {
        <mt-note tone="danger">
          {{ loadError() }}
          <button mtButton size="sm" (click)="activity.refresh()">Try again</button>
        </mt-note>
      }
      @default {
        <mt-timeline
          [items]="items()"
          [hasMore]="activity.hasMore()"
          [loading]="activity.loadingMore()"
          (loadMore)="activity.loadMore()"
        >
          <mt-empty-state
            mtTimelineEmpty
            icon="clock"
            title="Nothing yet"
            description="Changes to this matter, its tasks, notes and documents show here as they happen."
            [headingLevel]="3"
          />
        </mt-timeline>
      }
    }
  `,
  styles: `
    .mt-matter-activity {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      max-width: 860px;
    }
    .mt-matter-activity h2 {
      margin: 0;
    }
  `,
})
export class MatterActivityTab {
  private readonly screen = inject(MatterScreen);
  private readonly id = this.screen.id;

  protected readonly activity = matterActivityRepository(this.id).watchQuery(forMatter(this.id, MATTER_ACTIVITY_QUERY));
  protected readonly loadError = computed(() => errorCopy(this.activity.error()));
  protected readonly items = computed(() =>
    this.activity.value().map((entry) => activityItem(entry, (uid) => this.screen.memberName(uid))),
  );
}
