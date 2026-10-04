import { ChangeDetectionStrategy, Component } from '@angular/core';

import { MyTasks } from './my-tasks';

/** `/tasks` (CORE-08): My tasks across every matter, plus personal tasks. */
@Component({
  selector: 'mt-tasks-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MyTasks],
  host: { class: 'mt-col', style: 'gap: 20px; flex: 1; min-width: 0; max-width: 1040px' },
  template: `
    <h1 class="title-l" style="margin: 0">My tasks</h1>
    <mt-my-tasks [headingLevel]="2" />
  `,
})
export class TasksPage {}
