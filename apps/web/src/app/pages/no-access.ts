import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { MtButton, MtEmptyState } from '@materia/ui';

/** Shown when the person's role doesn't allow the page (permission guards land with FND-16). */
@Component({
  selector: 'mt-no-access-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtEmptyState, RouterLink],
  host: { class: 'mt-col', style: 'gap: 20px; flex: 1; justify-content: center' },
  template: `
    <h1 class="mt-sr">No access</h1>
    <mt-empty-state
      icon="shield"
      title="You don't have access to this page"
      description="Ask an owner of your firm's Materia account to change your role."
      [headingLevel]="2"
    >
      <a mtButton variant="primary" routerLink="/today">Go to Today</a>
    </mt-empty-state>
  `,
})
export class NoAccessPage {}
