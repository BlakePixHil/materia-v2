import { ChangeDetectionStrategy, Component, computed, input, ViewEncapsulation } from '@angular/core';

import { MtChartBase, truncateLabel } from './chart-base';
import {
  bandScale,
  barThickness,
  horizontalBarPath,
  linearScale,
  MT_MAX_VERTICAL_BARS,
  niceDomain,
  verticalBarPath,
} from './scales';

/** A reference line ("Target $52k"). Solid and neutral, never a second hue. */
export interface ChartTarget {
  value: number;
  label: string;
}

const V_MARGIN = { l: 48, r: 12, t: 18, b: 26 };
const H_ROW = 28;
const H_MARGIN = { l: 120, r: 64, t: 4, b: 22 };

/**
 * BarChart (`mt-bar-chart`): one series of bars in the brand hue, from a zero baseline (negative values
 * go below it), with an optional target line and a highlighted bar (the others mute). Vertical by
 * default; horizontal with `orientation="horizontal"`, or automatically past 24 bars.
 *
 * Each bar is focusable (arrow keys move between them) and shows a tooltip on hover and focus. The SVG
 * is `role="img"` with a generated summary, and "View as table" shows the same data as a table.
 */
@Component({
  selector: 'mt-bar-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/chart.css',
    '../../generated/components/tip.css',
    '../../generated/components/tableview.css',
    '../../generated/components/table.css',
    '../../generated/components/legend.css',
  ],
  host: { class: 'mt-chart-host', '[attr.aria-busy]': 'loading()' },
  template: `
    @if (loading()) {
      <div class="mt-chart-loading" [style.height.px]="height()">
        <span class="mt-sr">Loading {{ label() }}</span>
      </div>
    } @else if (data().length === 0) {
      <div class="mt-chart-empty" [style.height.px]="height()">{{ emptyText() }}</div>
    } @else {
      <svg
        class="mt-chart"
        [attr.viewBox]="'0 0 ' + geometry().w + ' ' + geometry().h"
        [attr.height]="geometry().h"
        role="img"
        [attr.aria-label]="summary()"
        (mouseleave)="hideTip()"
      >
        @for (tick of geometry().ticks; track tick.value) {
          @if (geometry().horizontal) {
            <svg:line
              [attr.class]="tick.value === 0 ? 'base' : 'grid'"
              [attr.x1]="tick.pos"
              [attr.x2]="tick.pos"
              [attr.y1]="geometry().top"
              [attr.y2]="geometry().bottom"
            />
            <svg:text class="tick" [attr.x]="tick.pos" [attr.y]="geometry().h - 6" text-anchor="middle">
              {{ tick.label }}
            </svg:text>
          } @else {
            <svg:line
              [attr.class]="tick.value === 0 ? 'base' : 'grid'"
              [attr.x1]="geometry().left"
              [attr.x2]="geometry().right"
              [attr.y1]="tick.pos"
              [attr.y2]="tick.pos"
            />
            <svg:text class="tick" [attr.x]="geometry().left - 8" [attr.y]="tick.pos + 4" text-anchor="end">
              {{ tick.label }}
            </svg:text>
          }
        }
        @for (bar of geometry().bars; track $index) {
          <svg:rect
            class="hit"
            role="img"
            [attr.data-point]="$index"
            [attr.x]="bar.hit.x"
            [attr.y]="bar.hit.y"
            [attr.width]="bar.hit.w"
            [attr.height]="bar.hit.h"
            [attr.tabindex]="$index === activeIndex() ? 0 : -1"
            [attr.aria-label]="pointLabel($index)"
            [attr.data-hover]="tip()?.index === $index ? '' : null"
            (mouseenter)="showTip($index, $event.target)"
            (focus)="onPointFocus($index, $event)"
            (blur)="hideTip()"
            (keydown)="onPointKeydown($event)"
          />
          @if (bar.d) {
            <svg:path class="bar" [class.muted]="bar.muted" [attr.d]="bar.d" pointer-events="none" />
          }
          @if (bar.axisLabel) {
            <svg:text
              class="tick"
              [attr.x]="bar.axisX"
              [attr.y]="bar.axisY"
              [attr.text-anchor]="geometry().horizontal ? 'end' : 'middle'"
            >
              {{ bar.axisLabel }}
            </svg:text>
          }
          @if (bar.valueLabel) {
            <svg:text
              class="val"
              [attr.x]="bar.valueX"
              [attr.y]="bar.valueY"
              [attr.text-anchor]="geometry().horizontal ? 'start' : 'middle'"
            >
              {{ bar.valueLabel }}
            </svg:text>
          }
        }
        @if (geometry().target; as t) {
          @if (geometry().horizontal) {
            <svg:line
              class="ref"
              [attr.x1]="t.pos"
              [attr.x2]="t.pos"
              [attr.y1]="geometry().top"
              [attr.y2]="geometry().bottom"
              pointer-events="none"
            />
          } @else {
            <svg:line
              class="ref"
              [attr.x1]="geometry().left"
              [attr.x2]="geometry().right"
              [attr.y1]="t.pos"
              [attr.y2]="t.pos"
              pointer-events="none"
            />
            <svg:text class="ref-lbl" [attr.x]="geometry().left + 6" [attr.y]="t.pos - 6">{{ t.label }}</svg:text>
          }
        }
      </svg>
      <details class="mt-tableview">
        <summary>View as table</summary>
        <table class="mt-table">
          <caption class="mt-sr">
            {{
              label()
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">{{ categoryLabel() }}</th>
              <th scope="col" class="num">{{ valueLabel() }}</th>
              @if (target(); as t) {
                <th scope="col" class="num">{{ t.label }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (datum of data(); track $index) {
              <tr>
                <td>{{ datum.meta ?? datum.label }}</td>
                <td class="num">{{ format()(datum.value) }}</td>
                @if (target(); as t) {
                  <td class="num">{{ format()(t.value) }}</td>
                }
              </tr>
            }
          </tbody>
        </table>
      </details>
    }
    @if (tip(); as t) {
      <div class="mt-tip" role="tooltip" data-anchor="top" [style.left.px]="t.x" [style.top.px]="t.y">
        <b>{{ t.value }}</b
        ><span>{{ t.caption }}</span>
      </div>
    }
  `,
})
export class MtBarChart extends MtChartBase {
  readonly orientation = input<'vertical' | 'horizontal' | 'auto'>('auto');
  /** Index of a bar to emphasise; the others are muted. */
  readonly highlight = input<number | null>(null);
  readonly target = input<ChartTarget | null>(null);
  /** Indices of bars that show their value above them (vertical); horizontal bars always do. */
  readonly labelPoints = input<readonly number[]>([]);
  /** Height of a vertical chart. */
  readonly chartHeight = input(220);

  protected readonly horizontal = computed(
    () =>
      this.orientation() === 'horizontal' ||
      (this.orientation() === 'auto' && this.data().length > MT_MAX_VERTICAL_BARS),
  );
  protected readonly height = computed(() =>
    this.horizontal() ? this.data().length * H_ROW + H_MARGIN.t + H_MARGIN.b : this.chartHeight(),
  );

  protected readonly geometry = computed(() => {
    const data = this.data();
    const w = Math.max(280, this.width() || 720);
    const h = this.height();
    const target = this.target();
    const domain = niceDomain(
      data.map((d) => d.value),
      4,
      target ? [target.value] : [],
    );
    const fmt = this.format();
    const tickFmt = this.ticks();
    const highlight = this.highlight();
    const labelled = new Set(this.labelPoints());

    if (this.horizontal()) {
      const left = H_MARGIN.l;
      const right = w - H_MARGIN.r;
      const top = H_MARGIN.t;
      const bottom = h - H_MARGIN.b;
      const x = linearScale(domain.min, domain.max, left, right);
      const base = x(0);
      const bands = bandScale(data.length, top, bottom);
      const thick = Math.min(14, barThickness(bands.band));
      return {
        horizontal: true,
        w,
        h,
        left,
        right,
        top,
        bottom,
        ticks: domain.ticks.map((value) => ({ value, pos: x(value), label: tickFmt(value) })),
        target: target ? { pos: x(target.value), label: target.label } : null,
        bars: data.map((d, i) => {
          const yc = bands.centre(i);
          const xv = x(d.value);
          return {
            d: horizontalBarPath(yc - thick / 2, thick, xv, base),
            muted: highlight !== null && highlight !== i,
            hit: { x: left, y: bands.start(i), w: right - left, h: bands.band },
            axisLabel: truncateLabel(d.label, 18),
            axisX: left - 8,
            axisY: yc + 4,
            valueLabel: fmt(d.value),
            valueX: Math.max(xv, base) + 6,
            valueY: yc + 4,
          };
        }),
      };
    }

    const left = V_MARGIN.l;
    const right = w - V_MARGIN.r;
    const top = V_MARGIN.t;
    const bottom = h - V_MARGIN.b;
    const y = linearScale(domain.min, domain.max, bottom, top);
    const base = y(0);
    const bands = bandScale(data.length, left, right);
    const thick = barThickness(bands.band);
    // Thin out axis labels so they don't collide (about 44px each).
    const every = Math.max(1, Math.ceil((data.length * 44) / Math.max(1, right - left)));
    return {
      horizontal: false,
      w,
      h,
      left,
      right,
      top,
      bottom,
      ticks: domain.ticks.map((value) => ({ value, pos: y(value), label: tickFmt(value) })),
      target: target ? { pos: y(target.value), label: target.label } : null,
      bars: data.map((d, i) => {
        const xc = bands.centre(i);
        const yv = y(d.value);
        const show = labelled.has(i) || highlight === i;
        return {
          d: verticalBarPath(xc - thick / 2, thick, yv, base),
          muted: highlight !== null && highlight !== i,
          hit: { x: bands.start(i), y: top, w: bands.band, h: bottom - top },
          axisLabel: i % every === 0 || i === data.length - 1 ? truncateLabel(d.label) : '',
          axisX: xc,
          axisY: h - 8,
          valueLabel: show ? fmt(d.value) : '',
          valueX: xc,
          valueY: d.value >= 0 ? yv - 6 : yv + 14,
        };
      }),
    };
  });
}
