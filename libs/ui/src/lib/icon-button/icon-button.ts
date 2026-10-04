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

import type { MtIconName, MtIconNode } from '../../generated/icons';
import { MtIcon } from '../icon/icon';

export type MtIconButtonVariant = 'ghost' | 'secondary' | 'clerk';

/**
 * Icon-only button (`button[mtIconButton]`, `a[mtIconButton]`) for toolbars, row actions and panel
 * chrome. `label` is required: it is the accessible name and, by default, the tooltip.
 *
 * The tooltip is the native `title` for now; FND-09's Tooltip replaces it.
 */
@Component({
  // An attribute selector keeps the native <button>/<a> (and its semantics) as the host.
  selector: 'button[mtIconButton], a[mtIconButton]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/ibtn.css',
  imports: [MtIcon],
  hostDirectives: [{ directive: NgpButton, inputs: ['disabled'] }],
  host: {
    class: 'mt-ibtn',
    '[attr.data-variant]': 'variantAttr()',
    '[attr.data-size]': 'size() === "sm" ? "sm" : null',
    '[attr.aria-label]': 'label()',
    '[attr.title]': 'tooltip() ? label() : null',
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
  readonly type = input<'button' | 'submit' | 'reset'>('button');

  protected readonly variantAttr = computed(() => (this.variant() === 'clerk' ? 'ai' : this.variant()));
  private readonly isButton = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement.tagName === 'BUTTON';
  protected readonly typeAttr = computed(() => (this.isButton ? this.type() : null));
}
