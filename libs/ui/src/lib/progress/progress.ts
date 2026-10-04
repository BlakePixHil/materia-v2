import { ChangeDetectionStrategy, Component, computed, input, ViewEncapsulation } from '@angular/core';

export type MtProgressTone = 'brand' | 'ai' | 'danger' | 'success';

/** A value as a percentage of `max`, clamped to 0–100. */
export function percentOf(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

/**
 * Progress (`mt-progress`): a thin bar for completion ("3 / 9 stages", "Clerk is reading statements…").
 * `label` is the accessible name; put the visible numbers next to it.
 */
@Component({
  selector: 'mt-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/progress.css',
  host: {
    class: 'mt-progress',
    role: 'progressbar',
    'aria-valuemin': '0',
    '[attr.aria-valuemax]': 'max()',
    '[attr.aria-valuenow]': 'value()',
    '[attr.aria-valuetext]': 'valueText()',
    '[attr.aria-label]': 'label()',
    '[attr.data-tone]': 'tone() === "brand" ? null : tone()',
    '[attr.data-size]': 'size() === "sm" ? null : size()',
  },
  template: `<div class="mt-progress-bar" [style.width.%]="percent()"></div>`,
})
export class MtProgress {
  readonly value = input.required<number>();
  readonly max = input(100);
  readonly label = input.required<string>();
  readonly tone = input<MtProgressTone>('brand');
  readonly size = input<'sm' | 'md'>('sm');
  /** Spoken value, such as "3 of 9 stages"; defaults to the percentage. */
  readonly valueLabel = input<string>();

  protected readonly percent = computed(() => percentOf(this.value(), this.max()));
  protected readonly valueText = computed(() => this.valueLabel() ?? `${Math.round(this.percent())}%`);
}

/**
 * Meter (`mt-meter`): a value against a target, such as utilisation against 75%. The tick marks the
 * target; `warning` tone flags a value under it.
 */
@Component({
  selector: 'mt-meter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/meter.css',
  host: {
    class: 'mt-meter',
    role: 'meter',
    'aria-valuemin': '0',
    '[attr.aria-valuemax]': 'max()',
    '[attr.aria-valuenow]': 'value()',
    '[attr.aria-valuetext]': 'valueText()',
    '[attr.aria-label]': 'label()',
    '[attr.data-tone]': 'tone() === "brand" ? null : tone()',
  },
  template: `
    <i [style.width.%]="percent()"></i>
    @if (target() !== undefined) {
      <b [style.left.%]="targetPercent()"></b>
    }
  `,
})
export class MtMeter {
  readonly value = input.required<number>();
  readonly max = input(100);
  readonly target = input<number>();
  readonly label = input.required<string>();
  readonly tone = input<'brand' | 'warning'>('brand');

  protected readonly percent = computed(() => percentOf(this.value(), this.max()));
  protected readonly targetPercent = computed(() => percentOf(this.target() ?? 0, this.max()));
  protected readonly valueText = computed(() => {
    const now = `${Math.round(this.percent())}%`;
    const target = this.target();
    return target === undefined ? now : `${now}, target ${Math.round(this.targetPercent())}%`;
  });
}
