import { ChangeDetectionStrategy, Component, input, output, ViewEncapsulation } from '@angular/core';

import { MtButton } from '@materia/ui';

let nextId = 0;

/**
 * One Insights chart's card (INS-02): its title and caption, a CSV download of the chart's data,
 * and the chart (whose own "View as table" lists the same rows). A section, so a screen reader
 * can move chart to chart by heading.
 */
@Component({
  selector: 'mt-insights-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtButton],
  styleUrls: ['../../../../../../libs/ui/src/generated/components/card.css'],
  host: {
    class: 'mt-card mt-insights-card',
    role: 'region',
    '[attr.aria-labelledby]': 'headingId',
  },
  template: `
    <div class="mt-card-h">
      <h2 class="mt-card-title" [id]="headingId">{{ title() }}</h2>
      <span class="mt-ml">
        @if (caption()) {
          <span class="caption t-3">{{ caption() }}</span>
        }
        @if (csv()) {
          <button
            mtButton
            variant="ghost"
            size="sm"
            iconStart="arrow-down"
            [attr.aria-label]="'Download ' + title() + ' as CSV'"
            data-csv
            (click)="download.emit()"
          >
            CSV
          </button>
        }
      </span>
    </div>
    <ng-content />
  `,
  styles: `
    .mt-insights-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
      padding: var(--space-16);
    }
    .mt-insights-card > .mt-card-h {
      flex-wrap: wrap;
    }
    .mt-insights-card > .mt-card-h > .mt-ml {
      margin-left: auto;
    }
  `,
})
export class InsightsCard {
  readonly title = input.required<string>();
  readonly caption = input<string>('');
  /** Shows the CSV button; `download` asks for the file. */
  readonly csv = input(true);
  readonly download = output();
  protected readonly headingId = `mt-insights-card-${nextId++}`;
}
