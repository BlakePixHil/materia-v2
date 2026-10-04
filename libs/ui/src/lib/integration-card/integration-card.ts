import { ChangeDetectionStrategy, Component, computed, input, ViewEncapsulation } from '@angular/core';

import { MtBadge } from '../markers/markers';

export type MtIntegrationStatus = 'connected' | 'disconnected' | 'error';

/**
 * IntegrationCard (`mt-integration-card`): a connected service (Outlook, the NSW Online Registry) with
 * its status and actions (projected: "Manage", "Connect"). The logo is the service's initial unless a
 * `[mtIntegrationLogo]` element is projected.
 */
@Component({
  selector: 'mt-integration-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/integration.css', '../../generated/components/layout.css'],
  imports: [MtBadge],
  host: { class: 'mt-integration' },
  template: `
    <span class="logo" aria-hidden="true">
      <ng-content select="[mtIntegrationLogo]">{{ initial() }}</ng-content>
    </span>
    <div class="mt-grow">
      <div class="mt-integration-name mt-ell">{{ name() }}</div>
      @if (description(); as text) {
        <div class="mt-integration-desc">{{ text }}</div>
      }
    </div>
    @if (status() === 'connected') {
      <mt-badge tone="success">Connected</mt-badge>
    } @else if (status() === 'error') {
      <mt-badge tone="danger">Needs attention</mt-badge>
    }
    <ng-content />
  `,
})
export class MtIntegrationCard {
  readonly name = input.required<string>();
  readonly description = input<string>();
  readonly status = input<MtIntegrationStatus>('disconnected');
  protected readonly initial = computed(() => this.name().trim().charAt(0).toUpperCase());
}
