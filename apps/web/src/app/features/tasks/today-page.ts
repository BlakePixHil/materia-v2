import { ChangeDetectionStrategy, Component, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';

import { MtEmptyState } from '@materia/ui';

import { MyTasks } from './my-tasks';

/**
 * Today (`/today`): for now, my tasks due this week (CORE-08). CORE-14 adds Clerk's brief, this
 * week's deadlines, numbers and captured time.
 */
@Component({
  selector: 'mt-today-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/card.css'],
  imports: [MtEmptyState, MyTasks, RouterLink],
  host: { class: 'mt-col mt-today', style: 'gap: 20px; flex: 1; min-width: 0; max-width: 1040px' },
  template: `
    <h1 class="title-l" style="margin: 0">Today</h1>
    <section class="mt-card" data-pad aria-labelledby="mt-today-tasks">
      <div class="mt-card-h">
        <h2 class="mt-card-title" id="mt-today-tasks">My tasks</h2>
        <a class="mt-ml caption" routerLink="/tasks">All my tasks</a>
      </div>
      <mt-my-tasks compact [headingLevel]="3" />
    </section>
    <mt-empty-state
      title="More coming in CORE-14"
      description="Clerk’s morning brief, this week’s deadlines, your numbers and captured time."
      icon="today"
      [headingLevel]="2"
    />
  `,
  styles: `
    .mt-today h2 {
      margin: 0;
    }
  `,
})
export class TodayPage {}
