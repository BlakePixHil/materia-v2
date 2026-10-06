import { ChangeDetectionStrategy, Component, computed, input, ViewEncapsulation } from '@angular/core';

import { MtIcon } from '../icon/icon';
import { MtBadge, type MtBadgeTone } from '../markers/markers';

/**
 * A connection's state, as DES-01 draws it: `connected`; `reconnect` (the sign-in expired or was
 * refused, nothing is lost); `error` (something failed: the reason shows in full); `disconnected`
 * (not connected yet); `unavailable` (not available yet, so no action).
 */
export type MtIntegrationStatus = 'connected' | 'reconnect' | 'error' | 'disconnected' | 'unavailable';

const BADGES: Partial<Record<MtIntegrationStatus, { label: string; tone: MtBadgeTone }>> = {
  connected: { label: 'Connected', tone: 'success' },
  reconnect: { label: 'Reconnect needed', tone: 'warning' },
  error: { label: 'Error', tone: 'danger' },
  unavailable: { label: 'Not available yet', tone: 'neutral' },
};

/**
 * IntegrationCard (`mt-integration-card`): a connected service (Xero, Microsoft 365) with what
 * Materia uses it for, its status, a line about the connection (`meta`: who it's connected as, or
 * why it needs reconnecting) and its action (projected: "Connect", "Reconnect"). In the `error`
 * state, `error` is the reason in full: it wraps and is never truncated. The logo is the service's
 * initial unless a `[mtIntegrationLogo]` element is projected.
 */
@Component({
  selector: 'mt-integration-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/integration.css', '../../generated/components/layout.css'],
  imports: [MtBadge, MtIcon],
  host: {
    class: 'mt-integration',
    style: 'align-items: flex-start',
    '[attr.data-state]': 'status() === "error" ? "error" : null',
  },
  template: `
    <span class="logo" aria-hidden="true">
      <ng-content select="[mtIntegrationLogo]">{{ initial() }}</ng-content>
    </span>
    <div class="mt-grow">
      <div class="mt-row" style="gap: 8px; flex-wrap: wrap">
        <span class="mt-integration-name mt-ell">{{ name() }}</span>
        @if (badge(); as b) {
          <mt-badge [tone]="b.tone">{{ b.label }}</mt-badge>
        }
      </div>
      @if (description(); as text) {
        <div class="mt-integration-desc">{{ text }}</div>
      }
      @if (meta(); as text) {
        <div class="caption t-3" style="margin-top: 4px">{{ text }}</div>
      }
      @if (status() === 'error' && error(); as reason) {
        <div class="mt-integration-error" role="alert">
          <mt-icon name="alert" />
          <span>{{ reason }}</span>
        </div>
      }
    </div>
    <ng-content />
  `,
})
export class MtIntegrationCard {
  readonly name = input.required<string>();
  readonly description = input<string>();
  readonly status = input<MtIntegrationStatus>('disconnected');
  /** A line about the connection: "Connected as Fictional Legal on 4 Oct", or why it needs reconnecting. */
  readonly meta = input<string>();
  /** In the `error` state: what failed, what it affects and how to fix it. */
  readonly error = input<string>();
  protected readonly initial = computed(() => this.name().trim().charAt(0).toUpperCase());
  protected readonly badge = computed(() => BADGES[this.status()] ?? null);
}
