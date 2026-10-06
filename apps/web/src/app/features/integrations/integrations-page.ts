import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  InjectionToken,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { OrgContext } from '@materia/data-access';
import {
  integrationCallables,
  integrationStatusRepository,
  orgXeroSettingsRepository,
  xeroCallables,
  type OrgXeroSettings,
} from '@materia/data-access/repository';
import {
  OAUTH_PROVIDER_INFO,
  SENSITIVE_REAUTH_MINUTES,
  XeroSettingsInput,
  type DateOnly,
  type XeroOptionsResult,
} from '@materia/domain';
import {
  DialogService,
  formatDateOnly,
  MT_ORG_TIMEZONE,
  MT_TODAY,
  MtButton,
  MtIntegrationCard,
  MtNote,
  MtSelect,
  MtSettingsRow,
  MtSettingsSection,
  MtSwitch,
  MtTextField,
  ToastService,
  type MtIntegrationStatus,
  type MtOption,
} from '@materia/ui';

import { injectRecentLogin } from '../../core/auth/reauth-dialog';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { warnBeforeUnload, type HasUnsavedChanges } from '../settings/unsaved-changes';
import { formatEntryDate, parseEntryDate } from '../time/time-view';

/** The browser, as connecting needs it: the app's origin, and leaving for the provider's consent page. */
export interface ConsentBrowser {
  origin(): string;
  assign(url: string): void;
}

/** Leaving for a provider's consent page (INT-01). Tests replace it. */
export const CONSENT_BROWSER = new InjectionToken<ConsentBrowser>('CONSENT_BROWSER', {
  providedIn: 'root',
  factory: () => ({
    origin: () => globalThis.location.origin,
    assign: (url: string) => globalThis.location.assign(url),
  }),
});

interface XeroForm {
  tenantId: string;
  feesAccountCode: string;
  disbursementsAccountCode: string;
  autoPush: boolean;
  /** DD/MM/YYYY as typed. */
  sendFrom: string;
}

function formOf(xero: OrgXeroSettings['xero'], today: DateOnly): XeroForm {
  return {
    tenantId: xero?.tenantId ?? '',
    feesAccountCode: xero?.feesAccountCode ?? '',
    disbursementsAccountCode: xero?.disbursementsAccountCode ?? '',
    autoPush: xero?.autoPush ?? true,
    sendFrom: formatEntryDate(xero?.sendFrom ?? today),
  };
}

const XERO = OAUTH_PROVIDER_INFO.xero;
const XERO_PITCH = 'Send issued invoices and credit notes to Xero, and bring payments made in Xero back.';

/**
 * Settings → Integrations (`/settings/integrations`, BILL-09, ADR-053; owners and admins, behind
 * `integrations.xero`): connects the practice's Xero organisation through the token vault
 * (`integrations-start`, after a recent sign-in, then the provider's consent page and the callback
 * route), and chooses where invoices go in it (`xero-options`, then `xero-saveSettings`). Once saved
 * it offers to send what was issued since the "send from" date (`xero-send`). Disconnecting keeps the
 * settings, so reconnecting needs no setup.
 */
@Component({
  selector: 'mt-integrations-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MtButton,
    MtIntegrationCard,
    MtNote,
    MtSelect,
    MtSettingsRow,
    MtSettingsSection,
    MtSwitch,
    MtTextField,
  ],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  template: `
    <div class="mt-col" style="gap: 6px">
      <h1 class="title-l" style="margin: 0">Integrations</h1>
      <p style="margin: 0; color: var(--text-secondary)">
        Services connected once for the whole practice. Only owners and admins change them.
      </p>
    </div>

    @if (loadError(); as message) {
      <mt-note tone="danger">{{ message }}</mt-note>
    } @else if (!loaded()) {
      <p role="status" style="margin: 0; color: var(--text-tertiary)">Loading settings…</p>
    }

    <!-- Shown once the org has loaded, so nothing typed is overwritten when the settings arrive. -->
    @if (org.value() && loaded()) {
      <section class="mt-col" style="gap: 16px" aria-label="Xero" data-testid="xero">
        <mt-integration-card
          name="Xero"
          [description]="pitch"
          [status]="cardStatus()"
          [meta]="cardMeta()"
          data-testid="xero-card"
        >
          <div class="mt-row" style="gap: 6px">
            @if (connection() === 'disconnected') {
              <button mtButton variant="primary" size="sm" [loading]="connecting()" (click)="connect()">
                Connect Xero
              </button>
            } @else {
              @if (connection() === 'reconnect_required') {
                <button mtButton variant="secondary" size="sm" [loading]="connecting()" (click)="connect()">
                  Reconnect Xero
                </button>
              }
              <button mtButton variant="ghost" size="sm" [loading]="disconnecting()" (click)="disconnect()">
                Disconnect
              </button>
            }
          </div>
        </mt-integration-card>

        @if (connection() === 'connected') {
          @if (optionsError(); as message) {
            <mt-note tone="danger" data-testid="xero-options-error">
              {{ message }}
              <button mtButton variant="secondary" size="sm" [loading]="optionsLoading()" (click)="retryOptions()">
                Try again
              </button>
            </mt-note>
          } @else if (!options()) {
            <p role="status" style="margin: 0; color: var(--text-tertiary)">Loading your Xero organisations…</p>
          } @else if (!tenantOptions().length) {
            <mt-note tone="warning">
              Xero gave Materia no organisations. Disconnect, then connect again and choose one.
            </mt-note>
          } @else {
            <form class="mt-col" style="gap: 24px" (submit)="$event.preventDefault(); save()">
              <mt-settings-section
                title="Sending to Xero"
                description="Invoices and credit notes go to Xero as they’re issued. Payments made in Xero come back here."
                [headingLevel]="2"
              >
                <mt-select
                  name="tenantId"
                  label="Xero organisation"
                  [native]="true"
                  [options]="tenantOptions()"
                  [error]="problem('tenantId')"
                  [ngModel]="form().tenantId"
                  (ngModelChange)="chooseTenant($event)"
                />
                @if (optionsLoading()) {
                  <p role="status" class="caption t-3" style="margin: 0">Loading its accounts…</p>
                }
                <div class="pair">
                  <mt-select
                    name="feesAccountCode"
                    label="Fees account"
                    description="Professional fees, fixed fees and adjustments."
                    [native]="true"
                    [options]="accountOptions()"
                    [error]="problem('feesAccountCode')"
                    [ngModel]="form().feesAccountCode"
                    (ngModelChange)="set({ feesAccountCode: $event ?? '' })"
                  />
                  <mt-select
                    name="disbursementsAccountCode"
                    label="Disbursements account"
                    description="Disbursements recovered from the client."
                    [native]="true"
                    [options]="accountOptions()"
                    [error]="problem('disbursementsAccountCode')"
                    [ngModel]="form().disbursementsAccountCode"
                    (ngModelChange)="set({ disbursementsAccountCode: $event ?? '' })"
                  />
                </div>
                <mt-settings-row
                  title="Send each invoice to Xero when it’s issued"
                  description="Credit notes and voids go too. When off, only Send to Xero sends."
                >
                  <mt-switch
                    name="autoPush"
                    label="Send each invoice to Xero when it’s issued"
                    labelHidden
                    [ngModel]="form().autoPush"
                    (ngModelChange)="set({ autoPush: !!$event })"
                  />
                </mt-settings-row>
                <mt-text-field
                  name="sendFrom"
                  label="Send invoices issued from"
                  description="Earlier invoices stay out of Xero unless someone sends them."
                  placeholder="DD/MM/YYYY"
                  autocomplete="off"
                  class="date"
                  [error]="problem('sendFrom')"
                  [ngModel]="form().sendFrom"
                  (ngModelChange)="set({ sendFrom: $event ?? '' })"
                />
              </mt-settings-section>

              <div class="mt-row" style="gap: 8px">
                <button mtButton variant="primary" type="submit" [loading]="saving()" [disabled]="!ready()">
                  Save
                </button>
                <button mtButton variant="ghost" type="button" [disabled]="!unsaved()" (click)="reset()">
                  Discard changes
                </button>
              </div>
            </form>
          }

          @if (unsent(); as pending) {
            <mt-note data-testid="xero-unsent">
              {{ pending.text }}
              <button mtButton variant="secondary" size="sm" [loading]="sending()" (click)="sendUnsent()">
                Send them to Xero
              </button>
            </mt-note>
          }
        }

        @if (connection() !== 'disconnected') {
          <p class="caption t-3" style="margin: 0" data-testid="xero-payments-checked">{{ paymentsChecked() }}</p>
        }
      </section>
    }
  `,
  styles: `
    .pair {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: var(--space-12, 12px);
      align-items: start;
    }
    .date {
      max-width: 260px;
    }
    mt-note button {
      margin-top: var(--space-8, 8px);
      display: flex;
    }
  `,
})
export class IntegrationsPage implements HasUnsavedChanges {
  private readonly context = inject(OrgContext);
  private readonly callables = inject(CALLABLES);
  private readonly xero = xeroCallables(this.callables);
  private readonly integrations = integrationCallables(this.callables);
  private readonly toasts = inject(ToastService);
  private readonly dialogs = inject(DialogService);
  private readonly browser = inject(CONSENT_BROWSER);
  private readonly recentLogin = injectRecentLogin(SENSITIVE_REAUTH_MINUTES);
  private readonly today = inject(MT_TODAY);
  private readonly timeZone = inject(MT_ORG_TIMEZONE);

  protected readonly org = orgXeroSettingsRepository().watch(() => this.context.orgId());
  private readonly status = integrationStatusRepository().watch(() => (this.context.orgId() ? 'xero' : null));

  protected readonly loaded = computed(() => this.status.status() === 'ready' || !!this.status.value());
  protected readonly loadError = computed(() => {
    const error = this.org.error() ?? this.status.error();
    return error ? errorCopy(error) : null;
  });

  /** The connection: no status document is the same as never connected. */
  protected readonly connection = computed(() => this.status.value()?.status ?? 'disconnected');
  protected readonly pitch = XERO_PITCH;
  protected readonly cardStatus = computed<MtIntegrationStatus>(() => {
    const connection = this.connection();
    return connection === 'reconnect_required' ? 'reconnect' : connection;
  });
  /** Who it's connected as, or why it needs reconnecting. */
  protected readonly cardMeta = computed(() => {
    const status = this.status.value();
    if (!status || status.status === 'disconnected') return undefined;
    if (status.status === 'reconnect_required') {
      const on = status.reconnectRequiredAt ? ` on ${formatDateOnly(status.reconnectRequiredAt, this.timeZone)}` : '';
      return `Xero refused Materia’s saved sign-in${on}. Sending to Xero and bringing payments back are paused until someone reconnects; nothing is lost.`;
    }
    const account = status.account?.tenantName ?? status.account?.name ?? status.account?.email;
    const since = status.connectedAt ? ` on ${formatDateOnly(status.connectedAt, this.timeZone)}` : '';
    return account ? `Connected as ${account}${since}.` : `Connected${since}.`;
  });
  protected readonly paymentsChecked = computed(() => {
    const at = this.status.value()?.sync?.paymentsCheckedAt;
    return at ? `Payments last checked ${this.when(at)}.` : 'Payments are checked every hour once Xero is set up.';
  });

  protected readonly connecting = signal(false);
  protected readonly disconnecting = signal(false);

  // ---------- the settings ----------

  protected readonly options = signal<XeroOptionsResult | null>(null);
  protected readonly optionsLoading = signal(false);
  protected readonly optionsError = signal<string | null>(null);
  private optionsAsked = false;
  private optionsRequest = 0;

  protected readonly tenantOptions = computed<MtOption<string>[]>(() =>
    (this.options()?.tenants ?? []).map((tenant) => ({ value: tenant.tenantId, label: tenant.tenantName })),
  );
  protected readonly accountOptions = computed<MtOption<string>[]>(() =>
    (this.options()?.accounts ?? []).map((account) => ({
      value: account.code,
      label: `${account.code} · ${account.name}`,
    })),
  );

  protected readonly form = signal<XeroForm>(formOf(undefined, this.today()));
  private readonly saved = signal<XeroForm | null>(null);
  protected readonly saving = signal(false);
  protected readonly sending = signal(false);
  /** After a save: what was issued since "send from" and isn't in Xero yet. */
  protected readonly unsent = signal<{ count: number; text: string } | null>(null);

  /** Nothing saved yet: the defaults can be saved as they are. */
  private readonly firstSave = computed(() => !!this.org.value() && !this.org.value()?.xero);
  readonly unsaved = computed(() => {
    const saved = this.saved();
    return !!saved && JSON.stringify(saved) !== JSON.stringify(this.form());
  });
  private readonly sendFrom = computed(() => parseEntryDate(this.form().sendFrom, this.today()));
  private readonly parsed = computed(() => {
    const f = this.form();
    return XeroSettingsInput.safeParse({
      tenantId: f.tenantId,
      feesAccountCode: f.feesAccountCode,
      disbursementsAccountCode: f.disbursementsAccountCode,
      autoPush: f.autoPush,
      sendFrom: this.sendFrom() ?? '',
    });
  });
  /** Problems show once someone tries to save. */
  private readonly tried = signal(false);
  private readonly problems = computed<Partial<Record<string, string>>>(() => {
    const parsed = this.parsed();
    if (parsed.success) return {};
    const copy: Record<string, string> = {
      tenantId: 'Choose a Xero organisation.',
      feesAccountCode: 'Choose an account.',
      disbursementsAccountCode: 'Choose an account.',
      sendFrom: 'Enter a date as DD/MM/YYYY.',
    };
    return Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), copy[String(issue.path[0])]]));
  });
  protected readonly ready = computed(
    () => (this.unsaved() || this.firstSave()) && !this.saving() && !this.optionsLoading(),
  );

  constructor() {
    warnBeforeUnload(this.unsaved);
    effect(() => {
      const org = this.org.value();
      if (!org) return;
      untracked(() => {
        if (this.unsaved()) return;
        const form = formOf(org.xero, this.today());
        this.form.set(form);
        this.saved.set(form);
      });
    });
    // The organisations and accounts, once connected (again after reconnecting).
    effect(() => {
      const ready = this.connection() === 'connected' && !!this.org.value();
      untracked(() => {
        if (!ready) {
          this.optionsAsked = false;
          this.options.set(null);
          this.optionsError.set(null);
          return;
        }
        if (this.optionsAsked) return;
        this.optionsAsked = true;
        void this.loadOptions();
      });
    });
  }

  protected problem(field: keyof XeroForm): string | undefined {
    return this.tried() ? this.problems()[field] : undefined;
  }

  protected set(patch: Partial<XeroForm>): void {
    this.form.update((form) => ({ ...form, ...patch }));
  }

  protected reset(): void {
    const saved = this.saved();
    if (saved) this.form.set(saved);
    this.tried.set(false);
  }

  /** Another Xero organisation: its accounts replace the list, and codes it doesn't have are cleared. */
  protected chooseTenant(tenantId: string | null): void {
    if (!tenantId || tenantId === this.form().tenantId) return;
    this.set({ tenantId });
    void this.loadOptions(tenantId);
  }

  protected retryOptions(): void {
    void this.loadOptions(this.form().tenantId || undefined);
  }

  private async loadOptions(tenantId?: string): Promise<void> {
    const request = ++this.optionsRequest;
    this.optionsLoading.set(true);
    this.optionsError.set(null);
    try {
      const result = await this.xero.options(tenantId ? { tenantId } : {});
      if (request !== this.optionsRequest) return;
      this.options.set(result);
      const codes = new Set(result.accounts.map((account) => account.code));
      if (tenantId) {
        this.form.update((form) => ({
          ...form,
          feesAccountCode: codes.has(form.feesAccountCode) ? form.feesAccountCode : '',
          disbursementsAccountCode: codes.has(form.disbursementsAccountCode) ? form.disbursementsAccountCode : '',
        }));
      } else if (!this.form().tenantId && result.tenantId) {
        // The only organisation (or the saved one) is chosen for you; that isn't an unsaved change.
        const chosen = result.tenantId;
        this.form.update((form) => ({ ...form, tenantId: chosen }));
        this.saved.update((saved) => (saved && !saved.tenantId ? { ...saved, tenantId: chosen } : saved));
      }
    } catch (error) {
      if (request !== this.optionsRequest) return;
      this.optionsError.set(errorCopy(error));
    } finally {
      if (request === this.optionsRequest) this.optionsLoading.set(false);
    }
  }

  protected async save(): Promise<void> {
    this.tried.set(true);
    const parsed = this.parsed();
    if (!this.ready() || !parsed.success) return;
    this.saving.set(true);
    try {
      const result = await this.xero.saveSettings({ settings: parsed.data });
      const saved = { ...this.form(), sendFrom: formatEntryDate(parsed.data.sendFrom) };
      this.form.set(saved);
      this.saved.set(saved);
      this.tried.set(false);
      this.toasts.show({ title: 'Xero settings saved', tone: 'success' });
      this.unsent.set(
        result.unsent > 0 ? { count: result.unsent, text: unsentText(result.unsent, parsed.data.sendFrom) } : null,
      );
    } catch (error) {
      this.toasts.show({ title: 'The settings didn’t save', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.saving.set(false);
    }
  }

  /** "Send them to Xero": everything issued since "send from" that isn't there yet. */
  protected async sendUnsent(): Promise<void> {
    if (this.sending()) return;
    this.sending.set(true);
    try {
      const { queued } = await this.xero.send();
      this.unsent.set(null);
      this.toasts.show(
        queued > 0
          ? { title: `Sending ${queued} to Xero`, tone: 'success' }
          : { title: 'Everything is already in Xero', tone: 'neutral' },
      );
    } catch (error) {
      this.toasts.show({ title: 'Nothing was sent to Xero', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.sending.set(false);
    }
  }

  /** Connect or reconnect: a recent sign-in, then Xero's consent page, then back here. */
  protected async connect(): Promise<void> {
    if (this.connecting()) return;
    this.connecting.set(true);
    try {
      const result = await this.recentLogin('Connecting Xero needs a fresh sign-in.', () =>
        this.integrations.start({ provider: 'xero', returnTo: XERO.settingsPath, origin: this.browser.origin() }),
      );
      if (result) this.browser.assign(result.url);
    } catch (error) {
      this.toasts.show({ title: 'Xero isn’t connected', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.connecting.set(false);
    }
  }

  protected async disconnect(): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: 'Disconnect Xero?',
      body: 'Nothing more goes to Xero and payments stop coming back. What’s in Xero stays there, and these settings are kept for when you reconnect.',
      confirmLabel: 'Disconnect Xero',
      tone: 'danger',
    });
    if (!confirmed) return;
    this.disconnecting.set(true);
    try {
      await this.integrations.disconnect({ provider: 'xero' });
      this.unsent.set(null);
      this.toasts.show({ title: 'Xero disconnected', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'Xero is still connected', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.disconnecting.set(false);
    }
  }

  /** "4 Oct 2026 at 9:14 am", in the org's time zone. */
  private when(at: Date): string {
    const time = new Intl.DateTimeFormat('en-AU', { timeZone: this.timeZone, hour: 'numeric', minute: '2-digit' });
    return `${formatDateOnly(at, this.timeZone)} at ${time.format(at)}`;
  }
}

/** "3 invoices and credit notes issued since 1 Oct 2026 aren’t in Xero yet." */
function unsentText(count: number, since: DateOnly): string {
  const date = formatDateOnly(since);
  return count === 1
    ? `1 invoice or credit note issued since ${date} isn’t in Xero yet.`
    : `${count} invoices and credit notes issued since ${date} aren’t in Xero yet.`;
}
