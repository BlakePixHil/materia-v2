import { afterNextRender, Directive, ElementRef, inject, input } from '@angular/core';

/**
 * Stories only: forces an interaction state (`data-hover`, `data-focus-visible`, `data-focus`,
 * `data-press`) after render, the way the design-system previews pin states with `data-static`.
 * `target` picks a descendant (for example `.mt-input`); by default the host itself.
 */
@Directive({ selector: '[mtStoryState]' })
export class MtStoryState {
  readonly state = input.required<'hover' | 'focus-visible' | 'focus' | 'press'>({ alias: 'mtStoryState' });
  readonly target = input<string>();

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterNextRender(() => {
      const selector = this.target();
      const element = selector ? host.querySelector(selector) : host;
      element?.setAttribute(`data-${this.state()}`, '');
    });
  }
}

/** A labelled grid for state matrices (row label, then one cell per state). */
export const STATE_GRID_STYLES = `
  .sg { display: grid; gap: 12px 16px; align-items: center; justify-items: start; }
  .sg-h { font: 500 11px/14px var(--font-mono); text-transform: uppercase; letter-spacing: .04em; color: var(--text-tertiary); }
`;
