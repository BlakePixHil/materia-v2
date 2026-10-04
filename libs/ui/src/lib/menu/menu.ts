import { ChangeDetectionStrategy, Component, Directive, input, ViewEncapsulation } from '@angular/core';
import {
  injectMenuItemCheckboxState,
  NgpMenu,
  NgpMenuItem,
  NgpMenuItemCheckbox,
  NgpMenuTrigger,
  NgpSubmenuTrigger,
} from 'ng-primitives/menu';

import type { MtIconName, MtIconNode } from '../../generated/icons';
import { MtIcon } from '../icon/icon';
import { MtKbd } from '../kbd/kbd';

/**
 * Opens a menu from any button: `<button mtIconButton … [mtMenuTrigger]="actions">`, where
 * `actions` is an `<ng-template>` holding an `<mt-menu>`. The menu is portalled to the overlay
 * container, positioned with Floating UI (flips and shifts within the viewport), and gets roving
 * focus: arrows, Home/End, Enter/Space, and Escape, which closes only this menu.
 */
@Directive({
  selector: '[mtMenuTrigger]',
  hostDirectives: [
    {
      directive: NgpMenuTrigger,
      inputs: ['ngpMenuTrigger: mtMenuTrigger', 'ngpMenuTriggerPlacement: mtMenuPlacement'],
    },
  ],
})
export class MtMenuTrigger {}

/**
 * The menu surface (`mt-menu`). Group items with `<mt-menu-separator />`; add `<mt-menu-label>`
 * headings only when there are three or more groups. Destructive items go last.
 */
@Component({
  selector: 'mt-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/menu.css', '../../generated/components/kbd.css'],
  hostDirectives: [NgpMenu],
  host: { class: 'mt-menu' },
  template: `<ng-content />`,
})
export class MtMenu {}

/** Shared item content: icon, label, then the shortcut or a trailing glyph. */
@Directive()
abstract class MtMenuItemBase {
  readonly icon = input<MtIconName | MtIconNode>();
  /** Shortcut hint, for example `mod+e`. */
  readonly kbd = input<string>();
  /** `danger` for destructive actions (they open a confirmation); `ai` for Clerk actions. */
  readonly tone = input<'danger' | 'ai'>();
}

/** A menu action (`button[mtMenuItem]`). Closes the menu when chosen. */
@Component({
  selector: 'button[mtMenuItem], a[mtMenuItem]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/menu.css', '../../generated/components/kbd.css'],
  imports: [MtIcon, MtKbd],
  hostDirectives: [{ directive: NgpMenuItem, inputs: ['ngpMenuItemDisabled: disabled'] }],
  host: { class: 'mt-menu-item', '[attr.data-tone]': 'tone() ?? null', type: 'button' },
  template: `
    @if (icon(); as name) {
      <mt-icon [name]="name" />
    }
    <span><ng-content /></span>
    @if (kbd(); as keys) {
      <span class="hint"><mt-kbd [keys]="keys" /></span>
    }
  `,
})
export class MtMenuItem extends MtMenuItemBase {}

/** A checkable menu item (`button[mtMenuItemCheckbox]`); stays open when toggled. */
@Component({
  selector: 'button[mtMenuItemCheckbox]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/menu.css', '../../generated/components/kbd.css'],
  imports: [MtIcon],
  hostDirectives: [
    {
      directive: NgpMenuItemCheckbox,
      inputs: ['ngpMenuItemCheckboxChecked: checked', 'ngpMenuItemCheckboxDisabled: disabled'],
      outputs: ['ngpMenuItemCheckboxCheckedChange: checkedChange'],
    },
  ],
  host: {
    class: 'mt-menu-item',
    type: 'button',
    '[attr.data-selected]': 'state().checked() ? "" : null',
  },
  template: `
    @if (icon(); as name) {
      <mt-icon [name]="name" />
    }
    <span><ng-content /></span>
    @if (state().checked()) {
      <span class="hint check"><mt-icon name="check" /></span>
    }
  `,
})
export class MtMenuItemCheckbox {
  readonly icon = input<MtIconName | MtIconNode>();
  protected readonly state = injectMenuItemCheckboxState();
}

/** Opens a nested menu (`button[mtSubmenuItem]`), to the right; ArrowRight opens, ArrowLeft returns. */
@Component({
  selector: 'button[mtSubmenuItem]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/menu.css', '../../generated/components/kbd.css'],
  imports: [MtIcon],
  hostDirectives: [NgpMenuItem, { directive: NgpSubmenuTrigger, inputs: ['ngpSubmenuTrigger: mtSubmenuItem'] }],
  host: { class: 'mt-menu-item', type: 'button' },
  template: `
    @if (icon(); as name) {
      <mt-icon [name]="name" />
    }
    <span><ng-content /></span>
    <span class="hint"><mt-icon name="chevron-right" /></span>
  `,
})
export class MtSubmenuItem {
  readonly icon = input<MtIconName | MtIconNode>();
}

/** A divider between groups of items. */
@Component({
  selector: 'mt-menu-separator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/menu.css', '../../generated/components/kbd.css'],
  host: { class: 'mt-menu-sep', role: 'separator' },
  template: ``,
})
export class MtMenuSeparator {}

/** A group heading (use with three or more groups). */
@Component({
  selector: 'mt-menu-label',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/menu.css', '../../generated/components/kbd.css'],
  host: { class: 'mt-menu-label', role: 'presentation' },
  template: `<ng-content />`,
})
export class MtMenuLabel {}

/** Everything needed to build a menu, for `imports`. */
export const MT_MENU = [
  MtMenuTrigger,
  MtMenu,
  MtMenuItem,
  MtMenuItemCheckbox,
  MtSubmenuItem,
  MtMenuSeparator,
  MtMenuLabel,
] as const;
