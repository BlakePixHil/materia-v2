import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  effect,
  inject,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';

import {
  DialogService,
  MtAvatar,
  MtBreadcrumb,
  MtButton,
  MtClerkMark,
  MtIcon,
  MtIconButton,
  MtKbd,
  MtMenu,
  MtMenuItem,
  MtMenuSeparator,
  MtMenuTrigger,
  MtNavItem,
  MtTabBar,
  ThemeService,
} from '@materia/ui';

import { CommandPaletteDialog } from './command-palette-dialog';
import { MtLoadingBar } from './loading-bar';
import { NAV_ITEMS, type NavEntry, SETTINGS_ITEM, TAB_BAR_ITEMS } from './nav';
import { PageHeader } from './page-header';
import { ShortcutsDialog } from './shortcuts-dialog';
import { AuthState } from '../core/auth/auth-state';
import { CommandRegistry, type Command } from '../core/commands/command-registry';
import { ShortcutService } from '../core/shortcuts/shortcut.service';
import { routeCrumbs } from '../core/title-strategy';

/** Where the collapsed-sidebar choice is kept, per user. */
export const SIDEBAR_STORAGE_PREFIX = 'materia.shell.sidebar-collapsed.';

/** Phones get the TabBar instead of the sidebar (MOB-02 refines this). */
export const MOBILE_QUERY = '(max-width: 767px)';

/**
 * The app shell (FND-12): sidebar, inset main panel with the header (breadcrumbs, page actions and
 * the loading bar), and the Clerk panel slot. Under 768px the TabBar replaces the sidebar.
 *
 * Registers the global shortcuts (⌘K, [, ⌘J, ?, `g` + key) and the built-in commands.
 */
@Component({
  selector: 'mt-app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../../../../libs/ui/src/generated/components/app.css',
    '../../../../../libs/ui/src/generated/components/sidebar.css',
    '../../../../../libs/ui/src/generated/components/main.css',
    '../../../../../libs/ui/src/generated/components/topbar.css',
    '../../../../../libs/ui/src/generated/components/page.css',
    '../../../../../libs/ui/src/generated/components/ws.css',
    '../../../../../libs/ui/src/generated/components/input.css',
    '../../../../../libs/ui/src/generated/components/search.css',
    '../../../../../libs/ui/src/generated/components/clerk.css',
    '../../../../../libs/ui/src/generated/components/skip.css',
    '../../../../../libs/ui/src/generated/components/loading.css',
  ],
  imports: [
    NgTemplateOutlet,
    RouterLink,
    RouterOutlet,
    MtAvatar,
    MtBreadcrumb,
    MtButton,
    MtClerkMark,
    MtIcon,
    MtIconButton,
    MtKbd,
    MtLoadingBar,
    MtMenu,
    MtMenuItem,
    MtMenuSeparator,
    MtMenuTrigger,
    MtNavItem,
    MtTabBar,
  ],
  host: { style: 'display: contents' },
  template: `
    <a class="mt-skip" href="#main" (click)="skipToMain($event)">Skip to content</a>
    <div
      class="mt-app"
      data-shell
      [attr.data-collapsed]="collapsed() && !mobile() ? '' : null"
      [attr.data-clerk]="clerkOpen() && !mobile() ? '' : null"
    >
      @if (!mobile()) {
        <aside class="mt-sidebar" aria-label="Sidebar">
          <div class="mt-row" style="gap: 4px">
            @if (collapsed()) {
              <button
                mtIconButton
                icon="sidebar"
                label="Expand sidebar"
                tooltipKbd="["
                (click)="toggleSidebar()"
              ></button>
            } @else {
              <button type="button" class="mt-ws mt-grow" aria-label="Switch organisation" [mtMenuTrigger]="orgMenu">
                <mt-avatar [name]="orgName()" size="sm" kind="org" />
                <span class="mt-ell">{{ orgName() }}</span>
                <mt-icon name="chevron-down" />
              </button>
              <button
                mtIconButton
                icon="sidebar"
                size="sm"
                label="Collapse sidebar"
                tooltipKbd="["
                (click)="toggleSidebar()"
              ></button>
            }
          </div>
          <div style="padding: 4px 0 8px" [style.align-self]="collapsed() ? 'center' : null">
            @if (collapsed()) {
              <button mtIconButton icon="search" label="Search" tooltipKbd="mod+k" (click)="openPalette()"></button>
            } @else {
              <button
                type="button"
                class="mt-input mt-search"
                data-size="sm"
                aria-keyshortcuts="Meta+K Control+K"
                (click)="openPalette()"
              >
                <mt-icon name="search" />
                <span class="v">Search…</span>
                <mt-kbd keys="mod+k" aria-hidden="true" />
              </button>
            }
          </div>
          <nav aria-label="Main" class="mt-col" style="gap: 1px">
            @for (item of primaryNav(); track item.id) {
              <a
                mtNavItem
                [routerLink]="item.link"
                [label]="item.label"
                [icon]="item.icon"
                [collapsed]="collapsed()"
              ></a>
            }
            <div class="mt-nav-section" role="presentation">Workspace</div>
            @for (item of workspaceNav(); track item.id) {
              <a
                mtNavItem
                [routerLink]="item.link"
                [label]="item.label"
                [icon]="item.icon"
                [collapsed]="collapsed()"
              ></a>
            }
          </nav>
          <div
            class="mt-col"
            style="margin-top: auto; gap: 6px; padding-top: 16px"
            [style.align-items]="collapsed() ? 'center' : null"
          >
            <nav aria-label="Settings" class="mt-col" style="gap: 1px">
              <a
                mtNavItem
                [routerLink]="settings.link"
                [label]="settings.label"
                [icon]="settings.icon"
                [collapsed]="collapsed()"
              ></a>
            </nav>
            @if (collapsed()) {
              <button
                mtIconButton
                icon="sparkle"
                variant="clerk"
                label="Ask Clerk"
                tooltipKbd="mod+j"
                (click)="toggleClerk()"
              ></button>
            } @else {
              <button
                mtButton
                variant="clerk"
                iconStart="sparkle"
                kbd="mod+j"
                style="justify-content: flex-start; width: 100%"
                [attr.aria-expanded]="clerkOpen()"
                aria-controls="clerk-panel"
                (click)="toggleClerk()"
              >
                Ask Clerk
              </button>
            }
            <button
              type="button"
              class="mt-ws"
              style="font-weight: 500"
              [attr.aria-label]="'Account menu for ' + userName()"
              [mtMenuTrigger]="userMenu"
              mtMenuPlacement="top-start"
            >
              <mt-avatar [name]="userName()" [colorKey]="userId()" size="sm" />
              @if (!collapsed()) {
                <span class="mt-ell mt-grow" style="text-align: left">{{ userName() }}</span>
                <mt-icon name="updown" />
              }
            </button>
          </div>
        </aside>
      }

      <main class="mt-main" id="main" tabindex="-1">
        <mt-loading-bar />
        <div class="mt-topbar">
          <mt-breadcrumb [items]="crumbs()" />
          <div class="mt-ml mt-row" style="gap: 6px">
            @if (header.actions(); as actions) {
              <ng-container [ngTemplateOutlet]="actions" />
            }
            @if (mobile()) {
              <button mtIconButton icon="search" size="sm" label="Search" (click)="openPalette()"></button>
            }
          </div>
        </div>
        <div class="mt-page">
          <router-outlet />
        </div>
      </main>

      @if (clerkOpen() && !mobile()) {
        <aside class="mt-clerk-panel" id="clerk-panel" aria-label="Clerk">
          <header>
            <mt-clerk-mark size="xs" />
            <span class="mt-grow">Clerk</span>
            <button
              mtIconButton
              icon="x"
              size="sm"
              label="Close Clerk"
              tooltipKbd="mod+j"
              (click)="toggleClerk()"
            ></button>
          </header>
          <div class="body">
            <p style="margin: 0; text-align: center; color: var(--text-tertiary); font-size: 13px">
              Clerk arrives in AI-06.
            </p>
          </div>
        </aside>
      }
    </div>

    @if (mobile()) {
      <div class="mt-app-tabbar"><mt-tab-bar [items]="tabBarItems" /></div>
    }

    <ng-template #orgMenu>
      <mt-menu>
        <button mtMenuItem icon="check">{{ orgName() }}</button>
      </mt-menu>
    </ng-template>
    <ng-template #userMenu>
      <mt-menu>
        <a mtMenuItem icon="settings" routerLink="/settings">Settings</a>
        <button mtMenuItem icon="eye" (click)="toggleTheme()">{{ themeLabel() }}</button>
        <button mtMenuItem icon="help" kbd="?" (click)="openShortcuts()">Keyboard shortcuts</button>
        <mt-menu-separator />
        <a mtMenuItem icon="arrow-right" routerLink="/auth/sign-in">Sign out</a>
      </mt-menu>
    </ng-template>
  `,
})
export class AppShellComponent {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthState);
  private readonly shortcuts = inject(ShortcutService);
  private readonly commands = inject(CommandRegistry);
  private readonly dialogs = inject(DialogService);
  private readonly theme = inject(ThemeService);
  private readonly document = inject(DOCUMENT);
  protected readonly header = inject(PageHeader);

  protected readonly settings = SETTINGS_ITEM;
  protected readonly tabBarItems = TAB_BAR_ITEMS;
  protected readonly primaryNav = signal(NAV_ITEMS.filter((i) => !i.section));
  protected readonly workspaceNav = signal(NAV_ITEMS.filter((i) => i.section === 'workspace'));

  protected readonly userId = computed(() => this.auth.user()?.uid ?? 'anonymous');
  protected readonly userName = computed(() => this.auth.user()?.displayName ?? 'Account');
  protected readonly orgName = computed(() => this.auth.user()?.orgName ?? 'Materia');
  protected readonly themeLabel = computed(() =>
    this.theme.resolved() === 'dark' ? 'Use light theme' : 'Use dark theme',
  );

  readonly collapsed = signal(false);
  readonly clerkOpen = signal(false);
  readonly mobile = signal(false);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );
  protected readonly crumbs = computed(() => {
    this.url();
    return routeCrumbs(this.router.routerState.snapshot.root);
  });

  private paletteOpen = false;
  private shortcutsOpen = false;

  constructor() {
    const destroyRef = inject(DestroyRef);

    // Restore the collapsed choice for whoever is signed in.
    effect(() => {
      const key = SIDEBAR_STORAGE_PREFIX + this.userId();
      untracked(() => this.collapsed.set(readFlag(key)));
    });

    const media = this.document.defaultView?.matchMedia?.(MOBILE_QUERY);
    if (media) {
      this.mobile.set(media.matches);
      const onChange = (event: MediaQueryListEvent) => this.mobile.set(event.matches);
      media.addEventListener('change', onChange);
      destroyRef.onDestroy(() => media.removeEventListener('change', onChange));
    }

    const cleanups = [...this.registerShortcuts(), ...this.registerCommands()];
    destroyRef.onDestroy(() => cleanups.forEach((cleanup) => cleanup()));
  }

  toggleSidebar(): void {
    this.collapsed.update((value) => !value);
    writeFlag(SIDEBAR_STORAGE_PREFIX + this.userId(), this.collapsed());
  }

  toggleClerk(): void {
    this.clerkOpen.update((value) => !value);
  }

  toggleTheme(): void {
    this.theme.setTheme(this.theme.resolved() === 'dark' ? 'light' : 'dark');
  }

  /** Opens the ⌘K palette on top of whatever is open; focus returns to the opener on close. */
  async openPalette(): Promise<void> {
    if (this.paletteOpen) return;
    this.paletteOpen = true;
    try {
      await this.dialogs.open(CommandPaletteDialog).result;
    } finally {
      this.paletteOpen = false;
    }
  }

  async openShortcuts(): Promise<void> {
    if (this.shortcutsOpen) return;
    this.shortcutsOpen = true;
    try {
      await this.dialogs.open(ShortcutsDialog).result;
    } finally {
      this.shortcutsOpen = false;
    }
  }

  protected skipToMain(event: Event): void {
    event.preventDefault();
    this.document.getElementById('main')?.focus();
  }

  private registerShortcuts(): (() => void)[] {
    const go = (item: NavEntry) =>
      this.shortcuts.register({
        combo: `g ${item.key}`,
        description: `Go to ${item.label}`,
        group: 'Navigation',
        handler: () => void this.router.navigateByUrl(item.link),
      });
    return [
      this.shortcuts.register({
        combo: 'mod+k',
        description: 'Open the command palette',
        group: 'General',
        handler: () => void this.openPalette(),
      }),
      this.shortcuts.register({
        combo: '?',
        description: 'Show keyboard shortcuts',
        group: 'General',
        handler: () => void this.openShortcuts(),
      }),
      this.shortcuts.register({
        combo: '[',
        description: 'Collapse or expand the sidebar',
        group: 'General',
        when: () => !this.mobile(),
        handler: () => this.toggleSidebar(),
      }),
      this.shortcuts.register({
        combo: 'mod+j',
        description: 'Ask Clerk',
        group: 'General',
        handler: () => this.toggleClerk(),
      }),
      ...[...NAV_ITEMS, SETTINGS_ITEM].map(go),
    ];
  }

  private registerCommands(): (() => void)[] {
    const navigation: Command[] = [...NAV_ITEMS, SETTINGS_ITEM].map((item) => ({
      id: `go.${item.id}`,
      title: `Go to ${item.label}`,
      group: 'Navigation',
      icon: item.icon,
      keywords: [item.label],
      shortcut: `g ${item.key}`,
      run: () => void this.router.navigateByUrl(item.link),
    }));
    const general: Command[] = [
      {
        id: 'theme.toggle',
        title: 'Toggle theme',
        group: 'General',
        icon: 'eye',
        keywords: ['dark', 'light', 'appearance'],
        run: () => this.toggleTheme(),
      },
      {
        id: 'sidebar.toggle',
        title: 'Toggle sidebar',
        group: 'General',
        icon: 'sidebar',
        keywords: ['collapse', 'expand'],
        shortcut: '[',
        when: () => !this.mobile(),
        run: () => this.toggleSidebar(),
      },
      {
        id: 'shortcuts.open',
        title: 'Show keyboard shortcuts',
        group: 'General',
        icon: 'help',
        keywords: ['help', 'keys'],
        shortcut: '?',
        run: () => void this.openShortcuts(),
      },
      {
        id: 'clerk.toggle',
        title: 'Ask Clerk',
        group: 'General',
        icon: 'sparkle',
        keywords: ['ai', 'assistant'],
        shortcut: 'mod+j',
        run: () => this.toggleClerk(),
      },
    ];
    return [...navigation, ...general].map((command) => this.commands.register(command));
  }
}

function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, value ? '1' : '0');
  } catch {
    // Storage can be unavailable (private windows); the choice just isn't kept.
  }
}
