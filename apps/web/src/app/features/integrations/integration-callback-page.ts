import { Location } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import {
  DEFAULT_INTEGRATION_RETURN,
  OAUTH_PROVIDER_INFO,
  OAuthProviderSchema,
  type CompleteIntegrationInput,
  type CompleteIntegrationResult,
  type OAuthProvider,
} from '@materia/domain';
import { MtButton, MtEmptyState, ToastService } from '@materia/ui';

import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';

/**
 * Where a provider sends the browser back after consent (`/integrations/callback/:provider`, the
 * OAuth redirect URI; INT-01, ADR-051). Finishes connecting through `integrations-complete` as the
 * signed-in person, who must be the one who started, then goes back to where connecting began.
 * Either way the `code` and `state` leave the address bar and the history (the code is single-use).
 */
@Component({
  selector: 'mt-integration-callback-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtEmptyState, RouterLink],
  template: `
    <div class="mt-col" style="max-width: 520px; margin: 48px auto; padding: 0 16px">
      @if (error(); as message) {
        <mt-empty-state icon="alert" [title]="failedTitle" [description]="message" [headingLevel]="1">
          <a mtButton variant="primary" [routerLink]="back">Back to Settings</a>
        </mt-empty-state>
      } @else {
        <h1 class="title-m" style="margin: 0">Connecting {{ label }}…</h1>
        <p role="status" style="color: var(--text-secondary)">Finishing the connection. This takes a moment.</p>
      }
    </div>
  `,
})
export class IntegrationCallbackPage {
  private readonly callables = inject(CALLABLES);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly toasts = inject(ToastService);
  private readonly route = inject(ActivatedRoute).snapshot;

  private readonly provider: OAuthProvider | undefined = OAuthProviderSchema.safeParse(
    this.route.paramMap.get('provider'),
  ).data;
  protected readonly label = this.provider ? OAUTH_PROVIDER_INFO[this.provider].label : 'the integration';
  protected readonly failedTitle = `${this.label} isn’t connected`;
  protected readonly back = DEFAULT_INTEGRATION_RETURN;
  protected readonly error = signal<string | null>(null);

  constructor() {
    const query = this.route.queryParamMap;
    const code = query.get('code');
    const state = query.get('state');
    const denied = query.get('error');

    if (!this.provider) {
      this.error.set('This isn’t an integration Materia knows. Start connecting again from Settings.');
    } else if (denied) {
      this.error.set(
        denied === 'access_denied'
          ? `Materia wasn’t given access to ${this.label}. Connect again and choose Allow to finish.`
          : `${this.label} couldn’t finish connecting. Start again from Settings.`,
      );
    } else if (!code || !state) {
      this.error.set('This connection link is incomplete. Start connecting again from Settings.');
    } else {
      void this.complete(this.provider, state, code);
    }
  }

  private async complete(provider: OAuthProvider, state: string, code: string): Promise<void> {
    try {
      const result = await this.callables.call<Omit<CompleteIntegrationInput, 'requestId'>, CompleteIntegrationResult>(
        'integrations-complete',
        { provider, state, code },
        { idempotent: true },
      );
      const account = result.account?.tenantName ?? result.account?.email;
      this.toasts.show({
        title: `${this.label} connected`,
        ...(account ? { description: `Connected as ${account}.` } : {}),
        tone: 'success',
      });
      await this.router.navigateByUrl(result.returnTo, { replaceUrl: true });
    } catch (error) {
      this.location.replaceState(`/integrations/callback/${provider}`);
      this.error.set(errorCopy(error));
    }
  }
}
