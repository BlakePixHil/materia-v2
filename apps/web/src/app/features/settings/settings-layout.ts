import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

import { migrationRunsRepository } from '@materia/data-access/repository';
import { MtNavItem } from '@materia/ui';

import { SETTINGS_ADMIN_ROLES, visibleSections, type SettingsSection } from './settings-nav';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { OrgService } from '../../core/orgs/org-service';

/**
 * Settings (`/settings`, CORE-21): a sidebar of the pages the person can open, grouped as in the
 * design (You, Firm, Practice, Clerk, Records), and the page itself. Only owners and admins see
 * more than their own profile and preferences and the team; they see the import from the old
 * materia once the practice has one (MIG-08).
 */
@Component({
  selector: 'mt-settings-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterOutlet, MtNavItem],
  template: `
    <nav class="settings-nav mt-col" aria-label="Settings pages">
      @for (group of groups(); track group.name) {
        <div class="mt-nav-section">{{ group.name }}</div>
        @for (section of group.sections; track section.path) {
          <a mtNavItem [routerLink]="['/settings', section.path]" [label]="section.label" [icon]="section.icon"></a>
        }
      }
    </nav>
    <div class="settings-page">
      <router-outlet />
    </div>
  `,
  styles: `
    :host {
      display: flex;
      gap: var(--space-32, 32px);
      align-items: flex-start;
    }
    .settings-nav {
      gap: 1px;
      width: 220px;
      flex: none;
      position: sticky;
      top: 0;
    }
    .settings-page {
      flex: 1;
      min-width: 0;
    }
    @media (max-width: 899px) {
      /* Stacked, the page takes the full width: a page measured as a container (Clerk and AI)
         has no width of its own and would otherwise shrink to nothing. */
      :host {
        flex-direction: column;
        align-items: stretch;
        gap: var(--space-16, 16px);
      }
      .settings-nav {
        position: static;
        width: 100%;
        flex-direction: row;
        flex-wrap: wrap;
      }
      .settings-nav .mt-nav-section {
        display: none;
      }
    }
  `,
})
export class SettingsLayout {
  private readonly orgs = inject(OrgService);
  private readonly flags = inject(FeatureFlagService);
  /** Whether the practice came across from the old materia (MIG-08): the import page shows then. */
  private readonly migrationRuns = migrationRunsRepository().watchQuery(() => {
    const role = this.orgs.role();
    return role && SETTINGS_ADMIN_ROLES.includes(role) ? { pageSize: 1 } : null;
  });

  protected readonly groups = computed(() => {
    const migrated = this.migrationRuns.value().length > 0;
    const sections = visibleSections(this.orgs.role(), (flag) => this.flags.isOn(flag), migrated);
    const groups: { name: string; sections: SettingsSection[] }[] = [];
    for (const section of sections) {
      const group = groups.find((g) => g.name === section.group);
      if (group) group.sections.push(section);
      else groups.push({ name: section.group, sections: [section] });
    }
    return groups;
  });
}
