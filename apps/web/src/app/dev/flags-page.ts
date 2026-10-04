import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { FLAGS, type FlagKey } from '@materia/domain';
import { MtBadge, MtButton } from '@materia/ui';

import { FeatureFlagService } from '../core/flags/feature-flags';

/**
 * `/__dev/flags` (dev builds only, FND-23): every flag, its value and where it came from, with
 * local overrides kept in this browser. Production builds drop this page and ignore local overrides.
 */
@Component({
  selector: 'mt-flags-dev-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtBadge, MtButton],
  host: { class: 'mt-col', style: 'gap: 16px; padding: 24px; max-width: 960px' },
  template: `
    <h1 class="title-l" style="margin: 0">Feature flags</h1>
    <p style="margin: 0; color: var(--text-secondary)">
      Local overrides apply to this browser in dev builds only. Order: local, org override, Remote Config, default.
    </p>
    <table class="mt-flags-table">
      <caption class="mt-sr">
        Feature flags and their values
      </caption>
      <thead>
        <tr>
          <th scope="col">Flag</th>
          <th scope="col">Value</th>
          <th scope="col">Source</th>
          <th scope="col">Owner</th>
          <th scope="col"><span class="mt-sr">Override</span></th>
        </tr>
      </thead>
      <tbody>
        @for (row of flags.all(); track row.key) {
          <tr>
            <th scope="row">
              <code>{{ row.key }}</code>
              <div class="mt-flags-desc">{{ describe(row.key) }}</div>
            </th>
            <td>
              <code>{{ row.value }}</code>
            </td>
            <td>
              <mt-badge [tone]="row.source === 'local' ? 'warning' : 'neutral'">{{ row.source }}</mt-badge>
            </td>
            <td>{{ owner(row.key) }}</td>
            <td class="mt-row" style="gap: 6px">
              @if (isBoolean(row.key)) {
                <button mtButton size="sm" (click)="flags.setLocal(row.key, !row.value)">
                  Turn {{ row.value ? 'off' : 'on' }}
                </button>
              }
              @if (row.source === 'local') {
                <button mtButton size="sm" variant="ghost" (click)="flags.setLocal(row.key, undefined)">Reset</button>
              }
            </td>
          </tr>
        }
      </tbody>
    </table>
  `,
  styles: `
    .mt-flags-table {
      border-collapse: collapse;
      width: 100%;
      font: 400 13px/18px var(--font-sans);
    }
    .mt-flags-table th,
    .mt-flags-table td {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid var(--border-default);
      vertical-align: top;
    }
    .mt-flags-table thead th {
      color: var(--text-tertiary);
      font-weight: 500;
    }
    .mt-flags-desc {
      color: var(--text-secondary);
      font-weight: 400;
      margin-top: 2px;
    }
  `,
})
export class FlagsDevPage {
  protected readonly flags = inject(FeatureFlagService);

  protected describe(key: FlagKey): string {
    return FLAGS[key].description;
  }

  protected owner(key: FlagKey): string {
    return FLAGS[key].owner;
  }

  protected isBoolean(key: FlagKey): boolean {
    return FLAGS[key].type === 'boolean';
  }
}
