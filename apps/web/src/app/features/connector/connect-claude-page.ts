import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { OrgContext } from '@materia/data-access';
import { connectorCallables, orgConnectorSettingsRepository } from '@materia/data-access/repository';
import {
  canManageConnections,
  CONNECTOR_PROPOSE_TOOLS,
  CONNECTOR_SCOPE_INFO,
  CONNECTOR_SETTINGS_PATH,
  connectorErrorRedirect,
  connectorServerUrl,
  connectorToolAllowed,
  parseConnectorAuthorization,
  resolveConnectorSettings,
  SENSITIVE_REAUTH_MINUTES,
} from '@materia/domain';
import { MtButton, MtIcon, MtNote, MtSkeleton } from '@materia/ui';

import { CONNECTOR_BROWSER } from './connector-browser';
import { AuthState } from '../../core/auth/auth-state';
import { injectRecentLogin } from '../../core/auth/reauth-dialog';
import { CALLABLES } from '../../core/data/callables';
import { errorCodeOf, errorCopy } from '../../core/error-copy';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { OrgService } from '../../core/orgs/org-service';

const OFF_COPY = 'Your practice hasn’t turned on the Claude connector.';

/**
 * The Claude connector's consent page (`/connect/claude`, INT-07, ADR-064): Claude sends the
 * browser here to ask for access (the OAuth authorization endpoint). The request is checked against
 * the pinned Claude clients first: a wrong client or redirect shows an error and goes nowhere; any
 * other problem goes back to Claude as an OAuth error. Allow (after a sign-in within five minutes)
 * records the connection through `connector-authorize` and returns to Claude with a one-use code;
 * Cancel returns `access_denied`.
 */
@Component({
  selector: 'mt-connect-claude-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtIcon, MtNote, MtSkeleton, RouterLink],
  template: `
    @if (invalid()) {
      <h1 class="title-m" style="margin: 0">This connection request isn’t valid</h1>
      <p style="margin: 0; color: var(--text-secondary)">
        It didn’t come from Claude, or it came back to the wrong place, so Materia won’t connect it. Start connecting
        again from Claude.
      </p>
      <a mtButton variant="secondary" routerLink="/today">Go to Materia</a>
    } @else if (leaving(); as message) {
      <h1 class="title-m" style="margin: 0" role="status">{{ message }}</h1>
      <p style="margin: 0; color: var(--text-secondary)">You can close this tab once Claude opens.</p>
    } @else if (!loaded()) {
      <mt-skeleton variant="lines" label="Loading…" [count]="4" />
    } @else if (unavailable(); as message) {
      <h1 class="title-m" style="margin: 0">Claude can’t connect yet</h1>
      <p style="margin: 0; color: var(--text-secondary)" data-testid="unavailable">{{ message }}</p>
      <div class="mt-row" style="gap: 8px; flex-wrap: wrap">
        @if (canManage()) {
          <a mtButton variant="primary" [routerLink]="settingsPath">Open Claude connector settings</a>
        }
        <button mtButton variant="secondary" type="button" (click)="cancel()">Back to {{ clientName() }}</button>
      </div>
    } @else if (request(); as req) {
      <div class="mt-col" style="gap: 6px">
        <h1 class="title-m" style="margin: 0">Allow {{ req.client.name }} to use Materia?</h1>
        <p style="margin: 0; color: var(--text-secondary)" data-testid="who">
          {{ req.client.name }} will work as you, {{ who() }}, in {{ practice() }}. It can:
        </p>
      </div>
      @if (req.client.loopback) {
        <mt-note tone="warning" data-testid="local-app">
          {{ req.client.name }} is an app on this computer. Allow it only if you just asked it to connect to Materia
          yourself.
        </mt-note>
      } @else {
        <p class="caption t-3" style="margin: 0" data-testid="client-host">Asked by {{ host(req.redirectUri) }}</p>
      }
      <ul class="mt-connect-scopes" data-testid="scopes">
        @for (scope of scopes(); track scope.label) {
          <li>
            <span class="mt-connect-icon" aria-hidden="true"><mt-icon [name]="scope.icon" /></span>
            <span class="mt-col" style="gap: 2px">
              <strong>{{ scope.label }}</strong>
              <span class="caption t-2">{{ scope.description }}</span>
              @if (scope.note; as note) {
                <span class="caption t-3">{{ note }}</span>
              }
            </span>
          </li>
        }
      </ul>
      <mt-note data-testid="data-note">
        What {{ req.client.name }} reads leaves Materia and is processed by Anthropic outside Australia, under your
        Claude account’s terms. Privileged matters and the text of documents are never shared.
      </mt-note>
      <p class="caption t-3" style="margin: 0">
        Every request is in the practice’s audit log. Disconnect at any time in Settings → Claude connector; signing out
        everywhere or leaving the practice disconnects it too.
      </p>
      @if (problem(); as message) {
        <mt-note tone="danger">{{ message }}</mt-note>
      }
      <div class="mt-row" style="gap: 8px; flex-wrap: wrap">
        <button mtButton variant="primary" type="button" [loading]="allowing()" (click)="allow()">Allow</button>
        <button mtButton variant="ghost" type="button" [disabled]="allowing()" (click)="cancel()">Cancel</button>
      </div>
    }
  `,
  styles: `
    .mt-connect-scopes {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .mt-connect-scopes li {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .mt-connect-icon {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: var(--radius-md);
      background: var(--bg-subtle);
      color: var(--text-secondary);
    }
  `,
})
export class ConnectClaudePage {
  private readonly auth = inject(AuthState);
  // Keeps the data session (OrgContext) in step with the sign-in outside the shell, as onboarding does.
  private readonly orgs = inject(OrgService);
  private readonly context = inject(OrgContext);
  private readonly flags = inject(FeatureFlagService);
  private readonly browser = inject(CONNECTOR_BROWSER);
  private readonly connector = connectorCallables(inject(CALLABLES));
  private readonly recentLogin = injectRecentLogin(SENSITIVE_REAUTH_MINUTES);

  /** The issuer and MCP resource are this page's origin (the metadata names it). */
  private readonly issuer = this.browser.origin();
  private readonly parsed = (() => {
    const query = inject(ActivatedRoute).snapshot.queryParamMap;
    const params = Object.fromEntries(query.keys.map((key) => [key, query.get(key)]));
    return parseConnectorAuthorization(params, connectorServerUrl(this.issuer));
  })();
  protected readonly invalid = signal(!this.parsed.ok && !this.parsed.redirect);
  protected readonly request = signal(this.parsed.ok ? this.parsed.request : null);
  protected readonly clientName = computed(() => this.request()?.client.name ?? 'Claude');
  protected readonly settingsPath = CONNECTOR_SETTINGS_PATH;

  private readonly org = orgConnectorSettingsRepository().watch(() => this.context.orgId());
  private readonly flagsReady = signal(false);
  protected readonly loaded = computed(() => this.flagsReady() && this.org.status() !== 'loading');
  private readonly settings = computed(() => resolveConnectorSettings(this.org.value()?.settings?.connector));
  /** Set when the server refused because the connector is off (it was turned off meanwhile). */
  private readonly refusedOff = signal<string | null>(null);
  protected readonly unavailable = computed(() => {
    if (!this.flags.isOn('integrations.claudeConnector')) {
      return 'The Claude connector isn’t available for your practice yet.';
    }
    const off = this.refusedOff();
    if (off) return off;
    if (!this.settings().enabled) {
      return this.canManage()
        ? `${OFF_COPY} Turn it on in Settings, then connect again from Claude.`
        : `${OFF_COPY} An owner or admin can turn it on in Settings → Claude connector.`;
    }
    return null;
  });

  private readonly role = computed(() => this.context.role());
  protected readonly canManage = computed(() => {
    const role = this.role();
    return !!role && canManageConnections(role);
  });
  protected readonly who = computed(() => {
    const session = this.auth.session();
    return session?.displayName ?? session?.email ?? 'the signed-in person';
  });
  protected readonly practice = computed(
    () => this.org.value()?.name ?? this.orgs.orgs().find((org) => org.active)?.name ?? 'your practice',
  );

  /** What each asked-for scope allows, with why suggesting won't work for this person yet. */
  protected readonly scopes = computed(() => {
    const role = this.role();
    const canPropose = !!role && CONNECTOR_PROPOSE_TOOLS.some((tool) => connectorToolAllowed(role, tool));
    return (this.request()?.scopes ?? []).map((scope) => {
      let note: string | null = null;
      if (scope === 'materia.propose') {
        if (!this.settings().allowProposals)
          note = 'Your practice has turned suggestions off, so this does nothing yet.';
        else if (!canPropose) note = 'Your role can’t make these changes, so this does nothing for you.';
      }
      return {
        ...CONNECTOR_SCOPE_INFO[scope],
        icon: scope === 'materia.read' ? ('eye' as const) : ('sparkle' as const),
        note,
      };
    });
  });

  protected readonly allowing = signal(false);
  protected readonly leaving = signal<string | null>(null);
  protected readonly problem = signal<string | null>(null);

  constructor() {
    void this.flags.ready().then(() => this.flagsReady.set(true));
    // Anything wrong but the client or redirect goes straight back to Claude, as OAuth asks.
    if (!this.parsed.ok && this.parsed.redirect) {
      this.leave(
        connectorErrorRedirect(this.parsed.redirectUri, this.parsed.error, {
          state: this.parsed.state,
          description: this.parsed.description,
          issuer: this.issuer,
        }),
      );
    }
  }

  protected async allow(): Promise<void> {
    const request = this.request();
    if (!request || this.allowing()) return;
    this.allowing.set(true);
    this.problem.set(null);
    try {
      const result = await this.recentLogin(`Connecting ${request.client.name} needs a fresh sign-in.`, () =>
        this.connector.authorize({
          clientId: request.client.id,
          redirectUri: request.redirectUri,
          codeChallenge: request.codeChallenge,
          codeChallengeMethod: 'S256',
          scopes: request.scopes,
          ...(request.state ? { state: request.state } : {}),
          ...(request.resource ? { resource: request.resource } : {}),
          origin: this.issuer,
        }),
      );
      if (result) this.leave(result.redirectUrl);
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === 'CONNECTOR_OFF' || code === 'FEATURE_DISABLED') this.refusedOff.set(errorCopy(error));
      else this.problem.set(errorCopy(error));
    } finally {
      this.allowing.set(false);
    }
  }

  /** Back to Claude without connecting. */
  protected cancel(): void {
    const request = this.request();
    if (!request) return;
    this.leave(
      connectorErrorRedirect(request.redirectUri, 'access_denied', { state: request.state, issuer: this.issuer }),
    );
  }

  /** Where the client sends the browser back to (claude.ai or claude.com), named on the page. */
  protected host(redirectUri: string): string {
    return new URL(redirectUri).host;
  }

  private leave(url: string): void {
    this.leaving.set(`Returning to ${this.clientName()}…`);
    this.browser.assign(url);
  }
}
