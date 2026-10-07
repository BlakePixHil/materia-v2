import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  effect,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { NgpPopover, NgpPopoverTrigger } from 'ng-primitives/popover';
import { filter, map } from 'rxjs';

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
  MtNote,
  MtTabBar,
  type MtTabBarItem,
} from '@materia/ui';

import { MtLoadingBar } from './loading-bar';
import { NAV_ITEMS, type NavEntry, SETTINGS_ITEM, TAB_BAR_ITEMS, TAB_ROOTS } from './nav';
import { PageHeader } from './page-header';
import { ShortcutsDialog } from './shortcuts-dialog';
import { AccountActions } from '../core/account/account-actions';
import { AuthState } from '../core/auth/auth-state';
import { MtMfaGraceBanner } from '../core/auth/mfa-grace-banner';
import { ClerkPanel } from '../core/clerk/clerk-panel';
import { CommandRegistry, type Command } from '../core/commands/command-registry';
import { intentUrl, onIntent } from '../core/commands/intents';
import { FeatureFlagService } from '../core/flags/feature-flags';
import { PhoneLayout } from '../core/layout/phone-layout';
import { MtNotificationsPopover } from '../core/notifications/notifications-popover';
import { NotificationsStore } from '../core/notifications/notifications-store';
import { MtDeletionBanner } from '../core/orgs/deletion-banner';
import { OrgService } from '../core/orgs/org-service';
import { PinnedMatters } from '../core/pins/pinned-matters';
import { UserPrefsService } from '../core/profile/user-prefs';
import { InstallPrompt, INSTALL_COPY } from '../core/pwa/install-prompt';
import { MtOfflineBanner } from '../core/pwa/offline-banner';
import { MtPendingSync } from '../core/pwa/pending-sync';
import { ShortcutService } from '../core/shortcuts/shortcut.service';
import { clockLabel } from '../core/timer/clock-label';
import { TimerStore, type TimerTarget } from '../core/timer/timer-store';
import { MtTimerWidget } from '../core/timer/timer-widget';
import { MatterRefs, routeCrumbs } from '../core/title-strategy';
import { ClerkChatPanel } from '../features/clerk/clerk-chat-panel';

/** Where the collapsed-sidebar choice is kept, per user. */
export const SIDEBAR_STORAGE_PREFIX = 'materia.shell.sidebar-collapsed.';
/** Where the collapsed-Pinned-section choice is kept, per user (CORE-23). */
export const PINS_STORAGE_PREFIX = 'materia.shell.pins-collapsed.';
/** How long after the shell opens this device's push registration is refreshed (MOB-04). */
const PUSH_REFRESH_DELAY_MS = 8000;

/**
 * The app shell (FND-12): sidebar, inset main panel with the header (breadcrumbs, page actions and
 * the loading bar), and the Clerk panel (its chat, AI-06, loads the first time it opens).
 *
 * Under 768px (MOB-02) the TabBar replaces the sidebar, and the header is compact: a back button to
 * the page above (or my avatar, which opens More, on a tab's own page) and the page's name, cut short
 * when it doesn't fit. It sticks to the top, clear of the notch.
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
    '../../../../../libs/ui/src/generated/components/nav.css',
  ],
  // On a phone the page's actions in the top bar show just their icons (the label stays for screen
  // readers) and no shortcut hints, so the bar fits the screen instead of widening the page. When
  // they still don't fit (Time & billing's, or a 320 px screen), they wrap onto a second row and the
  // bar grows to hold it (app.css) rather than scrolling the page sideways (WCAG 1.4.10, SEC-06).
  styles: `
    /* The page column spaces banners and the routed page. The outlet element and an empty banner take
       no room, so a page starts at the column's padding instead of two gaps further down. */
    .mt-page > router-outlet {
      display: none;
    }
    .mt-page > mt-mfa-grace-banner,
    .mt-page > mt-deletion-banner {
      display: contents;
    }
    @media (max-width: 767px) {
      .mt-topbar .mt-btn:has(> mt-icon:first-child + span) {
        width: var(--h);
        padding: 0;
      }
      .mt-topbar .mt-btn > mt-icon:first-child + span {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }
      /* The key caps, not the mt-kbd host: its inline display: contents outranks a stylesheet rule. */
      .mt-topbar .mt-btn .mt-kbd {
        display: none;
      }
      .mt-topbar > .mt-ml {
        flex-wrap: wrap;
        justify-content: flex-end;
        min-width: 0;
      }
    }
  `,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    RouterOutlet,
    MtAvatar,
    MtBreadcrumb,
    MtButton,
    MtBrandMark,
    MtClerkMark,
    MtDeletionBanner,
    MtIcon,
    MtIconButton,
    MtKbd,
    MtLoadingBar,
    MtMenu,
    MtMenuItem,
    MtMenuSeparator,
    MtMenuTrigger,
    MtMfaGraceBanner,
    MtNavItem,
    MtNote,
    MtNotificationsPopover,
    MtOfflineBanner,
    MtPendingSync,
    MtTabBar,
    MtTimerWidget,
    NgpPopover,
    NgpPopoverTrigger,
    ClerkChatPanel,
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
                [inactive]="item.id === 'matters' && pinnedOpen()"
              ></a>
            }
          </nav>
          <!-- Pinned matters (CORE-23): mine, in pinning order; not in the rail, where ⌘K reaches them. -->
          @if (!collapsed() && pinned().length) {
            <button
              type="button"
              class="mt-nav-section"
              data-toggle
              aria-controls="pinned-nav"
              [attr.aria-expanded]="pinsOpen()"
              (click)="togglePins()"
            >
              Pinned<span class="mt-nav-chev" aria-hidden="true"><mt-icon name="chevron-down" [size]="14" /></span>
            </button>
            <div class="mt-nav-group" [attr.data-closed]="pinsOpen() ? null : ''">
              <nav id="pinned-nav" aria-label="Pinned matters" class="mt-col" style="gap: 1px">
                @for (pin of pinned(); track pin.id) {
                  <a
                    mtNavItem
                    class="mt-fade"
                    [routerLink]="['/matters', pin.id]"
                    [label]="pin.title"
                    [dot]="'var(--matter-' + pin.type + ')'"
                  ></a>
                }
              </nav>
            </div>
          }
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
          @if (mobile()) {
            @if (back(); as up) {
              <a mtIconButton icon="chevron-left" data-back [routerLink]="up.link" [label]="'Back to ' + up.label"></a>
            } @else {
              <a class="mt-topbar-me" routerLink="/more" [attr.aria-label]="'More, and your account: ' + userName()">
                <mt-avatar [name]="userName()" [colorKey]="userId()" [src]="avatarUrl()" size="sm" />
              </a>
            }
            <span class="mt-topbar-title mt-ell" [class.mono]="!!pageTitle()?.ref">{{ pageTitle()?.label }}</span>
          } @else {
            <mt-breadcrumb [items]="crumbs()" />
          }
          <div class="mt-ml mt-row" style="gap: 6px">
            <!-- Changes saved on this device that haven't synced yet (MOB-01). -->
            <mt-pending-sync />
            <!-- The global timer (BILL-02): on every page. -->
            <mt-timer-widget [compact]="mobile()" [currentMatter]="currentMatter()" />
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
        <!-- You're offline (MOB-01). -->
        <mt-offline-banner />
        <div class="mt-page">
          <mt-mfa-grace-banner />
          <mt-deletion-banner />
          @if (timer.forgotten(); as flag) {
            <mt-note tone="warning" data-testid="timer-forgotten">
              {{ forgottenText() }}
              <span class="mt-row" style="gap: 6px; margin-top: 6px">
                <button mtButton size="sm" variant="primary" (click)="timer.stop()">Stop timer</button>
                <button mtButton size="sm" variant="ghost" (click)="timer.dismissForgotten()">Keep it running</button>
              </span>
            </mt-note>
          }
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
          <!-- The chat (AI-06) is a lazy chunk, loaded the first time the panel opens. -->
          @defer (on immediate) {
            <mt-clerk-chat />
          } @loading (minimum 0ms) {
            <div class="body"><p class="caption t-3" role="status">Opening Clerk…</p></div>
          } @error {
            <div class="body">
              <p class="caption t-2" role="alert">Clerk didn’t load. Reload the page to try again.</p>
            </div>
          }
          <footer
            class="clerk-panel-foot"
            style="flex: none; padding: 8px 16px; border-top: 1px solid var(--border-default); font-size: 13px"
          >
            <a routerLink="/help/clerk" (click)="toggleClerk()">How Clerk works</a>
          </footer>
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
        <button mtMenuItem icon="moon" (click)="toggleTheme()">{{ themeLabel() }}</button>
        <button mtMenuItem icon="keyboard" kbd="?" (click)="openShortcuts()">Keyboard shortcuts</button>
        @if (install.available()) {
          <button mtMenuItem icon="download" (click)="installApp()">{{ installLabel }}</button>
        }
        <mt-menu-separator />
        <button mtMenuItem icon="log-out" (click)="signOut()">Sign out</button>
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
  /** The person's profile and preferences (CORE-20): applies their theme and density as they load. */
  private readonly userPrefs = inject(UserPrefsService);
  private readonly document = inject(DOCUMENT);
  private readonly orgs = inject(OrgService);
  /** Sign out, switch org and theme: the same from the user menu and the phone's More tab. */
  private readonly account = inject(AccountActions);
  protected readonly header = inject(PageHeader);
  /** Unread in-app notifications (FND-20). */
  protected readonly notifications = inject(NotificationsStore);
  /** "Install Materia" (MOB-01). */
  protected readonly install = inject(InstallPrompt);
  protected readonly installLabel = INSTALL_COPY.menuItem;
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
  protected readonly tabBarItems = computed((): MtTabBarItem[] => {
    const path = this.path();
    const underTab = TAB_ROOTS.some((root) => path === root || path.startsWith(root + '/'));
    return TAB_BAR_ITEMS.map((item) => {
      if (item.link === '/inbox') return { ...item, count: this.notifications.count() };
      // Pages reached from More (Contacts, Settings…) keep More current.
      if (item.link === '/more') return { ...item, active: !underTab };
      return item;
    });
  });
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
  protected readonly themeLabel = this.account.themeLabel;

  readonly collapsed = signal(false);
  /** Whether the Pinned section is expanded (remembered per user). */
  readonly pinsOpen = signal(true);
  private readonly pins = inject(PinnedMatters);
  protected readonly pinned = this.pins.items;
  private readonly clerk = inject(ClerkPanel);
  readonly clerkOpen = this.clerk.open;
  /** The page's subject Clerk is asked about (a matter), if any. */
  protected readonly clerkScope = this.clerk.scope;
  /** Phone-sized: the TabBar and the compact header (MOB-02). */
  readonly mobile = inject(PhoneLayout).phone;

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );
  private readonly matterRefs = inject(MatterRefs);
  /** The global timer (BILL-02). */
  protected readonly timer = inject(TimerStore);
  /** The id of the matter open behind the shell, if any. */
  private readonly openMatterId = computed(() => {
    const id = /^\/matters\/([^/?#]+)/.exec(this.url())?.[1];
    return !id || id === 'new' || id === 'board' || id === 'destruction' ? null : id;
  });
  /** One of my pinned matters is open: its sidebar item is the current page, not Matters (CORE-23). */
  protected readonly pinnedOpen = computed(() => {
    const id = this.openMatterId();
    return !!id && !this.collapsed() && this.pinned().some((pin) => pin.id === id);
  });
  /** The matter open behind the shell (its number once the matter screen has it), for the timer. */
  protected readonly currentMatter = computed<TimerTarget | null>(
    () => {
      const id = this.openMatterId();
      if (!id) return null;
      const number = this.matterRefs.all()[id];
      return number ? { matterId: id, matterNumber: number } : null;
    },
    { equal: (a, b) => a?.matterId === b?.matterId && a?.matterNumber === b?.matterNumber },
  );
  /** The forgotten-timer banner's words. */
  protected readonly forgottenText = computed(() => {
    const timer = this.timer.timer();
    const flag = this.timer.forgotten();
    if (!timer || !flag) return '';
    const since = timer.startedAt ? clockLabel(timer.startedAt, new Date(this.timer.serverNow())) : null;
    return flag.reason === 'midnight'
      ? `Your timer on ${timer.matterNumber} has been running since ${since ?? 'yesterday'}. Did you forget to stop it?`
      : `Your timer on ${timer.matterNumber} has been running for more than 10 hours. Did you forget to stop it?`;
  });
  protected readonly crumbs = computed(() => {
    this.url();
    return routeCrumbs(this.router.routerState.snapshot.root, (id) => this.matterRefs.label(id));
  });
  /** The URL's path, without the query or fragment. */
  private readonly path = computed(() => this.url().split(/[?#]/)[0] ?? '');
  /** The phone header's crumbs: a matter's Overview is the matter itself (its number, back to Matters). */
  private readonly phoneCrumbs = computed(() => {
    const crumbs = this.crumbs();
    const matter = crumbs.at(-2);
    return matter?.ref && this.path() === `${matter.link}/overview` ? crumbs.slice(0, -1) : crumbs;
  });
  /** The phone header's title: the page's own crumb. */
  protected readonly pageTitle = computed(() => this.phoneCrumbs().at(-1) ?? null);
  /**
   * Where the phone header's back button goes: the page above in the crumbs, or More for a page
   * reached from it. A tab's own page has none (my avatar opens More instead).
   */
  protected readonly back = computed((): { label: string; link: string } | null => {
    const crumbs = this.phoneCrumbs();
    const parent = crumbs.at(-2);
    if (parent) return { label: parent.label, link: parent.link };
    const path = this.path();
    if (path === '/more' || TAB_ROOTS.includes(path) || path === '/') return null;
    return { label: 'More', link: '/more' };
  });

  private paletteOpen = false;
  private shortcutsOpen = false;
  private quickTimeOpen = false;

  constructor() {
    const destroyRef = inject(DestroyRef);

    // Restore the collapsed choices for whoever is signed in.
    effect(() => {
      const uid = this.userId();
      untracked(() => {
        this.collapsed.set(readFlag(SIDEBAR_STORAGE_PREFIX + uid));
        this.pinsOpen.set(!readFlag(PINS_STORAGE_PREFIX + uid));
      });
    });

    const cleanups = [...this.registerShortcuts(), ...this.registerCommands()];
    destroyRef.onDestroy(() => cleanups.forEach((cleanup) => cleanup()));

    // This device's push registration (MOB-04) keeps its token and last-seen date fresh, once the
    // first page has settled. Loaded then, so push stays off the start-up path.
    const injector = inject(Injector);
    const refresh = setTimeout(
      () =>
        void import('../core/push/push-devices')
          .then(({ PushDevices }) => injector.get(PushDevices).refresh())
          .catch(() => undefined),
      PUSH_REFRESH_DELAY_MS,
    );
    destroyRef.onDestroy(() => clearTimeout(refresh));

    // The installed app's "New time entry" shortcut (MOB-01) opens quick time entry over Today.
    onIntent(
      'new-time-entry',
      () => {
        if (this.canRecordTime()) void this.openQuickTime();
      },
      () => this.orgs.role() !== null,
    );
  }

  toggleSidebar(): void {
    this.collapsed.update((value) => !value);
    writeFlag(SIDEBAR_STORAGE_PREFIX + this.userId(), this.collapsed());
  }

  /** Expands or collapses the Pinned section. */
  togglePins(): void {
    this.pinsOpen.update((value) => !value);
    writeFlag(PINS_STORAGE_PREFIX + this.userId(), !this.pinsOpen());
  }

  toggleClerk(): void {
    this.clerk.toggle();
  }

  /** Signs out, after a warning when changes made offline haven't synced (FND-19). */
  signOut(): Promise<void> {
    return this.account.signOut();
  }

  /** Switches the active org; the page then reloads on Today (FND-17). Blocked while offline. */
  switchOrg(orgId: string, active: boolean): Promise<void> {
    return this.account.switchOrg(orgId, active);
  }

  toggleTheme(): void {
    this.account.toggleTheme();
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

  /** The browser's install prompt, or on iOS the Add to Home Screen steps (MOB-01). */
  async installApp(): Promise<void> {
    await this.install.install();
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
        combo: 'shift+t',
        description: 'Start or pause the timer',
        group: 'Time',
        when: () => this.canRecordTime(),
        handler: () => this.timer.toggle(this.currentMatter()),
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
      // The global timer (BILL-02), from anywhere: on the open matter, else a matter picked.
      {
        id: 'timer.start',
        title: 'Start timer',
        group: 'Time',
        icon: 'timer',
        keywords: ['clock', 'stopwatch', 'track', 'time'],
        shortcut: 'shift+t',
        when: () => allowed('time.record'),
        run: () => {
          const matter = this.currentMatter();
          if (matter) void this.timer.start(matter);
          else void this.timer.switchMatter('Start timer');
        },
      },
      {
        id: 'timer.pause',
        title: 'Pause timer',
        group: 'Time',
        icon: 'timer',
        keywords: ['clock', 'stopwatch', 'break'],
        shortcut: 'shift+t',
        when: () => this.timer.running(),
        run: () => this.timer.pause(),
      },
      {
        id: 'timer.stop',
        title: 'Stop timer',
        group: 'Time',
        icon: 'timer',
        keywords: ['clock', 'stopwatch', 'save', 'finish'],
        when: () => !!this.timer.timer(),
        run: () => void this.timer.stop(),
      },
      {
        id: 'timer.switch',
        title: 'Switch timer to another matter',
        group: 'Time',
        icon: 'timer',
        keywords: ['clock', 'stopwatch', 'move', 'change'],
        when: () => allowed('time.record') && !!this.timer.timer(),
        run: () => void this.timer.switchMatter(),
      },
      {
        id: 'theme.toggle',
        title: 'Toggle theme',
        group: 'General',
        icon: 'moon',
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
        id: 'app.install',
        title: INSTALL_COPY.menuItem,
        group: 'General',
        icon: 'download',
        keywords: ['app', 'home screen', 'desktop', 'dock', 'pwa', 'add'],
        when: () => this.install.available(),
        run: () => void this.installApp(),
      },
      {
        id: 'shortcuts.open',
        title: 'Show keyboard shortcuts',
        group: 'General',
        icon: 'keyboard',
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
