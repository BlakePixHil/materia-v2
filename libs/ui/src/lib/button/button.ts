import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  booleanAttribute,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';
import { NgpButton } from 'ng-primitives/button';

import type { MtIconName, MtIconNode } from '../../generated/icons';
import { MtIcon } from '../icon/icon';
import { ariaKeyShortcuts, MT_KEYBOARD_PLATFORM, MtKbd } from '../kbd/kbd';

export type MtButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'clerk';
export type MtButtonSize = 'sm' | 'md' | 'lg';

/** The design system calls the Clerk variant `ai`. */
const VARIANT_ATTR: Record<MtButtonVariant, string> = {
  primary: 'primary',
  secondary: 'secondary',
  ghost: 'ghost',
  danger: 'danger',
  clerk: 'ai',
};

/**
 * Button (`button[mtButton]`, `a[mtButton]`). `ngpButton` supplies `data-hover`, `data-press`,
 * `data-focus-visible` and `data-disabled`; the `mt-btn` CSS reads only those.
 *
 * - One `primary` per view; `clerk` for anything that invokes Clerk (pair it with the `sparkle` icon).
 * - Inside a form, a button is `type="button"` unless you set `type="submit"`.
 * - `loading` swaps the start icon for a spinner and sets `aria-busy`, keeping the width. A button
 *   without a start icon shows only the spinner, at its old width, and keeps its label for screen readers.
 */
@Component({
  // An attribute selector keeps the native <button>/<a> (and its semantics) as the host.
  selector: 'button[mtButton], a[mtButton]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/btn.css', '../../generated/components/kbd.css'],
  imports: [MtIcon, MtKbd],
  hostDirectives: [{ directive: NgpButton, inputs: ['disabled'] }],
  host: {
    class: 'mt-btn',
    '[attr.data-variant]': 'variantAttr()',
    '[attr.data-size]': 'size() === "md" ? null : size()',
    '[attr.data-loading]': 'loading() ? "" : null',
    '[attr.aria-busy]': 'loading() ? "true" : null',
    '[attr.type]': 'typeAttr()',
    '[attr.aria-keyshortcuts]': 'ariaShortcut()',
    '[style.width.px]': 'lockedWidth()',
  },
  template: `
    @if (loading()) {
      <mt-icon name="loader" />
    } @else if (iconStart(); as icon) {
      <mt-icon [name]="icon" />
    }
    <span [class.mt-sr]="labelHidden()"><ng-content /></span>
    @if (iconEnd(); as icon) {
      <mt-icon [name]="icon" />
    }
    @if (kbd(); as keys) {
      <mt-kbd [keys]="keys" aria-hidden="true" />
    }
  `,
})
export class MtButton {
  readonly variant = input<MtButtonVariant>('secondary');
  readonly size = input<MtButtonSize>('md');
  readonly loading = input(false, { transform: booleanAttribute });
  readonly iconStart = input<MtIconName | MtIconNode>();
  readonly iconEnd = input<MtIconName | MtIconNode>();
  /** Shortcut hint, for example `mod+enter`; also sets `aria-keyshortcuts`. */
  readonly kbd = input<string>();
  /** Button type. Defaults to `button` so a button in a form never submits by accident. */
  readonly type = input<'button' | 'submit' | 'reset'>('button');

  private readonly element = inject<ElementRef<HTMLButtonElement | HTMLAnchorElement>>(ElementRef).nativeElement;
  private readonly platform = inject(MT_KEYBOARD_PLATFORM);
  private readonly isButton = this.element.tagName === 'BUTTON';

  protected readonly variantAttr = computed(() => VARIANT_ATTR[this.variant()]);
  protected readonly typeAttr = computed(() => (this.isButton ? this.type() : null));
  protected readonly ariaShortcut = computed(() => {
    const keys = this.kbd();
    return keys ? ariaKeyShortcuts(keys, this.platform) : null;
  });
  protected readonly labelHidden = computed(() => this.loading() && !this.iconStart());
  protected readonly lockedWidth = signal<number | null>(null);

  constructor() {
    // Runs before the template swaps in the spinner, so this measures the resting width.
    effect(() => {
      const loading = this.loading();
      untracked(() => {
        const width = this.element.offsetWidth;
        this.lockedWidth.set(loading && width > 0 ? width : null);
      });
    });
  }
}
