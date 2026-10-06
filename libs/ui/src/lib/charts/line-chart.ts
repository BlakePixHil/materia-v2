import { ChangeDetectionStrategy, Component, computed, input, ViewEncapsulation } from '@angular/core';

import type { ChartTarget } from './bar-chart';
import { type ChartTip, MtChartBase, truncateLabel } from './chart-base';
import { type ChartDatum, fittedDomain, linearScale } from './scales';

const MARGIN = { l: 40, r: 64, t: 14, b: 26 };

/**
 * LineChart (`mt-line-chart`): one series as a 2px brand line with a light area wash, an end dot and
 * the latest value at the end. `comparison` adds the same measure for another period as a neutral
 * dashed line (never a second hue); `reference` adds a labelled line ("NSW registry median 38").
 *
 * Every point is focusable (arrow keys move) with a tooltip on hover and focus; the SVG is `role="img"`
 * with a generated summary, and "View as table" lists the data.
 */
@Component({
  selector: 'mt-line-chart',
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
      <div class="mt-chart-loading" [style.height.px]="chartHeight()">
        <span class="mt-sr">Loading {{ label() }}</span>
      </div>
    } @else if (data().length === 0) {
      <div class="mt-chart-empty" [style.height.px]="chartHeight()">{{ emptyText() }}</div>
    } @else {
      <svg
        class="mt-chart"
        [attr.viewBox]="'0 0 ' + geometry().w + ' ' + geometry().h"
        [attr.height]="geometry().h"
        role="img"
        [attr.aria-label]="summary()"
        (mouseleave)="hideTip()"
      >
        @for (tick of geometry().ticks; track tick.value; let first = $first) {
          <svg:line
            [attr.class]="first ? 'base' : 'grid'"
            [attr.x1]="geometry().left"
            [attr.x2]="geometry().right"
            [attr.y1]="tick.pos"
            [attr.y2]="tick.pos"
          />
          <svg:text class="tick" [attr.x]="geometry().left - 8" [attr.y]="tick.pos + 4" text-anchor="end">
            {{ tick.label }}
          </svg:text>
        }
        @for (point of geometry().points; track $index) {
          <svg:rect
            class="hit"
            [attr.role]="drill() ? 'button' : 'img'"
            [style.cursor]="drill() ? 'pointer' : null"
            [attr.data-point]="$index"
            [attr.x]="point.hit.x"
            [attr.y]="geometry().top"
            [attr.width]="point.hit.w"
            [attr.height]="geometry().bottom - geometry().top"
            [attr.tabindex]="$index === activeIndex() ? 0 : -1"
            [attr.aria-label]="pointLabel($index)"
            [attr.data-hover]="tip()?.index === $index ? '' : null"
            (mouseenter)="showTip($index, $event.target)"
            (focus)="onPointFocus($index, $event)"
            (blur)="hideTip()"
            (keydown)="onPointKeydown($event)"
            (click)="selectPoint($index)"
          />
        }
        <svg:path class="area" [attr.d]="geometry().area" pointer-events="none" />
        @if (geometry().reference; as ref) {
          <svg:line
            class="ref"
            [attr.x1]="geometry().left"
            [attr.x2]="geometry().right"
            [attr.y1]="ref.pos"
            [attr.y2]="ref.pos"
            pointer-events="none"
          />
          <svg:text class="ref-lbl" [attr.x]="geometry().left + 6" [attr.y]="ref.pos + 14">{{ ref.label }}</svg:text>
        }
        @if (geometry().comparison; as cmp) {
          <svg:polyline class="line cmp" [attr.points]="cmp" pointer-events="none" />
        }
        <svg:polyline class="line" [attr.points]="geometry().line" pointer-events="none" />
        @for (point of geometry().points; track $index) {
          @if (point.axisLabel) {
            <svg:text class="tick" [attr.x]="point.x" [attr.y]="geometry().h - 8" text-anchor="middle">
              {{ point.axisLabel }}
            </svg:text>
          }
          @if (tip()?.index === $index) {
            <svg:circle class="dot" [attr.cx]="point.x" [attr.cy]="point.y" r="4" pointer-events="none" />
          }
        }
        @if (geometry().end; as end) {
          <svg:circle class="dot" [attr.cx]="end.x" [attr.cy]="end.y" r="4" pointer-events="none" />
          <svg:text class="val" [attr.x]="end.x + 10" [attr.y]="end.y + 4">{{ end.label }}</svg:text>
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
              @if (comparison()) {
                <th scope="col" class="num">{{ comparisonLabel() }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (datum of data(); track $index) {
              <tr>
                <td>{{ datum.meta ?? datum.label }}</td>
                <td class="num">{{ format()(datum.value) }}</td>
                @if (comparison(); as cmp) {
                  <td class="num">{{ cmp[$index] ? format()(cmp[$index]!.value) : '—' }}</td>
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
        @if (t.extra) {
          <span>{{ t.extra }}</span>
        }
      </div>
    }
  `,
})
export class MtLineChart extends MtChartBase {
  /** The same measure for another period (last year), drawn neutral and dashed. */
  readonly comparison = input<readonly ChartDatum[] | null>(null);
  readonly comparisonLabel = input('Comparison');
  readonly reference = input<ChartTarget | null>(null);
  readonly chartHeight = input(200);

  protected readonly geometry = computed(() => {
    const data = this.data();
    const cmp = this.comparison() ?? [];
    const reference = this.reference();
    const w = Math.max(280, this.width() || 600);
    const h = this.chartHeight();
    const left = MARGIN.l;
    const right = w - MARGIN.r;
    const top = MARGIN.t;
    const bottom = h - MARGIN.b;
    const domain = fittedDomain(
      [...data.map((d) => d.value), ...cmp.map((d) => d.value)],
      3,
      reference ? [reference.value] : [],
    );
    const y = linearScale(domain.min, domain.max, bottom, top);
    const n = data.length;
    const step = n > 1 ? (right - left) / (n - 1) : 0;
    const x = (i: number) => (n > 1 ? left + i * step : (left + right) / 2);
    const every = Math.max(1, Math.ceil((n * 44) / Math.max(1, right - left)));
    const tickFmt = this.ticks();
    const points = data.map((d, i) => {
      const half = n > 1 ? step / 2 : (right - left) / 2;
      const hx = Math.max(left, x(i) - half);
      const hw = Math.min(right, x(i) + half) - hx;
      return {
        x: x(i),
        y: y(d.value),
        hit: { x: hx, w: hw },
        axisLabel: i % every === 0 || i === n - 1 ? truncateLabel(d.label, 8) : '',
      };
    });
    const line = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const last = points[n - 1];
    return {
      w,
      h,
      left,
      right,
      top,
      bottom,
      ticks: domain.ticks.map((value) => ({ value, pos: y(value), label: tickFmt(value) })),
      line,
      area: last ? `M${x(0).toFixed(1)},${bottom} L${line.replaceAll(' ', ' L')} L${last.x.toFixed(1)},${bottom}Z` : '',
      comparison: cmp.length
        ? cmp
            .slice(0, n)
            .map((d, i) => `${x(i).toFixed(1)},${y(d.value).toFixed(1)}`)
            .join(' ')
        : null,
      reference: reference ? { pos: y(reference.value), label: reference.label } : null,
      points,
      end: last ? { x: last.x, y: last.y, label: this.format()((data[n - 1] as ChartDatum).value) } : null,
    };
  });

  protected override tipFor(index: number): Omit<ChartTip, 'x' | 'y'> | null {
    const base = super.tipFor(index);
    const cmp = this.comparison()?.[index];
    if (!base || !cmp) return base;
    return { ...base, extra: `${this.comparisonLabel()}: ${this.format()(cmp.value)}` };
  }

  protected override pointLabel(index: number): string {
    const cmp = this.comparison()?.[index];
    const label = super.pointLabel(index);
    return cmp ? `${label}; ${this.comparisonLabel()}: ${this.format()(cmp.value)}` : label;
  }
}
