import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  Directive,
  effect,
  input,
  ViewEncapsulation,
} from '@angular/core';
import type { NgpPlacement } from 'ng-primitives/portal';
import { injectTooltipContext, injectTooltipTriggerState, NgpTooltip, NgpTooltipTrigger } from 'ng-primitives/tooltip';

import { MtKbd } from '../kbd/kbd';

/** What a tooltip shows: a short label and, optionally, the action's shortcut. */
export interface MtTooltipContent {
  text: string;
  kbd?: string | undefined;
}

/** The design system's delay before a tooltip appears. */
export const MT_TOOLTIP_DELAY_MS = 400;

/**
 * The floating panel (`mt-tooltip`). Rendered by ng-primitives into the overlay container. Text
 * with line breaks (a deadline's trace) wraps line by line instead of on one line.
 */
@Component({
  selector: 'mt-tooltip-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/tooltip.css', '../../generated/components/kbd.css'],
  styles: `
    .mt-tooltip[data-lines] {
      white-space: pre-line;
      max-width: min(420px, calc(100vw - 32px));
    }
  `,
  imports: [MtKbd],
  hostDirectives: [NgpTooltip],
  host: { class: 'mt-tooltip', '[attr.data-lines]': 'content().text.includes("\\n") ? "" : null' },
  template: `
    {{ content().text }}
    @if (content().kbd; as keys) {
      <mt-kbd [keys]="keys" />
    }
  `,
})
export class MtTooltipPanel {
  protected readonly content = injectTooltipContext<MtTooltipContent>();
}

/**
 * Wires an `NgpTooltipTrigger` on the current element to show `MtTooltipPanel` (400ms delay, on hover
 * and on keyboard focus). For components that are their own trigger, such as IconButton and NavItem;
 * call it in the constructor of a component with `hostDirectives: [NgpTooltipTrigger]`.
 */
export function mtTooltipBinding(
  content: () => MtTooltipContent | null,
  placement: () => NgpPlacement = () => 'top',
): void {
  const state = injectTooltipTriggerState();
  effect(() => {
    const trigger = state();
    const value = content();
    trigger.setTooltip(MtTooltipPanel);
    trigger.setContext(value ?? undefined);
    trigger.setDisabled(!value?.text);
    trigger.setPlacement(placement());
    trigger.setShowDelay(MT_TOOLTIP_DELAY_MS);
    trigger.setOffset(6);
  });
}

/**
 * Tooltip (`[mtTooltip]`): a short label, and the shortcut with `mtTooltipKbd`, for icon buttons and
 * truncated text. It appears after 400ms on hover or keyboard focus and is linked to the trigger with
 * `aria-describedby`. Never put actions or anything that must be read in a tooltip.
 *
 * ```html
 * <button mtButton mtTooltip="Record time" mtTooltipKbd="t">…</button>
 * ```
 */
@Directive({ selector: '[mtTooltip]', hostDirectives: [NgpTooltipTrigger] })
export class MtTooltip {
  readonly text = input.required<string>({ alias: 'mtTooltip' });
  readonly kbd = input<string>(undefined, { alias: 'mtTooltipKbd' });
  readonly placement = input<NgpPlacement>('top', { alias: 'mtTooltipPlacement' });
  readonly disabled = input(false, { alias: 'mtTooltipDisabled', transform: booleanAttribute });

  constructor() {
    mtTooltipBinding(
      () => (this.disabled() ? null : { text: this.text(), kbd: this.kbd() }),
      () => this.placement(),
    );
  }
}
