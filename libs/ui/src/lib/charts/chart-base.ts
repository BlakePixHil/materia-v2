import {
  afterNextRender,
  booleanAttribute,
  computed,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
} from '@angular/core';

import { type ChartDatum, type ChartFormat, chartSummary } from './scales';

/** The tooltip for the point under the pointer or keyboard focus. */
export interface ChartTip {
  index: number;
  x: number;
  y: number;
  value: string;
  caption: string;
  extra?: string | undefined;
}

const defaultFormat: ChartFormat = (value) => value.toLocaleString('en-AU');

/** Truncates long category labels for axes; the full text is in the tooltip and table. */
export function truncateLabel(label: string, max = 12): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/**
 * Shared chart behaviour: data and formatting inputs, the generated summary, responsive width
 * (ResizeObserver), roving keyboard focus over data points (arrows, Home, End) and the tooltip.
 */
@Directive()
export abstract class MtChartBase {
  readonly data = input.required<readonly ChartDatum[]>();
  /** What the chart shows ("Billed by month"); the start of the accessible summary and the table caption. */
  readonly label = input.required<string>();
  /** Formats values for tooltips, labels and the table. */
  readonly format = input<ChartFormat>(defaultFormat);
  /** Formats axis ticks; defaults to `format`. */
  readonly tickFormat = input<ChartFormat>();
  /** Header of the category column in the table view ("Month"). */
  readonly categoryLabel = input('Label');
  /** Header of the value column in the table view ("Billed"). */
  readonly valueLabel = input('Value');
  readonly loading = input(false, { transform: booleanAttribute });
  readonly emptyText = input('No data for this period');
  /**
   * Points open something (drill-down, INS-02): a click, or Enter or Space on a focused point, emits
   * `pointSelect` with its datum, and the points act as buttons. The SVG is then a labelled `group`,
   * since an `img` can't hold buttons.
   */
  readonly drill = input(false, { transform: booleanAttribute });
  readonly pointSelect = output<ChartDatum>();

  protected readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  /** Measured width of the chart area in CSS pixels. */
  protected readonly width = signal(0);
  protected readonly activeIndex = signal(0);
  protected readonly tip = signal<ChartTip | null>(null);

  protected readonly ticks = computed(() => this.tickFormat() ?? this.format());
  protected readonly summary = computed(() => chartSummary(this.label(), this.data(), this.format()));

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      this.width.set(this.host.clientWidth);
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => this.width.set(this.host.clientWidth));
      observer.observe(this.host);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  /** The tooltip text for a point (subclasses add comparison values). */
  protected tipFor(index: number): Omit<ChartTip, 'x' | 'y'> | null {
    const datum = this.data()[index];
    if (!datum) return null;
    return { index, value: this.format()(datum.value), caption: datum.meta ?? datum.label };
  }

  protected pointLabel(index: number): string {
    const datum = this.data()[index];
    return datum ? `${datum.meta ?? datum.label}: ${this.format()(datum.value)}` : '';
  }

  protected showTip(index: number, target: EventTarget | null): void {
    const content = this.tipFor(index);
    if (!content || !(target instanceof Element)) return;
    const rect = target.getBoundingClientRect();
    this.tip.set({ ...content, x: rect.left + rect.width / 2, y: rect.top });
  }

  protected hideTip(): void {
    this.tip.set(null);
  }

  protected onPointFocus(index: number, event: FocusEvent): void {
    this.activeIndex.set(index);
    this.showTip(index, event.target);
  }

  /** Opens a point (drill-down), when the chart's points open something. */
  protected selectPoint(index: number): void {
    const datum = this.data()[index];
    if (this.drill() && datum) this.pointSelect.emit(datum);
  }

  protected onPointKeydown(event: KeyboardEvent): void {
    if (this.drill() && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      this.selectPoint(this.activeIndex());
      return;
    }
    const count = this.data().length;
    const moves: Record<string, number> = {
      ArrowRight: this.activeIndex() + 1,
      ArrowDown: this.activeIndex() + 1,
      ArrowLeft: this.activeIndex() - 1,
      ArrowUp: this.activeIndex() - 1,
      Home: 0,
      End: count - 1,
    };
    const next = moves[event.key];
    if (event.key === 'Escape') {
      this.hideTip();
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    const index = Math.max(0, Math.min(count - 1, next));
    this.activeIndex.set(index);
    afterNextRender(() => this.host.querySelector<SVGElement>(`[data-point="${index}"]`)?.focus(), {
      injector: this.injector,
    });
  }
}
