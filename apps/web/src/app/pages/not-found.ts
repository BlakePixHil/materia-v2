import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { MtButton, MtEmptyState } from '@materia/ui';

/** 404: the link is wrong or the page moved. */
@Component({
  selector: 'mt-not-found-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtEmptyState, RouterLink],
  host: { class: 'mt-col', style: 'gap: 20px; flex: 1; justify-content: center' },
  template: `
    <h1 class="mt-sr">Page not found</h1>
    <mt-empty-state
      icon="search"
      title="We couldn't find that page"
      description="The link may be wrong, or the page may have moved."
      [headingLevel]="2"
    >
      <a mtButton variant="primary" routerLink="/today">Go to Today</a>
    </mt-empty-state>
  `,
})
export class NotFoundPage {}
