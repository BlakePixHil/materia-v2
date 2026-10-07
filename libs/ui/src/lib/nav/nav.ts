import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NgpButton } from 'ng-primitives/button';
import { NgpTooltipTrigger } from 'ng-primitives/tooltip';

import { routerLinkActiveSignal } from './router-active';
import type { MtIconName, MtIconNode } from '../../generated/icons';
import { MtIcon } from '../icon/icon';
import { mtTooltipBinding } from '../tooltip/tooltip';

/**
 * Sidebar link (`a[mtNavItem]` with `routerLink`): icon, label and an optional count. Active from the
 * router (`data-active`, `aria-current="page"`). `collapsed` shows the icon only, with the label as
 * the accessible name and a tooltip. Counts show only something actionable (unread, due).
 */
@Component({
  selector: 'a[mtNavItem]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/nav.css',
  imports: [MtIcon],
  hostDirectives: [NgpButton, NgpTooltipTrigger, { directive: RouterLinkActive, inputs: ['routerLinkActiveOptions'] }],
  host: {
    class: 'mt-nav',
    '[attr.data-active]': 'active() ? "" : null',
    '[attr.aria-current]': 'active() ? "page" : null',
    '[attr.aria-label]': 'collapsed() ? label() : null',
  },
  template: `
    @if (dot(); as color) {
      <span class="mt-dot" [style.background]="color" aria-hidden="true"></span>
    } @else if (icon(); as name) {
      <mt-icon [name]="name" />
    }
    @if (!collapsed()) {
      <span class="mt-ell">{{ label() }}</span>
      @if (count(); as n) {
        <span class="mt-nav-count">{{ n > 99 ? '99+' : n }}</span>
      }
    }
  `,
})
export class MtNavItem {
  readonly label = input.required<string>();
  readonly icon = input<MtIconName | MtIconNode>();
  /** A pinned matter's type colour (a CSS colour or token), shown as an 8px square instead of the icon. */
  readonly dot = input<string>();
  /** Shown as is up to 99, then "99+". */
  readonly count = input<number>();
  readonly collapsed = input(false, { transform: booleanAttribute });
  /**
   * Not shown as the current page even when the route matches: Matters while one of its matters is
   * open from the sidebar's Pinned section (CORE-23), so only one item reads as current.
   */
  readonly inactive = input(false, { transform: booleanAttribute });

  private readonly routeActive = routerLinkActiveSignal();
  protected readonly active = computed(() => this.routeActive() && !this.inactive());

  constructor() {
    mtTooltipBinding(
      () => (this.collapsed() ? { text: this.label() } : null),
      () => 'right',
    );
  }
}

/** One crumb: a label and, except for the current page, a router link. */
export interface MtCrumb {
  label: string;
  link?: string | readonly unknown[];
  /** Render in mono, as for matter references (`WE-142`). */
  ref?: boolean;
}

/**
 * Breadcrumb (`mt-breadcrumb`): the path to the current object. The last item is the current page
 * (`aria-current="page"`). Longer paths collapse in the middle to "…", which expands on click.
 */
@Component({
  selector: 'mt-breadcrumb',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/crumbs.css',
  imports: [MtIcon, RouterLink],
  host: { style: 'display: contents' },
  template: `
    <nav [attr.aria-label]="label()">
      <ol class="mt-crumbs">
        @for (item of visible(); track $index; let last = $last) {
          <li>
            @if (item === null) {
              <button type="button" aria-label="Show the full path" (click)="expanded.set(true)">…</button>
            } @else if (last || !item.link) {
              <span [class.ref]="item.ref" [attr.aria-current]="last ? 'page' : null">{{ item.label }}</span>
            } @else {
              <a [routerLink]="item.link" [class.ref]="item.ref">{{ item.label }}</a>
            }
            @if (!last) {
              <mt-icon name="chevron-right" [size]="14" />
            }
          </li>
        }
      </ol>
    </nav>
  `,
})
export class MtBreadcrumb {
  readonly items = input.required<readonly MtCrumb[]>();
  /** Show at most this many items before collapsing the middle (the design caps paths at three). */
  readonly max = input(3);
  readonly label = input('Breadcrumb');

  protected readonly expanded = signal(false);
  /** `null` marks the collapsed middle. */
  protected readonly visible = computed<(MtCrumb | null)[]>(() => {
    const items = this.items();
    const max = Math.max(this.max(), 2);
    if (this.expanded() || items.length <= max) return [...items];
    const first = items[0] as MtCrumb;
    return [first, null, ...items.slice(items.length - (max - 1))];
  });
}

/** One TabBar destination. `fab` raises it as the centre action (Record). */
export interface MtTabBarItem {
  label: string;
  icon: MtIconName | MtIconNode;
  link: string | readonly unknown[];
  fab?: boolean;
  /** Something actionable (unread), shown as a badge on the icon: as is up to 99, then "99+". */
  count?: number;
  /** Overrides the router's answer: More stays current on the pages it leads to. */
  active?: boolean | undefined;
}

/**
 * Mobile bottom navigation (`mt-tab-bar`): up to five destinations, 44px targets, padded for the
 * safe-area inset. The active item comes from the router.
 */
@Component({
  selector: 'mt-tab-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/tabbar.css',
  // The design has no TabBar badge yet; this one follows the sidebar count's type on the icon's corner.
  styles: `
    .mt-tabbar a {
      position: relative;
    }
    .mt-tabbar a .mt-nav-count {
      position: absolute;
      top: -4px;
      left: calc(50% + 4px);
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      border-radius: 8px;
      /* brand-600: white 10px text on brand-500 is 4.47:1, under AA; on brand-600 it is 5.76:1 (SEC-06). */
      background: var(--bg-brand-hover);
      color: var(--text-on-brand);
      font: 500 10px/16px var(--font-mono);
      text-align: center;
    }
  `,
  imports: [MtIcon, RouterLink, RouterLinkActive],
  host: { style: 'display: contents' },
  template: `
    <nav class="mt-tabbar" [attr.aria-label]="label()">
      @for (item of shown(); track item.label) {
        <a
          [routerLink]="item.link"
          routerLinkActive
          #rla="routerLinkActive"
          [attr.data-active]="(item.active ?? rla.isActive) ? '' : null"
          [attr.aria-current]="rla.isActive ? 'page' : item.active ? 'true' : null"
          [attr.aria-label]="item.fab ? item.label : null"
        >
          @if (item.fab) {
            <span class="fab"><mt-icon [name]="item.icon" [size]="20" /></span>
          } @else {
            <mt-icon [name]="item.icon" [size]="20" />
            {{ item.label }}
            <!-- After the label, so the link reads "Inbox 3" as the sidebar's does. -->
            @if (item.count; as n) {
              <span class="mt-nav-count">{{ n > 99 ? '99+' : n }}</span>
            }
          }
        </a>
      }
    </nav>
  `,
})
export class MtTabBar {
  readonly items = input.required<readonly MtTabBarItem[]>();
  readonly label = input('Main');
  /** The design allows five items; extras are dropped (and flagged in dev mode). */
  protected readonly shown = computed(() => {
    const items = this.items();
    if (items.length > 5 && typeof ngDevMode !== 'undefined' && ngDevMode) {
      console.warn(`mt-tab-bar shows at most 5 items; got ${items.length}.`);
    }
    return items.slice(0, 5);
  });
}

declare const ngDevMode: boolean | undefined;
