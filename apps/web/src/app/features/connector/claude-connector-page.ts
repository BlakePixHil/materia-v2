import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { OrgContext } from '@materia/data-access';
import {
  connectorCallables,
  connectorConnectionsRepository,
  MEMBER_LIST_QUERY,
  membersRepository,
  orgConnectorSettingsRepository,
  type ConnectorConnectionItem,
  type WithId,
} from '@materia/data-access/repository';
import {
  canManageConnections,
  CONNECTOR_SCOPE_INFO,
  connectorServerUrl,
  resolveConnectorSettings,
  SENSITIVE_REAUTH_MINUTES,
  type ResolvedConnectorSettings,
} from '@materia/domain';
import {
  DialogService,
  formatDateOnly,
  MT_ORG_TIMEZONE,
  MtButton,
  MtNote,
  MtSettingsRow,
  MtSettingsSection,
  MtSkeleton,
  MtSwitch,
  ToastService,
} from '@materia/ui';

import { CONNECTOR_BROWSER } from './connector-browser';
import { injectRecentLogin } from '../../core/auth/reauth-dialog';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { MtNeedsConnection } from '../../core/pwa/needs-connection';

/**
 * Settings → Claude connector (`/settings/claude`, INT-07, ADR-064; behind
 * `integrations.claudeConnector`): how to add Materia to Claude, and the person's connections,
 * which they can end at once. Owners and admins turn the connector on or off for the practice and
 * choose whether Claude may suggest changes (`connector-setPractice`, after a recent sign-in), and
 * see and end everyone's connections. Turning it off ends every connection.
 */
@Component({
  selector: 'mt-claude-connector-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtNeedsConnection, MtNote, MtSettingsRow, MtSettingsSection, MtSkeleton, MtSwitch],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  template: `
    <div class="mt-col" style="gap: 6px">
      <h1 class="title-l" style="margin: 0">Claude connector</h1>
      <p style="margin: 0; color: var(--text-secondary)">
        Use Materia from your own Claude: ask about your matters, deadlines, tasks and time, and have Claude suggest
        tasks, file notes and time entries that someone accepts here.
      </p>
    </div>

    @if (loadError(); as message) {
      <mt-note tone="danger">{{ message }}</mt-note>
    } @else if (!loaded()) {
      <mt-skeleton variant="cards" label="Loading settings…" [count]="2" />
    } @else {
      <mt-settings-section
        title="For the practice"
        [description]="
          canManage()
            ? 'Off until you turn it on. Turning it off ends every connection at once.'
            : 'Owners and admins change these.'
        "
        [headingLevel]="2"
        data-testid="practice"
      >
        <mt-settings-row
          title="Let people connect Claude"
          description="Each person connects their own Claude account, and it sees only what they can see in Materia."
        >
          @if (canManage()) {
            <mt-switch
              name="enabled"
              label="Let people connect Claude"
              labelHidden
              mtNeedsConnection
              [disabled]="saving()"
              [ngModel]="settings().enabled"
              (ngModelChange)="save({ enabled: !!$event })"
            />
          } @else {
            <span data-value="enabled">{{ settings().enabled ? 'On' : 'Off' }}</span>
          }
        </mt-settings-row>
        <mt-settings-row
          title="Let Claude suggest changes"
          description="Tasks, file notes and time entries wait on the matter until someone accepts them. When off, Claude only reads."
        >
          @if (canManage()) {
            <mt-switch
              name="allowProposals"
              label="Let Claude suggest changes"
              labelHidden
              mtNeedsConnection
              [disabled]="saving() || !settings().enabled"
              [ngModel]="settings().allowProposals"
              (ngModelChange)="save({ allowProposals: !!$event })"
            />
          } @else {
            <span data-value="allowProposals">{{ settings().allowProposals ? 'On' : 'Off' }}</span>
          }
        </mt-settings-row>
        <mt-note data-testid="disclosure">
          What people read through Claude goes into their own Claude account and is processed by Anthropic outside
          Australia, under that account’s terms. Ask them to use the practice’s Claude Team or Enterprise accounts, not
          personal ones.
        </mt-note>
      </mt-settings-section>

      @if (settings().enabled) {
        <mt-settings-section
          title="Connect Claude"
          description="Add Materia to Claude once. Claude then asks you to sign in here and allow it."
          [headingLevel]="2"
          data-testid="connect"
        >
          <div class="mt-connector-url">
            <code class="mono" data-testid="server-url">{{ serverUrl }}</code>
            <button mtButton variant="secondary" size="sm" type="button" (click)="copy()">Copy</button>
          </div>
          <ol class="mt-connector-steps">
            <li>
              In Claude, open <strong>Settings → Connectors</strong> and choose <strong>Add custom connector</strong>.
            </li>
            <li>Name it Materia, paste the address above and choose <strong>Add</strong>.</li>
            <li>Choose <strong>Connect</strong>, sign in to Materia and allow Claude.</li>
          </ol>
          <p class="caption t-3" style="margin: 0">
            In Claude Code, run <code class="mono">claude mcp add --transport http materia {{ serverUrl }}</code
            >, then <code class="mono">/mcp</code> to sign in.
          </p>
          <mt-note>
            Connect the Claude account the practice gave you (Team or Enterprise), not a personal one. Privileged
            matters and the text of documents are never shared, and every request is in the audit log.
          </mt-note>
        </mt-settings-section>
      }

      <mt-settings-section title="Your connections" [headingLevel]="2" data-testid="mine">
        @for (connection of mine(); track connection.id) {
          <mt-settings-row [title]="connection.clientName" [description]="describe(connection)">
            <button
              mtButton
              mtNeedsConnection
              variant="ghost"
              size="sm"
              type="button"
              [loading]="ending() === connection.id"
              (click)="disconnect(connection)"
            >
              Disconnect
            </button>
          </mt-settings-row>
        } @empty {
          <p style="margin: 0; color: var(--text-tertiary)">
            {{ settings().enabled ? 'You haven’t connected Claude.' : 'Nothing is connected.' }}
          </p>
        }
      </mt-settings-section>

      @if (canManage()) {
        <mt-settings-section
          title="Everyone’s connections"
          description="End anyone’s connection at once, for example when a laptop is lost. They can connect again."
          [headingLevel]="2"
          data-testid="everyone"
        >
          @for (connection of others(); track connection.id) {
            <mt-settings-row
              [title]="nameOf(connection.uid) + ' · ' + connection.clientName"
              [description]="describe(connection)"
            >
              <button
                mtButton
                mtNeedsConnection
                variant="ghost"
                size="sm"
                type="button"
                [loading]="ending() === connection.id"
                (click)="disconnect(connection)"
              >
                Disconnect
              </button>
            </mt-settings-row>
          } @empty {
            <p style="margin: 0; color: var(--text-tertiary)">No one else has connected Claude.</p>
          }
        </mt-settings-section>
      }
    }
  `,
  styles: `
    .mt-connector-url {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      padding: 8px 8px 8px 12px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-subtle);
    }
    .mt-connector-url code {
      flex: 1 1 220px;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .mt-connector-steps {
      margin: 0;
      padding-left: 20px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      color: var(--text-secondary);
    }
  `,
})
export class ClaudeConnectorPage {
  private readonly context = inject(OrgContext);
  private readonly connector = connectorCallables(inject(CALLABLES));
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly browser = inject(CONNECTOR_BROWSER);
  private readonly recentLogin = injectRecentLogin(SENSITIVE_REAUTH_MINUTES);
  private readonly timeZone = inject(MT_ORG_TIMEZONE);

  protected readonly serverUrl = connectorServerUrl(this.browser.origin());

  protected readonly canManage = computed(() => {
    const role = this.context.role();
    return !!role && canManageConnections(role);
  });

  private readonly org = orgConnectorSettingsRepository().watch(() => this.context.orgId());
  private readonly connections = connectorConnectionsRepository();
  private readonly own = this.connections.watchQuery(() => {
    const uid = this.context.uid();
    return uid
      ? {
          where: [
            ['uid', '==', uid],
            ['status', '==', 'active'],
          ],
          pageSize: 50,
        }
      : null;
  });
  private readonly all = this.connections.watchQuery(() =>
    this.canManage() ? { where: [['status', '==', 'active']], pageSize: 100 } : null,
  );
  private readonly members = membersRepository().watchQuery(() =>
    this.canManage() ? { ...MEMBER_LIST_QUERY, pageSize: 100 } : null,
  );

  protected readonly loaded = computed(() => this.org.status() !== 'loading' && this.own.status() !== 'loading');
  protected readonly loadError = computed(() => {
    const error = this.org.error() ?? this.own.error() ?? this.all.error();
    return error ? errorCopy(error) : null;
  });

  /** The values just saved, shown until the org document catches up. */
  private readonly pending = signal<ResolvedConnectorSettings | null>(null);
  protected readonly settings = computed(
    () => this.pending() ?? resolveConnectorSettings(this.org.value()?.settings?.connector),
  );
  protected readonly saving = signal(false);
  protected readonly ending = signal<string | null>(null);

  protected readonly mine = computed(() => newestFirst(this.own.value()));
  protected readonly others = computed(() =>
    newestFirst(this.all.value().filter((connection) => connection.uid !== this.context.uid())),
  );
  private readonly names = computed(
    () => new Map((this.members.value() ?? []).map((member) => [member.id, member.displayName])),
  );

  protected nameOf(uid: string): string {
    return this.names().get(uid) ?? 'A former member';
  }

  /** "Connected 7 Oct 2026 · last used 8 Oct 2026 · Read your matters, Suggest changes". */
  protected describe(connection: ConnectorConnectionItem): string {
    const parts = [`Connected ${formatDateOnly(connection.connectedAt, this.timeZone)}`];
    if (connection.lastUsedAt) parts.push(`last used ${formatDateOnly(connection.lastUsedAt, this.timeZone)}`);
    parts.push(connection.scopes.map((scope) => CONNECTOR_SCOPE_INFO[scope].label).join(', '));
    return parts.join(' · ');
  }

  protected async copy(): Promise<void> {
    try {
      await this.browser.copy(this.serverUrl);
      this.toasts.show({ title: 'Address copied', tone: 'success' });
    } catch {
      this.toasts.show({ title: 'Couldn’t copy. Select the address and copy it instead.', tone: 'danger' });
    }
  }

  protected async save(change: Partial<ResolvedConnectorSettings>): Promise<void> {
    const current = this.settings();
    const next = { ...current, ...change };
    if (next.enabled === current.enabled && next.allowProposals === current.allowProposals) return;
    // Shown at once; clearing it puts the switch back.
    this.pending.set(next);
    if (current.enabled && !next.enabled) {
      const count = this.all.value().length;
      const confirmed = await this.dialogs.confirm({
        title: 'Turn the Claude connector off?',
        body:
          (count
            ? `${count === 1 ? 'The 1 connection ends' : `All ${count} connections end`} at once. `
            : 'No one can connect Claude while it’s off. ') + 'People connect again once it’s back on.',
        confirmLabel: 'Turn off',
        tone: 'danger',
      });
      if (!confirmed) {
        this.pending.set(null);
        return;
      }
    }
    this.saving.set(true);
    try {
      const result = await this.recentLogin('Changing the Claude connector needs a fresh sign-in.', () =>
        this.connector.setPractice(next),
      );
      if (result) {
        this.toasts.show({
          title: next.enabled ? 'Claude connector settings saved' : 'Claude connector turned off',
          ...(result.revoked ? { description: connectionsEnded(result.revoked) } : {}),
          tone: 'success',
        });
      }
    } catch (error) {
      this.toasts.show({ title: 'The change wasn’t saved', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.pending.set(null);
      this.saving.set(false);
    }
  }

  protected async disconnect(connection: WithId<ConnectorConnectionItem>): Promise<void> {
    if (this.ending()) return;
    const own = connection.uid === this.context.uid();
    const confirmed = await this.dialogs.confirm({
      title: own
        ? `Disconnect ${connection.clientName}?`
        : `Disconnect ${this.nameOf(connection.uid)}’s ${connection.clientName}?`,
      body: `${connection.clientName} can’t reach Materia from the next request. Suggestions it already made stay on their matters.`,
      confirmLabel: 'Disconnect',
      tone: 'danger',
    });
    if (!confirmed) return;
    this.ending.set(connection.id);
    try {
      await this.connector.disconnect({ connectionId: connection.id });
      this.toasts.show({ title: `${connection.clientName} disconnected`, tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'Still connected', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.ending.set(null);
    }
  }
}

function newestFirst<T extends { connectedAt: Date }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime());
}

function connectionsEnded(count: number): string {
  return count === 1 ? '1 connection ended.' : `${count} connections ended.`;
}
