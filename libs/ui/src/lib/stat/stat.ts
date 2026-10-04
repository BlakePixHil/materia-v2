import { ChangeDetectionStrategy, Component, computed, input, ViewEncapsulation } from '@angular/core';

import type { MtIconName } from '../../generated/icons';
import { MtIcon } from '../icon/icon';

/**
 * Stat (`mt-stat`): a headline number in a card ("Billable this week 18.4 h"). The footer slot takes a
 * Progress, a Sparkline or a Delta with a caption.
 *
 * ```html
 * <mt-stat label="Work in progress" value="$42,860"><mt-sparkline [values]="wip" label="WIP, last 12 weeks" /></mt-stat>
 * ```
 */
@Component({
  selector: 'mt-stat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/stat.css', '../../generated/components/card.css'],
  imports: [MtIcon],
  host: { class: 'mt-card mt-stat' },
  template: `
    <div class="k">
      @if (icon(); as name) {
        <mt-icon [name]="name" />
      }
      {{ label() }}
    </div>
    <div class="v">
      {{ value() }}
      @if (unit(); as text) {
        <small>{{ text }}</small>
      }
    </div>
    <div class="f"><ng-content /></div>
  `,
})
export class MtStat {
  readonly label = input.required<string>();
  readonly value = input.required<string | number>();
  readonly unit = input<string>();
  readonly icon = input<MtIconName>();
}

const SPARK_WIDTH = 100;
const SPARK_HEIGHT = 28;

/** SVG points for a series scaled into a 100×28 box (top 2px kept free for the stroke). */
export function sparklinePoints(values: readonly number[]): [number, number][] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? SPARK_WIDTH / (values.length - 1) : 0;
  return values.map((value, i) => [
    Math.round(i * step * 100) / 100,
    Math.round((SPARK_HEIGHT - 2 - ((value - min) / span) * (SPARK_HEIGHT - 4)) * 100) / 100,
  ]);
}

/**
 * Sparkline (`mt-sparkline`): a small trend line for a Stat footer. `label` describes the series for
 * screen readers ("Work in progress, last 12 weeks, rising").
 */
@Component({
  selector: 'mt-sparkline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/spark.css',
  host: { style: 'display: block; flex: 1; min-width: 0' },
  template: `
    <svg class="mt-spark" viewBox="0 0 100 28" preserveAspectRatio="none" role="img" [attr.aria-label]="label()">
      @if (line(); as d) {
        <svg:path class="area" [attr.d]="area()" />
        <svg:path class="line" [attr.d]="d" />
        <svg:line class="end" [attr.x1]="end()[0]" [attr.y1]="end()[1]" [attr.x2]="end()[0]" [attr.y2]="end()[1]" />
      }
    </svg>
  `,
})
export class MtSparkline {
  readonly values = input.required<readonly number[]>();
  readonly label = input.required<string>();

  private readonly points = computed(() => sparklinePoints(this.values()));
  protected readonly line = computed(() => {
    const points = this.points();
    return points.length ? points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ') : null;
  });
  protected readonly area = computed(() => {
    const points = this.points();
    const last = points[points.length - 1] ?? [0, SPARK_HEIGHT];
    return `${this.line() ?? ''} L${last[0]} ${SPARK_HEIGHT} L0 ${SPARK_HEIGHT} Z`;
  });
  protected readonly end = computed(() => this.points()[this.points().length - 1] ?? [0, 0]);
}

/**
 * Delta (`mt-delta`): a change with direction ("▲ $2,140"). `good` says whether the change is good
 * news, which sets the colour independently of the arrow (more unbilled WIP is up and bad).
 */
@Component({
  selector: 'mt-delta',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/delta.css',
  host: { class: 'mt-delta', '[attr.data-dir]': 'tone()' },
  template: `<span aria-hidden="true">{{ direction() === 'up' ? '▲' : '▼' }}</span>
    <span class="mt-sr">{{ direction() === 'up' ? 'Up' : 'Down' }}</span> {{ value() }}`,
})
export class MtDelta {
  readonly value = input.required<string>();
  readonly direction = input.required<'up' | 'down'>();
  readonly good = input<boolean>();
  protected readonly tone = computed(() => {
    const good = this.good() ?? this.direction() === 'up';
    return good ? 'up' : 'down';
  });
}
