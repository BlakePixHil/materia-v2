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
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { NgpPopover, NgpPopoverTrigger } from 'ng-primitives/popover';
import { filter, map } from 'rxjs';

import { DataLifecycle } from '@materia/data-access';
import { UNREAD_BADGE_LIMIT } from '@materia/data-access/repository';
import { can, type Action } from '@materia/domain';
import {
  DialogService,
  MtAvatar,
  MtBreadcrumb,
  MtButton,
  MtBrandMark,
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
  ToastService,
} from '@materia/ui';

import { MtLoadingBar } from './loading-bar';
import { NAV_ITEMS, type NavEntry, SETTINGS_ITEM, TAB_BAR_ITEMS } from './nav';
import { PageHeader } from './page-header';
import { ShortcutsDialog } from './shortcuts-dialog';
import { AuthState } from '../core/auth/auth-state';
import { ClerkPanel } from '../core/clerk/clerk-panel';
import { CommandRegistry, type Command } from '../core/commands/command-registry';
import { intentUrl } from '../core/commands/intents';
import { errorCopy } from '../core/error-copy';
import { FeatureFlagService } from '../core/flags/feature-flags';
import { MtNotificationsPopover } from '../core/notifications/notifications-popover';
import { NotificationsStore } from '../core/notifications/notifications-store';
import { OfflineError, OrgService } from '../core/orgs/org-service';
import { UserPrefsService } from '../core/profile/user-prefs';
import { ShortcutService } from '../core/shortcuts/shortcut.service';
import { MatterRefs, routeCrumbs } from '../core/title-strategy';

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
    MtBrandMark,
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
    MtNotificationsPopover,
    MtTabBar,
    NgpPopover,
    NgpPopoverTrigger,
  ],
  // The unread count on Inbox and urgent toasts (FND-20) follow the shell's lifetime.
  providers: [NotificationsStore],
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
                <!-- Firms can't set a logo yet, so the materia mark stands in for one. -->
                <mt-brand-mark [size]="20" />
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
                [count]="item.id === 'inbox' ? notifications.count() : undefined"
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
              <mt-avatar [name]="userName()" [colorKey]="userId()" [src]="avatarUrl()" size="sm" />
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
            } @else {
              <!-- The bell (CORE-22): the newest unread notifications, and the way into the Inbox. -->
              <button
                mtIconButton
                icon="bell"
                size="sm"
                data-bell
                [label]="bellLabel()"
                [ngpPopoverTrigger]="bellPopover"
                ngpPopoverTriggerPlacement="bottom-end"
              ></button>
            }
          </div>
        </div>
        <div class="mt-page">
          <router-outlet />
        </div>
      </main>

      @if (clerkOpen() && !mobile()) {
        <aside
          class="mt-clerk-panel"
          id="clerk-panel"
          aria-label="Clerk"
          [attr.data-scope]="clerkScope() ? clerkScope()?.kind + ':' + clerkScope()?.id : null"
        >
          <header>
            <mt-clerk-mark size="xs" />
            <span class="mt-grow"
              >Clerk
              @if (clerkScope(); as scope) {
                <span class="t-3"> · {{ scope.label }}</span>
              }
            </span>
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
      <div class="mt-app-tabbar"><mt-tab-bar [items]="tabBarItems()" /></div>
    }

    <ng-template #bellPopover>
      <mt-notifications-popover ngpPopover (closed)="bell()?.hide()" />
    </ng-template>

    <ng-template #orgMenu>
      <mt-menu>
        @for (org of orgChoices(); track org.orgId) {
          <button
            mtMenuItem
            [icon]="org.active ? 'check' : undefined"
            [attr.aria-current]="org.active ? 'true' : null"
            (click)="switchOrg(org.orgId, org.active)"
          >
            {{ org.name }}
          </button>
        }
        <mt-menu-separator />
        <a mtMenuItem icon="user-plus" routerLink="/settings/team">Team</a>
        @if (showTemplates()) {
          <a mtMenuItem icon="list" routerLink="/settings/templates">Matter templates</a>
        }
        @if (showNumbering()) {
          <a mtMenuItem icon="settings" routerLink="/settings/numbering">Matter numbering</a>
        }
        <a mtMenuItem icon="plus" routerLink="/onboarding">Create a practice</a>
      </mt-menu>
    </ng-template>
    <ng-template #userMenu>
      <mt-menu>
        <a mtMenuItem icon="user" routerLink="/settings/profile">Profile</a>
        <a mtMenuItem icon="settings" routerLink="/settings">Settings</a>
        <button mtMenuItem icon="eye" (click)="toggleTheme()">{{ themeLabel() }}</button>
        <button mtMenuItem icon="help" kbd="?" (click)="openShortcuts()">Keyboard shortcuts</button>
        <mt-menu-separator />
        <button mtMenuItem icon="arrow-right" (click)="signOut()">Sign out</button>
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
  /** The person's profile and preferences (CORE-20): applies their theme and density as they load. */
  private readonly userPrefs = inject(UserPrefsService);
  private readonly document = inject(DOCUMENT);
  private readonly orgs = inject(OrgService);
  private readonly toasts = inject(ToastService);
  private readonly data = inject(DataLifecycle);
  protected readonly header = inject(PageHeader);
  /** Unread in-app notifications (FND-20). */
  protected readonly notifications = inject(NotificationsStore);
  protected readonly bell = viewChild(NgpPopoverTrigger);
  /** The bell's name says how many are unread (CORE-22). */
  protected readonly bellLabel = computed(() => {
    const n = this.notifications.count();
    if (!n) return 'Notifications';
    return `Notifications, ${n > UNREAD_BADGE_LIMIT ? `${UNREAD_BADGE_LIMIT}+` : n} unread`;
  });
  /** The org switcher (FND-17). */
  protected readonly orgChoices = this.orgs.orgs;

  protected readonly settings = SETTINGS_ITEM;
  protected readonly tabBarItems = computed(() =>
    TAB_BAR_ITEMS.map((item) => (item.link === '/inbox' ? { ...item, count: this.notifications.count() } : item)),
  );
  private readonly flags = inject(FeatureFlagService);
  /** Settings → Templates (CORE-07): owners and admins, while matter templates are on. */
  /** Matter numbering settings (CORE-21a): owners and admins. */
  protected readonly showNumbering = computed(() => {
    const role = this.orgs.role();
    return role === 'owner' || role === 'admin';
  });
  protected readonly showTemplates = computed(() => {
    const role = this.orgs.role();
    return this.flags.isOn('templates.system') && (role === 'owner' || role === 'admin');
  });
  /** Nav items whose flag (if any) is on. */
  private readonly visibleNav = computed(() => NAV_ITEMS.filter((item) => this.isVisible(item)));
  protected readonly primaryNav = computed(() => this.visibleNav().filter((i) => !i.section));
  protected readonly workspaceNav = computed(() => this.visibleNav().filter((i) => i.section === 'workspace'));

  protected readonly userId = computed(() => this.auth.user()?.uid ?? 'anonymous');
  protected readonly userName = computed(
    () => this.userPrefs.profile.value()?.displayName || this.auth.user()?.displayName || 'Account',
  );
  protected readonly avatarUrl = computed(() => this.userPrefs.profile.value()?.avatarUrl ?? null);
  protected readonly orgName = computed(() => this.auth.user()?.orgName ?? 'Materia');
  protected readonly themeLabel = computed(() =>
    this.theme.resolved() === 'dark' ? 'Use light theme' : 'Use dark theme',
  );

  readonly collapsed = signal(false);
  private readonly clerk = inject(ClerkPanel);
  readonly clerkOpen = this.clerk.open;
  /** The page's subject Clerk is asked about (a matter), if any. */
  protected readonly clerkScope = this.clerk.scope;
  readonly mobile = signal(false);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );
  private readonly matterRefs = inject(MatterRefs);
  protected readonly crumbs = computed(() => {
    this.url();
    return routeCrumbs(this.router.routerState.snapshot.root, (id) => this.matterRefs.label(id));
  });

  private paletteOpen = false;
  private shortcutsOpen = false;
  private quickTimeOpen = false;

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
    this.clerk.toggle();
  }

  /**
   * Signs out (clearing cached data) and returns to sign-in. Edits made offline that haven't
   * reached the server yet would be lost, so the person can choose to wait for them (FND-19).
   */
  async signOut(): Promise<void> {
    if (await this.data.hasUnsyncedChanges()) {
      const discard = await this.dialogs.confirm({
        title: 'You have unsynced changes',
        body: 'Some changes you made offline haven’t reached Materia yet. If you sign out now, they’re lost.',
        confirmLabel: 'Sign out anyway',
        cancelLabel: 'Wait for them to sync',
        tone: 'danger',
      });
      if (!discard) {
        void this.data
          .waitForSync()
          .then(() => this.toasts.show({ title: 'Your changes are synced', tone: 'success' }));
        return;
      }
    }
    await this.auth.signOut();
    await this.router.navigateByUrl('/auth/sign-in');
  }

  /** Switches the active org; the page then reloads on Today (FND-17). Blocked while offline. */
  async switchOrg(orgId: string, active: boolean): Promise<void> {
    if (active) return;
    try {
      await this.orgs.switchOrg(orgId);
    } catch (error) {
      this.toasts.show({
        title: error instanceof OfflineError ? error.message : errorCopy(error),
        tone: 'danger',
      });
    }
  }

  toggleTheme(): void {
    // Saved to the profile too, so it follows the person to other tabs and devices (CORE-20).
    void this.userPrefs.save({ theme: this.theme.resolved() === 'dark' ? 'light' : 'dark' }).catch(() => undefined);
  }

  /** Opens the ⌘K palette on top of whatever is open; focus returns to the opener on close. */
  async openPalette(): Promise<void> {
    if (this.paletteOpen) return;
    this.paletteOpen = true;
    try {
      // Loaded on the first ⌘K: the palette and its search reads stay out of the initial bundle.
      const { CommandPaletteDialog } = await import('./command-palette-dialog');
      await this.dialogs.open(CommandPaletteDialog).result;
    } finally {
      this.paletteOpen = false;
    }
  }

  /**
   * Quick time entry (BILL-01): `t` or ⌘K "Log time", on the open matter when there is one. The
   * matter's Time tab takes `t` itself (its add row).
   */
  async openQuickTime(): Promise<void> {
    if (this.quickTimeOpen) return;
    this.quickTimeOpen = true;
    try {
      const { TimeQuickEntry } = await import('../features/time/time-quick-entry');
      const id = /^\/matters\/([^/?#]+)\/[^/?#]+/.exec(this.router.url)?.[1];
      const matterId = id && id !== 'new' && id !== 'board' ? id : null;
      await this.dialogs.open(TimeQuickEntry, { data: { matterId } }).result;
    } finally {
      this.quickTimeOpen = false;
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

  private canRecordTime(): boolean {
    const role = this.orgs.role();
    return !!role && can(role, 'time.record');
  }

  private isVisible(item: NavEntry): boolean {
    return !item.flag || this.flags.isOn(item.flag);
  }

  private registerShortcuts(): (() => void)[] {
    const go = (item: NavEntry) =>
      this.shortcuts.register({
        combo: `g ${item.key}`,
        description: `Go to ${item.label}`,
        group: 'Navigation',
        ...(item.flag ? { when: () => this.isVisible(item) } : {}),
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
        combo: 't',
        description: 'Log time',
        group: 'Time',
        when: () => this.canRecordTime(),
        handler: () => void this.openQuickTime(),
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
      href: item.link,
      ...(item.flag ? { when: () => this.isVisible(item) } : {}),
      run: () => void this.router.navigateByUrl(item.link),
    }));
    const allowed = (action: Action) => {
      const role = this.orgs.role();
      return !!role && can(role, action);
    };
    const general: Command[] = [
      // "Go to…" (CORE-15): drills into the destinations.
      {
        id: 'go.to',
        title: 'Go to…',
        group: 'Navigation',
        icon: 'arrow-right',
        keywords: ['navigate', 'open', 'jump'],
        children: () => navigation.map((command) => ({ ...command, group: 'Go to' })),
        run: () => undefined,
      },
      // New matter (CORE-05), from anywhere; `c` opens it on the matter screens.
      {
        id: 'matters.new',
        title: 'New matter',
        group: 'Matters',
        icon: 'plus',
        keywords: ['intake', 'open', 'estate', 'will', 'probate'],
        shortcut: 'c',
        href: '/matters/new',
        when: () => allowed('matter.create'),
        run: () => void this.router.navigateByUrl('/matters/new'),
      },
      // New contact and a personal task (CORE-15), from anywhere: the page hosting each runs it.
      {
        id: 'contacts.new-anywhere',
        title: 'New contact',
        group: 'Contacts',
        icon: 'user-plus',
        keywords: ['person', 'organisation', 'client', 'add'],
        href: intentUrl('/contacts', 'new-contact'),
        // The Contacts page offers its own (with its shortcut).
        when: () => allowed('contact.edit') && !this.router.url.startsWith('/contacts'),
        run: () => void this.router.navigateByUrl(intentUrl('/contacts', 'new-contact')),
      },
      {
        id: 'tasks.new-personal',
        title: 'New task (personal)',
        group: 'Tasks',
        icon: 'plus',
        keywords: ['todo', 'reminder', 'my tasks', 'add'],
        href: intentUrl('/tasks', 'add-task'),
        run: () => void this.router.navigateByUrl(intentUrl('/tasks', 'add-task')),
      },
      // Quick time entry (BILL-01), from anywhere.
      {
        id: 'time.log',
        title: 'Log time',
        group: 'Time',
        icon: 'timer',
        keywords: ['time entry', 'record', 'units', 'hours', 'billing'],
        shortcut: 't',
        when: () => allowed('time.record'),
        run: () => void this.openQuickTime(),
      },
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
