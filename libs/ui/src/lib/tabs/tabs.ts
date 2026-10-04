import { ChangeDetectionStrategy, Component, Directive, input, ViewEncapsulation } from '@angular/core';
import { RouterLinkActive } from '@angular/router';
import { NgpTabButton, NgpTabList, NgpTabPanel, NgpTabset } from 'ng-primitives/tabs';

import type { MtIconName, MtIconNode } from '../../generated/icons';
import { MtIcon } from '../icon/icon';
import { routerLinkActiveSignal } from '../nav/router-active';

/**
 * Tabs switch between views of one object (a matter's Overview, Deadlines, Documents). Not for primary
 * navigation. Arrow keys move between tabs (Home/End jump to the ends) and activate them.
 *
 * ```html
 * <div mtTabset [(mtTabsetValue)]="tab">
 *   <div mtTabList aria-label="Matter sections">
 *     <button mtTab value="overview">Overview</button>
 *     <button mtTab value="deadlines" [count]="3">Deadlines</button>
 *   </div>
 *   <div mtTabPanel value="overview">…</div>
 *   <div mtTabPanel value="deadlines">…</div>
 * </div>
 * ```
 *
 * When the URL should be the source of truth, use `mtTabNav` with `a[mtTabLink]` instead.
 */
@Directive({
  selector: '[mtTabset]',
  hostDirectives: [
    {
      directive: NgpTabset,
      inputs: ['ngpTabsetValue: mtTabsetValue', 'ngpTabsetOrientation: mtTabsetOrientation'],
      outputs: ['ngpTabsetValueChange: mtTabsetValueChange'],
    },
  ],
})
export class MtTabset {}

/** The row of tabs (`mt-tabs`). Give it an `aria-label`. */
@Component({
  selector: '[mtTabList]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/tabs.css', '../../generated/components/tab.css'],
  hostDirectives: [NgpTabList],
  host: { class: 'mt-tabs' },
  template: `<ng-content />`,
})
export class MtTabList {}

/** One tab (`button[mtTab]`), with an optional icon and count. */
@Component({
  selector: 'button[mtTab]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/tab.css', '../../generated/components/count.css'],
  imports: [MtIcon],
  hostDirectives: [{ directive: NgpTabButton, inputs: ['ngpTabButtonValue: value', 'ngpTabButtonDisabled: disabled'] }],
  host: { class: 'mt-tab', type: 'button' },
  template: `
    @if (icon(); as name) {
      <mt-icon [name]="name" />
    }
    <ng-content />
    @if (count() !== undefined) {
      <span class="mt-count">{{ count() }}</span>
    }
  `,
})
export class MtTab {
  readonly icon = input<MtIconName | MtIconNode>();
  readonly count = input<number>();
}

/** The panel for one tab; shown only while its tab is active. */
@Component({
  selector: '[mtTabPanel]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/tabpanel.css',
  hostDirectives: [{ directive: NgpTabPanel, inputs: ['ngpTabPanelValue: value'] }],
  host: { class: 'mt-tabpanel' },
  template: `<ng-content />`,
})
export class MtTabPanel {}

/**
 * Router-linked tabs: a `nav` of links styled as tabs, for sub-pages with their own URL. The active
 * link comes from the router (`aria-current="page"` and `data-active`).
 *
 * ```html
 * <nav mtTabNav aria-label="Matter sections">
 *   <a mtTabLink routerLink="overview">Overview</a>
 *   <a mtTabLink routerLink="deadlines" [count]="3">Deadlines</a>
 * </nav>
 * ```
 */
@Component({
  selector: '[mtTabNav]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/tabs.css', '../../generated/components/tab.css'],
  host: { class: 'mt-tabs' },
  template: `<ng-content />`,
})
export class MtTabNav {}

@Component({
  selector: 'a[mtTabLink]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/tab.css', '../../generated/components/count.css'],
  imports: [MtIcon],
  hostDirectives: [{ directive: RouterLinkActive, inputs: ['routerLinkActiveOptions'] }],
  host: {
    class: 'mt-tab',
    '[attr.data-active]': 'active() ? "" : null',
    '[attr.aria-current]': 'active() ? "page" : null',
  },
  template: `
    @if (icon(); as name) {
      <mt-icon [name]="name" />
    }
    <ng-content />
    @if (count() !== undefined) {
      <span class="mt-count">{{ count() }}</span>
    }
  `,
})
export class MtTabLink {
  readonly icon = input<MtIconName | MtIconNode>();
  readonly count = input<number>();
  protected readonly active = routerLinkActiveSignal();
}

export const MT_TABS = [MtTabset, MtTabList, MtTab, MtTabPanel, MtTabNav, MtTabLink] as const;
