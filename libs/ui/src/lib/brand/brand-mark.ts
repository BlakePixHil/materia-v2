import { booleanAttribute, ChangeDetectionStrategy, Component, input, ViewEncapsulation } from '@angular/core';

/** The pillar path, drawn on a 133 × 150 grid. Filled and stroked (round joins) for the soft corners. */
export const MT_PILLAR_PATH =
  'M21 4L112 4L112 5.8L103.9 18L29.1 18L21 5.8ZM4 32L129 32L129 33.8L121.8 45L11.2 45L4 33.8ZM28 60L43 60L43 137.5L28 144.7ZM59 60L74 60L74 118.5L59 125.7ZM90 60L105 60L105 102.5L90 109.7Z';

/**
 * The materia brand mark (`mt-brand-mark`): the pillar, optionally with the "materia" wordmark. Logo
 * blue #0364B8 on light grounds, a lighter tint on dark ones so the mark keeps its contrast.
 */
@Component({
  selector: 'mt-brand-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: {
    class: 'mt-brand',
    role: 'img',
    'aria-label': 'materia',
    '[style.--mt-brand-size.px]': 'size()',
  },
  template: `
    <svg viewBox="0 0 133 150" aria-hidden="true">
      <path [attr.d]="path" stroke-width="8" stroke-linejoin="round" />
    </svg>
    @if (wordmark()) {
      <span aria-hidden="true">materia</span>
    }
  `,
  styles: `
    .mt-brand {
      --mt-logo-ink: #0364b8;
      display: inline-flex;
      align-items: center;
      gap: calc(var(--mt-brand-size) * 0.4);
      color: var(--mt-logo-ink);
    }
    [data-theme='dark'] .mt-brand {
      --mt-logo-ink: #4a9be6;
    }
    .mt-brand svg {
      display: block;
      width: auto;
      height: var(--mt-brand-size);
      fill: currentColor;
      stroke: currentColor;
      overflow: visible;
    }
    .mt-brand span {
      font: 600 calc(var(--mt-brand-size) * 0.75) / 1 var(--font-sans);
      letter-spacing: -0.02em;
      color: var(--text-primary);
    }
  `,
})
export class MtBrandMark {
  /** Height of the pillar in px; the wordmark scales with it. */
  readonly size = input(24);
  readonly wordmark = input(false, { transform: booleanAttribute });
  protected readonly path = MT_PILLAR_PATH;
}
