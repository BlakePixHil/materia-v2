import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

import { MtNavItem } from '@materia/ui';

import { visibleSections, type SettingsSection } from './settings-nav';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { OrgService } from '../../core/orgs/org-service';

/**
 * Settings (`/settings`, CORE-21): a sidebar of the pages the person can open, grouped as in the
 * design (You, Firm, Practice, Clerk, Records), and the page itself. Only owners and admins see
 * more than their own profile and preferences and the team.
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

  protected readonly groups = computed(() => {
    const sections = visibleSections(this.orgs.role(), (flag) => this.flags.isOn(flag));
    const groups: { name: string; sections: SettingsSection[] }[] = [];
    for (const section of sections) {
      const group = groups.find((g) => g.name === section.group);
      if (group) group.sections.push(section);
      else groups.push({ name: section.group, sections: [section] });
    }
    return groups;
  });
}
