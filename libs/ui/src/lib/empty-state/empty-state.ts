import { ChangeDetectionStrategy, Component, input, ViewEncapsulation } from '@angular/core';

import type { MtIconName } from '../../generated/icons';
import { MtIcon } from '../icon/icon';

/**
 * EmptyState (`mt-empty-state`): what goes here and how to get it, for an empty list or panel. Say
 * why it is empty and give the next step; project actions (buttons) as content.
 */
@Component({
  selector: 'mt-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/empty.css', '../../generated/components/layout.css'],
  imports: [MtIcon],
  host: { class: 'mt-empty' },
  template: `
    @if (icon(); as name) {
      <span class="glyph" aria-hidden="true"><mt-icon [name]="name" [size]="20" /></span>
    }
    <h3
      [attr.aria-level]="headingLevel() === 3 ? null : headingLevel()"
      [attr.role]="headingLevel() === 3 ? null : 'heading'"
    >
      {{ title() }}
    </h3>
    @if (description(); as text) {
      <p>{{ text }}</p>
    }
    <div class="mt-row mt-wrap" style="justify-content: center"><ng-content /></div>
  `,
})
export class MtEmptyState {
  readonly title = input.required<string>();
  readonly description = input<string>();
  readonly icon = input<MtIconName>();
  /** Heading level for the title within the page outline (default 3). */
  readonly headingLevel = input(3);
}
