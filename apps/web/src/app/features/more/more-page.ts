import { ChangeDetectionStrategy, Component, computed, inject, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';

import { MtAvatar, MtIcon } from '@materia/ui';

import { AccountActions } from '../../core/account/account-actions';
import { AuthState } from '../../core/auth/auth-state';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { OrgService } from '../../core/orgs/org-service';
import { UserPrefsService } from '../../core/profile/user-prefs';
import { InstallPrompt, INSTALL_COPY } from '../../core/pwa/install-prompt';
import { NAV_ITEMS, SETTINGS_ITEM, TAB_BAR_ITEMS } from '../../shell/nav';

/** What has a tab of its own on a phone, so More doesn't list it again. */
const IN_TAB_BAR = new Set(TAB_BAR_ITEMS.map((item) => item.link));

/**
 * More (`/more`, MOB-02): on a phone, everything the TabBar has no room for. Who I am and in which
 * practice; every other destination (My tasks, Deadlines, Contacts… and Settings); switching practice;
 * the theme and "Install Materia"; and Sign out. Each row is a 56px target.
 */
@Component({
  selector: 'mt-more-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../../../../../libs/ui/src/generated/components/mrow.css',
    '../../../../../../libs/ui/src/generated/components/mgroup.css',
  ],
  imports: [MtAvatar, MtIcon, RouterLink],
  host: { class: 'mt-more' },
  template: `
    <h1 class="mt-sr">More</h1>
    <a class="mt-mrow me" routerLink="/settings/profile" data-more="profile">
      <mt-avatar [name]="userName()" [colorKey]="userId()" [src]="avatarUrl()" size="lg" />
      <span class="mt-grow">
        <span class="tt mt-ell">{{ userName() }}</span>
        <span class="ts mt-ell">{{ orgName() }}</span>
      </span>
      <mt-icon class="chev" name="chevron-right" />
    </a>

    <h2 class="mt-mgroup" id="more-workspace">Workspace</h2>
    <nav aria-labelledby="more-workspace">
      @for (item of destinations(); track item.id) {
        <a class="mt-mrow" [routerLink]="item.link" [attr.data-more]="item.id">
          <mt-icon [name]="item.icon" />
          <span class="tt mt-grow">{{ item.label }}</span>
          <mt-icon class="chev" name="chevron-right" />
        </a>
      }
    </nav>

    @if (orgs().length > 1) {
      <h2 class="mt-mgroup" id="more-orgs">Practice</h2>
      <ul class="list" aria-labelledby="more-orgs">
        @for (org of orgs(); track org.orgId) {
          <li>
            <button
              type="button"
              class="mt-mrow"
              [attr.aria-current]="org.active ? 'true' : null"
              (click)="account.switchOrg(org.orgId, org.active)"
            >
              <mt-icon name="matters" />
              <span class="tt mt-grow mt-ell">{{ org.name }}</span>
              @if (org.active) {
                <mt-icon class="chev" name="check" />
              }
            </button>
          </li>
        }
      </ul>
    }

    <h2 class="mt-mgroup" id="more-app">This device</h2>
    <ul class="list" aria-labelledby="more-app">
      <li>
        <button type="button" class="mt-mrow" data-more="theme" (click)="account.toggleTheme()">
          <mt-icon name="moon" />
          <span class="tt mt-grow">{{ account.themeLabel() }}</span>
        </button>
      </li>
      @if (install.available()) {
        <li>
          <button type="button" class="mt-mrow" data-more="install" (click)="install.install()">
            <mt-icon name="download" />
            <span class="tt mt-grow">{{ installLabel }}</span>
          </button>
        </li>
      }
      <li>
        <button type="button" class="mt-mrow" data-more="sign-out" data-tone="danger" (click)="account.signOut()">
          <mt-icon name="log-out" />
          <span class="tt mt-grow">Sign out</span>
        </button>
      </li>
    </ul>
  `,
  styles: `
    .mt-more {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      max-width: 560px;
    }
    .mt-more .list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .mt-more .me {
      min-height: 72px;
    }
    .mt-more .me .tt,
    .mt-more .me .ts {
      display: block;
    }
  `,
})
export class MorePage {
  protected readonly account = inject(AccountActions);
  protected readonly install = inject(InstallPrompt);
  protected readonly installLabel = INSTALL_COPY.menuItem;
  private readonly auth = inject(AuthState);
  private readonly prefs = inject(UserPrefsService);
  private readonly flags = inject(FeatureFlagService);
  protected readonly orgs = inject(OrgService).orgs;

  protected readonly userId = computed(() => this.auth.user()?.uid ?? 'anonymous');
  protected readonly userName = computed(
    () => this.prefs.profile.value()?.displayName || this.auth.user()?.displayName || 'Account',
  );
  protected readonly avatarUrl = computed(() => this.prefs.profile.value()?.avatarUrl ?? null);
  protected readonly orgName = computed(() => this.auth.user()?.orgName ?? 'Materia');
  /** The sidebar's destinations the TabBar doesn't have (whose flag is on), then Settings. */
  protected readonly destinations = computed(() => [
    ...NAV_ITEMS.filter((item) => !IN_TAB_BAR.has(item.link) && (!item.flag || this.flags.isOn(item.flag))),
    SETTINGS_ITEM,
  ]);
}
