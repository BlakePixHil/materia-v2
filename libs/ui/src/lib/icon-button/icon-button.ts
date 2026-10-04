import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  ViewEncapsulation,
} from '@angular/core';
import { NgpButton } from 'ng-primitives/button';
import { NgpTooltipTrigger } from 'ng-primitives/tooltip';

import type { MtIconName, MtIconNode } from '../../generated/icons';
import { MtIcon } from '../icon/icon';
import { mtTooltipBinding } from '../tooltip/tooltip';

export type MtIconButtonVariant = 'ghost' | 'secondary' | 'clerk';

/**
 * Icon-only button (`button[mtIconButton]`, `a[mtIconButton]`) for toolbars, row actions and panel
 * chrome. `label` is required: it is the accessible name and, by default, the tooltip.
 *
 * The tooltip (FND-09) appears after 400ms on hover or keyboard focus; `tooltipKbd` adds a shortcut.
 */
@Component({
  // An attribute selector keeps the native <button>/<a> (and its semantics) as the host.
  selector: 'button[mtIconButton], a[mtIconButton]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/ibtn.css',
  imports: [MtIcon],
  hostDirectives: [{ directive: NgpButton, inputs: ['disabled'] }, NgpTooltipTrigger],
  host: {
    class: 'mt-ibtn',
    '[attr.data-variant]': 'variantAttr()',
    '[attr.data-size]': 'size() === "sm" ? "sm" : null',
    '[attr.aria-label]': 'label()',
    '[attr.type]': 'typeAttr()',
  },
  template: `<mt-icon [name]="icon()" />`,
})
export class MtIconButton {
  readonly icon = input.required<MtIconName | MtIconNode>();
  /** Accessible name, written as the action ("More actions", "Close panel"). */
  readonly label = input.required<string>();
  readonly variant = input<MtIconButtonVariant>('ghost');
  readonly size = input<'sm' | 'md'>('md');
  /** Show `label` as a tooltip (default). */
  readonly tooltip = input(true, { transform: booleanAttribute });
  /** Shortcut shown in the tooltip, for example `mod+j`. */
  readonly tooltipKbd = input<string>();
  readonly type = input<'button' | 'submit' | 'reset'>('button');

  constructor() {
    mtTooltipBinding(() => (this.tooltip() ? { text: this.label(), kbd: this.tooltipKbd() } : null));
  }

  protected readonly variantAttr = computed(() => (this.variant() === 'clerk' ? 'ai' : this.variant()));
  private readonly isButton = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement.tagName === 'BUTTON';
  protected readonly typeAttr = computed(() => (this.isButton ? this.type() : null));
}
