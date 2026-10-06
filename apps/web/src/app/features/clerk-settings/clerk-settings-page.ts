import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { can, OrgContext } from '@materia/data-access';
import {
  clerkMetricsRepository,
  MEMBER_LIST_QUERY,
  membersRepository,
  orgClerkSettingsRepository,
} from '@materia/data-access/repository';
import {
  CLERK_DISCLOSURE_VERSION,
  CLERK_DISCLOSURES,
  clerkAcknowledged,
  clerkMeteringPeriod,
  DEFAULT_CLERK_MODEL,
  formatUsdCents,
  looksLikeAnthropicKey,
  MAX_DAILY_REQUESTS,
  microsToCents,
  normaliseAnthropicKey,
  ORG_CLERK_FEATURES,
  orgClerkFeatureOn,
  type ClerkKeyStatus,
  type ClerkModelChoice,
  type OrgClerkFeature,
  type SetClerkApiKeyResult,
  type UpdateClerkSettingsInput,
  type UpdateClerkSettingsResult,
} from '@materia/domain';
import {
  DialogService,
  formatDateOnly,
  MT_ORG_TIMEZONE,
  MtButton,
  MtIcon,
  MtNote,
  MtRadioGroup,
  MtSettingsRow,
  MtSettingsSection,
  MtSwitch,
  MtTextField,
  ToastService,
  type MtOption,
} from '@materia/ui';
import { MtMarkdown } from '@materia/ui/markdown';

import { ClerkUsage } from './clerk-usage';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { dollarsText, parseDollars } from '../settings/money';

/** "1,250" → 1250; empty is null; anything else undefined (invalid). */
function parseCount(text: string): number | null | undefined {
  const trimmed = text.replace(/[,\s]/g, '');
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 && value <= MAX_DAILY_REQUESTS ? value : undefined;
}

/**
 * Settings → Clerk and AI (`/settings/clerk`, AI-02a and AI-13). Owners and admins:
 * - acknowledge the data-use disclosure (Clerk stays off until they do, and again for a new version);
 * - turn Clerk on or off for the practice and per feature (saved at once);
 * - set the monthly spend limit and the per-person daily request limit;
 * - save the firm's Anthropic API key and choose the model (AI-02a);
 * - see this month's usage and cost.
 * Everyone else sees which features are on and the disclosure, read-only. Every change goes
 * through `clerk-updateSettings` (audited); the gateway enforces it on the next request.
 */
@Component({
  selector: 'mt-clerk-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ClerkUsage,
    FormsModule,
    MtButton,
    MtIcon,
    MtMarkdown,
    MtNote,
    MtRadioGroup,
    MtSettingsRow,
    MtSettingsSection,
    MtSwitch,
    MtTextField,
    RouterLink,
  ],
  template: `
    <div class="layout" [class.with-aside]="canConfigure()">
      <div class="main mt-col">
        <div class="mt-col" style="gap: 6px">
          <h1 class="title-l" style="margin: 0">Clerk and AI</h1>
          <p style="margin: 0; color: var(--text-secondary)">
            Choose what Clerk can do for {{ orgName() }}. These settings apply to everyone in the practice.
            <a routerLink="/help/clerk">How Clerk works</a>
          </p>
        </div>

        @if (org.status() === 'error') {
          <mt-note tone="danger">Clerk’s settings couldn’t be loaded. {{ errorText(org.error()) }}</mt-note>
        }

        <mt-settings-section
          title="How Clerk uses your firm’s data"
          [description]="'Data-use disclosure, version ' + disclosureVersion + '.'"
          [headingLevel]="2"
          data-disclosure
        >
          <div class="mt-card disclosure-card" [attr.data-pending]="loaded() && !acknowledged() ? '' : null">
            @if (loaded()) {
              @if (acknowledged()) {
                <p class="ack" data-acknowledged>
                  <mt-icon name="check-circle" />
                  <span
                    >Acknowledged by {{ acknowledgedBy()
                    }}{{ acknowledgedOn() ? ' on ' + acknowledgedOn() : '' }}.</span
                  >
                </p>
              } @else {
                <mt-note tone="warning" data-ack-needed>
                  @if (settings()?.ackVersion) {
                    This disclosure has changed. Clerk is off until an owner or admin reads it and acknowledges it
                    again.
                  } @else {
                    Clerk is off until an owner or admin reads this and acknowledges it.
                  }
                </mt-note>
              }
            }
            <details class="fold disclosure" [open]="loaded() && !acknowledged()">
              <summary>
                <span class="mt-grow">Read the disclosure</span>
                <span class="chev"><mt-icon name="chevron-down" /></span>
              </summary>
              <div class="disclosure-text" tabindex="0" role="region" aria-label="Clerk data-use disclosure">
                <mt-markdown [content]="disclosure" [breaks]="false" />
              </div>
            </details>
            @if (canConfigure() && loaded() && !acknowledged()) {
              <div>
                <button mtButton variant="primary" type="button" [loading]="saving() === 'ack'" (click)="acknowledge()">
                  I’ve read this, turn Clerk on
                </button>
              </div>
            }
          </div>
        </mt-settings-section>

        <mt-settings-section title="Clerk for your practice" [headingLevel]="2">
          <mt-settings-row
            title="Clerk"
            description="Turns every Clerk feature on or off for everyone in the practice."
          >
            @if (canConfigure()) {
              <mt-switch
                name="clerk-enabled"
                label="Clerk"
                labelHidden
                [disabled]="!loaded() || !!saving()"
                [ngModel]="enabled()"
                (ngModelChange)="setEnabled(!!$event)"
              />
            } @else {
              <span class="state" data-state="enabled">{{ enabled() ? 'On' : 'Off' }}</span>
            }
          </mt-settings-row>
        </mt-settings-section>

        <mt-settings-section
          title="What Clerk can do"
          description="Everything Clerk produces arrives as a suggestion or a draft for a person to check."
          [headingLevel]="2"
        >
          @for (feature of features; track feature.key) {
            <mt-settings-row
              [title]="feature.label"
              [description]="feature.description"
              [attr.data-feature]="feature.key"
            >
              @if (canConfigure()) {
                <mt-switch
                  [name]="'clerk-feature-' + feature.key"
                  [label]="feature.label"
                  labelHidden
                  [disabled]="!loaded() || !!saving()"
                  [ngModel]="featureOn(feature.key)"
                  (ngModelChange)="setFeature(feature.key, !!$event)"
                />
              } @else {
                <span class="state">{{ featureOn(feature.key) ? 'On' : 'Off' }}</span>
              }
            </mt-settings-row>
          }
          <mt-settings-row
            title="Send, file or bill"
            description="Clerk never sends email, files with a court or registry, or issues a bill. A person always does."
            locked
          >
            <span class="state">Never</span>
          </mt-settings-row>
        </mt-settings-section>

        @if (canConfigure()) {
          <mt-settings-section
            title="Limits"
            description="Clerk stops for the rest of the month at the spend limit, and for a person for the rest of the day at the request limit. Leave a limit empty for none."
            [headingLevel]="2"
          >
            <form class="mt-col" style="gap: 12px" (submit)="$event.preventDefault(); saveLimits()">
              <div class="pair">
                <mt-text-field
                  name="clerk-budget"
                  label="Monthly spend limit"
                  description="In US dollars, as Anthropic bills your firm."
                  inputmode="decimal"
                  suffix="USD"
                  [error]="budgetProblem() ?? undefined"
                  [ngModel]="budgetText()"
                  (ngModelChange)="budgetText.set($event ?? '')"
                />
                <mt-text-field
                  name="clerk-daily"
                  label="Requests per person per day"
                  inputmode="numeric"
                  [error]="dailyProblem() ?? undefined"
                  [ngModel]="dailyText()"
                  (ngModelChange)="dailyText.set($event ?? '')"
                />
              </div>
              <div>
                <button
                  mtButton
                  variant="secondary"
                  type="submit"
                  [loading]="saving() === 'limits'"
                  [disabled]="!limitsChanged() || !!budgetProblem() || !!dailyProblem()"
                >
                  Save limits
                </button>
              </div>
            </form>
          </mt-settings-section>

          <mt-settings-section
            title="Anthropic API key"
            description="Clerk runs on your firm’s own Anthropic account, and your firm pays Anthropic directly. The key is stored encrypted; nobody can see it again after you save it, including you."
            [headingLevel]="2"
          >
            <div class="stack">
              @if (keyLoadError(); as message) {
                <mt-note tone="danger">{{ message }}</mt-note>
              }
              <p role="status" style="margin: 0" data-key-status>
                @if (!status()) {
                  <span style="color: var(--text-tertiary)">Loading…</span>
                } @else if (status()?.set) {
                  Key ending <strong class="mono">{{ status()?.last4 }}</strong>
                  @if (validatedOn(); as date) {
                    · checked {{ date }}
                  }
                } @else {
                  No key saved. Clerk is off for your practice.
                }
              </p>
              @if (status()?.status === 'invalid') {
                <mt-note tone="danger">Anthropic rejected this key. Clerk is off until you save a new one.</mt-note>
              }

              <form class="mt-col" style="gap: 12px" (submit)="$event.preventDefault(); saveKey()">
                <mt-text-field
                  name="clerk-api-key"
                  type="password"
                  autocomplete="off"
                  [label]="status()?.set ? 'Replace the key' : 'API key'"
                  placeholder="sk-ant-…"
                  [error]="keyProblem() ?? undefined"
                  [ngModel]="keyInput()"
                  (ngModelChange)="keyInput.set($event ?? '')"
                />
                <div class="mt-row" style="gap: 8px">
                  <button mtButton variant="primary" type="submit" [loading]="savingKey()" [disabled]="!canSaveKey()">
                    Save key
                  </button>
                  @if (status()?.set) {
                    <button mtButton variant="ghost" type="button" [loading]="removing()" (click)="removeKey()">
                      Remove key
                    </button>
                  }
                </div>
              </form>
            </div>
          </mt-settings-section>

          <mt-settings-section
            title="Model"
            description="Applies to everyone in your practice. Your firm’s Anthropic account is billed per token."
            [headingLevel]="2"
          >
            <div class="stack">
              <mt-radio-group
                name="clerk-model"
                label="Clerk model"
                [options]="modelOptions()"
                [disabled]="!status() || savingModel()"
                [ngModel]="model()"
                (ngModelChange)="setModel($event)"
              />
              @if (status()?.set && status()?.opusAvailable === false) {
                <mt-note tone="warning">This key can’t use Claude Opus 5.5, so Clerk stays on Sonnet 5.5.</mt-note>
              }
            </div>
          </mt-settings-section>
        }

        <mt-settings-section title="Data and retention" [headingLevel]="2">
          <details class="fold mt-card retention" data-retention>
            <summary>
              <span class="mt-grow">Processed outside Australia, never used for training, kept with the matter</span>
              <span class="chev"><mt-icon name="chevron-down" /></span>
            </summary>
            <div class="fold-body">
              <mt-settings-row
                title="Processing location"
                description="Anthropic processes Clerk requests outside Australia. Everything else stays in Google Cloud in Sydney."
                locked
              >
                <span class="state">Outside Australia</span>
              </mt-settings-row>
              <mt-settings-row
                title="Model training"
                description="Anthropic’s commercial terms don’t allow using your firm’s requests to train its models."
                locked
              >
                <span class="state">Never</span>
              </mt-settings-row>
              <mt-settings-row
                title="Clerk conversations and suggestions"
                description="Kept with the matter file and destroyed with it."
                locked
              >
                <span class="state">With the matter</span>
              </mt-settings-row>
            </div>
          </details>
        </mt-settings-section>
      </div>

      @if (canConfigure()) {
        <aside class="aside">
          <mt-clerk-usage [currentPeriod]="period" [budgetCents]="settings()?.monthlyBudgetCents ?? null" />
          <mt-note
            >Practitioners remain responsible for advice. Clerk’s answers carry citations so they can be
            checked.</mt-note
          >
        </aside>
      }
    </div>
  `,
  styles: `
    /* Emulated encapsulation: rules here reach elements in this template, not the host. */
    :host {
      display: block;
      container-type: inline-size;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 720px);
      gap: 40px;
      align-items: start;
    }
    /* The usage column sits beside the settings only when there is room for both. */
    @container (min-width: 1080px) {
      .layout.with-aside {
        grid-template-columns: minmax(0, 720px) 320px;
      }
    }
    .main {
      gap: 32px;
      min-width: 0;
    }
    .aside {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
    }
    .stack {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .pair {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
    }
    .state {
      color: var(--text-secondary);
      font: 400 13px/18px var(--font-sans);
      white-space: nowrap;
    }
    .mono {
      font-family: var(--font-mono);
    }

    .disclosure-card {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px;
    }
    .disclosure-card[data-pending] {
      border-color: var(--border-ai);
    }
    .ack {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      font: 400 13px/18px var(--font-sans);
      color: var(--text-secondary);
    }
    .ack mt-icon {
      color: var(--text-success);
      flex: none;
    }

    /* Expanders: a summary row with a chevron that turns when open. */
    .fold > summary {
      display: flex;
      align-items: center;
      gap: 8px;
      list-style: none;
      cursor: pointer;
      font: 500 13px/18px var(--font-sans);
      color: var(--text-primary);
      border-radius: var(--radius-md);
    }
    .fold > summary::-webkit-details-marker {
      display: none;
    }
    .fold > summary:focus-visible {
      box-shadow: var(--focus-ring);
      outline: none;
    }
    .fold > summary .chev {
      display: inline-flex;
      flex: none;
      color: var(--icon-muted);
      transition: transform 0.15s ease-out;
    }
    .fold[open] > summary .chev {
      transform: rotate(180deg);
    }
    @media (prefers-reduced-motion: reduce) {
      .fold > summary .chev {
        transition: none;
      }
    }
    .disclosure > summary {
      padding: 8px 12px;
      margin: 0 -12px;
    }
    .disclosure > summary:hover,
    .retention > summary:hover {
      background: var(--bg-hover);
    }
    /* The disclosure reads in its own scroll box, so the acknowledge button stays close. */
    .disclosure-text {
      margin-top: 8px;
      max-height: 360px;
      overflow-y: auto;
      padding: 12px 16px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-sunken);
    }
    /* Focusable so keyboard users can scroll it. */
    .disclosure-text:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .disclosure-text ::ng-deep p:has(> b:only-child):not(:first-child) {
      margin-top: 8px;
    }
    .retention > summary {
      padding: 12px 16px;
      color: var(--text-secondary);
      font-weight: 400;
    }
    .retention .fold-body .mt-setting {
      border: 0;
      border-top: 1px solid var(--border-default);
      border-radius: 0;
      background: transparent;
    }
  `,
})
export class ClerkSettingsPage {
  private readonly callables = inject(CALLABLES);
  private readonly toasts = inject(ToastService);
  private readonly dialogs = inject(DialogService);
  private readonly timeZone = inject(MT_ORG_TIMEZONE);
  private readonly context = inject(OrgContext);

  protected readonly canConfigure = can('clerk.configure');
  protected readonly features = ORG_CLERK_FEATURES;
  protected readonly disclosureVersion = CLERK_DISCLOSURE_VERSION;
  protected readonly disclosure = CLERK_DISCLOSURES[CLERK_DISCLOSURE_VERSION] ?? '';
  protected readonly period = clerkMeteringPeriod(new Date());

  protected readonly org = orgClerkSettingsRepository().watch(() => this.context.orgId());
  protected readonly settings = computed(() => this.org.value()?.settings?.clerk);
  protected readonly loaded = computed(() => this.org.status() === 'ready');
  protected readonly orgName = computed(() => this.org.value()?.name ?? 'your practice');
  protected readonly enabled = computed(() => this.settings()?.enabled !== false);
  protected readonly acknowledged = computed(() => clerkAcknowledged(this.settings()));
  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 }, { live: false });
  protected readonly acknowledgedBy = computed(() => {
    const uid = this.settings()?.acknowledgedBy;
    return this.members.value().find((m) => m.id === uid)?.displayName || 'an owner or admin';
  });
  protected readonly acknowledgedOn = computed(() => {
    const at = this.settings()?.acknowledgedAt;
    return at ? formatDateOnly(at.toISOString(), this.timeZone) : null;
  });

  /** What is saving: `ack`, `limits`, `enabled` or a feature key. */
  protected readonly saving = signal<string | null>(null);

  // ---------- limits ----------
  private readonly thisMonth = clerkMetricsRepository().watch(() =>
    this.canConfigure() && this.context.orgId() ? this.period : null,
  );
  protected readonly budgetText = signal('');
  protected readonly dailyText = signal('');
  private readonly budgetCents = computed(() => parseDollars(this.budgetText()));
  private readonly dailyRequests = computed(() => parseCount(this.dailyText()));
  protected readonly budgetProblem = computed(() =>
    this.budgetCents() === undefined ? 'Enter an amount in dollars, such as 250.' : null,
  );
  protected readonly dailyProblem = computed(() =>
    this.dailyRequests() === undefined
      ? `Enter a whole number from 1 to ${MAX_DAILY_REQUESTS.toLocaleString()}.`
      : null,
  );
  protected readonly limitsChanged = computed(
    () =>
      this.loaded() &&
      (this.budgetCents() !== (this.settings()?.monthlyBudgetCents ?? null) ||
        this.dailyRequests() !== (this.settings()?.perUserDailyRequests ?? null)),
  );

  // ---------- key and model (AI-02a) ----------
  protected readonly status = signal<ClerkKeyStatus | null>(null);
  protected readonly keyLoadError = signal<string | null>(null);
  protected readonly keyInput = signal('');
  protected readonly savingKey = signal(false);
  protected readonly removing = signal(false);
  protected readonly savingModel = signal(false);
  protected readonly model = signal<ClerkModelChoice>(DEFAULT_CLERK_MODEL);

  private readonly normalisedKey = computed(() => normaliseAnthropicKey(this.keyInput()));
  protected readonly keyProblem = computed(() => {
    const key = this.normalisedKey();
    if (!key || looksLikeAnthropicKey(key)) return null;
    return 'This doesn’t look like an Anthropic API key. It starts with sk-ant-.';
  });
  protected readonly canSaveKey = computed(
    () => !!this.normalisedKey() && !this.keyProblem() && !this.savingKey() && !!this.status(),
  );
  protected readonly validatedOn = computed(() => {
    const at = this.status()?.validatedAt;
    return at ? formatDateOnly(at, this.timeZone) : null;
  });
  protected readonly modelOptions = computed((): MtOption<ClerkModelChoice>[] => [
    {
      value: 'claude-sonnet-5-5',
      label: 'Claude Sonnet 5.5 (default)',
      description: 'Fast and capable for everyday matter work. $2 in / $10 out per million tokens.',
    },
    {
      value: 'claude-opus-5-5',
      label: 'Claude Opus 5.5',
      description: 'Anthropic’s most capable model, at about twice the cost. $4 in / $20 out per million tokens.',
      disabled: this.status()?.set === true && this.status()?.opusAvailable === false,
    },
  ]);

  constructor() {
    // The limits fields follow the saved settings until someone edits them.
    let filled = false;
    effect(() => {
      if (!this.loaded()) return;
      const settings = this.settings();
      untracked(() => {
        if (filled && this.limitsChanged()) return;
        filled = true;
        this.budgetText.set(dollarsText(settings?.monthlyBudgetCents));
        this.dailyText.set(settings?.perUserDailyRequests ? String(settings.perUserDailyRequests) : '');
      });
    });
    effect(() => {
      if (this.canConfigure()) untracked(() => void this.loadKey());
    });
  }

  protected featureOn(key: OrgClerkFeature): boolean {
    return orgClerkFeatureOn(this.settings(), key);
  }

  protected setEnabled(on: boolean): void {
    if (on !== this.enabled()) void this.update({ enabled: on }, 'enabled');
  }

  protected setFeature(key: OrgClerkFeature, on: boolean): void {
    if (on !== this.featureOn(key)) void this.update({ features: { [key]: on } }, key);
  }

  protected errorText(error: unknown): string {
    return error ? errorCopy(error) : '';
  }

  /** Saves a switch at once; the watched document shows the result. */
  protected async update(patch: Omit<UpdateClerkSettingsInput, 'requestId'>, what: string): Promise<boolean> {
    this.saving.set(what);
    try {
      await this.callables.call<Omit<UpdateClerkSettingsInput, 'requestId'>, UpdateClerkSettingsResult>(
        'clerk-updateSettings',
        patch,
        { idempotent: true },
      );
      return true;
    } catch (error) {
      this.toasts.show({ title: 'The setting didn’t save', description: errorCopy(error), tone: 'danger' });
      return false;
    } finally {
      this.saving.set(null);
    }
  }

  protected async acknowledge(): Promise<void> {
    if (await this.update({ acknowledgeVersion: CLERK_DISCLOSURE_VERSION }, 'ack'))
      this.toasts.show({ title: 'Disclosure acknowledged. Clerk is on for your practice.', tone: 'success' });
  }

  protected async saveLimits(): Promise<void> {
    const budget = this.budgetCents();
    const daily = this.dailyRequests();
    if (budget === undefined || daily === undefined || !this.limitsChanged()) return;
    const spent = microsToCents(this.thisMonth.value()?.values['costMicros'] ?? 0);
    if (budget !== null && budget <= spent && budget !== (this.settings()?.monthlyBudgetCents ?? null)) {
      const ok = await this.dialogs.confirm({
        title: 'Stop Clerk for the rest of the month?',
        body: `Clerk has used about ${formatUsdCents(spent)} this month. A limit of ${formatUsdCents(budget)} stops Clerk for everyone until next month or until you raise it.`,
        confirmLabel: 'Set the limit',
        tone: 'danger',
      });
      if (!ok) return;
    }
    if (await this.update({ monthlyBudgetCents: budget, perUserDailyRequests: daily }, 'limits'))
      this.toasts.show({ title: 'Limits saved', tone: 'success' });
  }

  private async loadKey(): Promise<void> {
    try {
      const status = await this.callables.call<object, ClerkKeyStatus>('clerk-getApiKeyStatus', {});
      this.status.set(status);
      this.model.set(status.model);
      this.keyLoadError.set(null);
    } catch (error) {
      this.keyLoadError.set(errorCopy(error));
    }
  }

  protected async saveKey(): Promise<void> {
    if (!this.canSaveKey()) return;
    this.savingKey.set(true);
    try {
      const result = await this.callables.call<{ apiKey: string }, SetClerkApiKeyResult>(
        'clerk-setApiKey',
        { apiKey: this.normalisedKey() },
        { idempotent: true },
      );
      this.keyInput.set('');
      this.toasts.show({
        title: `Key ending ${result.last4} saved`,
        ...(result.modelReset
          ? { description: 'This key can’t use Opus 5.5, so Clerk moved back to Sonnet 5.5.' }
          : {}),
        tone: 'success',
      });
      await this.loadKey();
    } catch (error) {
      this.toasts.show({ title: 'The key wasn’t saved', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.savingKey.set(false);
    }
  }

  protected async removeKey(): Promise<void> {
    this.removing.set(true);
    try {
      await this.callables.call('clerk-removeApiKey', {}, { idempotent: true });
      this.toasts.show({ title: 'Key removed. Clerk is off for your practice.', tone: 'success' });
      await this.loadKey();
    } catch (error) {
      this.toasts.show({ title: 'The key wasn’t removed', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.removing.set(false);
    }
  }

  protected async setModel(next: ClerkModelChoice | null): Promise<void> {
    const previous = this.model();
    if (!next || next === previous) return;
    this.model.set(next);
    this.savingModel.set(true);
    try {
      await this.callables.call('clerk-setModel', { model: next }, { idempotent: true });
      this.toasts.show({
        title: next === 'claude-opus-5-5' ? 'Clerk now uses Opus 5.5' : 'Clerk now uses Sonnet 5.5',
        tone: 'success',
      });
      this.status.update((status) => (status ? { ...status, model: next } : status));
    } catch (error) {
      this.model.set(previous);
      this.toasts.show({ title: 'The model wasn’t changed', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.savingModel.set(false);
    }
  }
}
