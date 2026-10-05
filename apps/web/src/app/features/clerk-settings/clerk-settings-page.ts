import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  DEFAULT_CLERK_MODEL,
  looksLikeAnthropicKey,
  normaliseAnthropicKey,
  type ClerkKeyStatus,
  type ClerkModelChoice,
  type SetClerkApiKeyResult,
} from '@materia/domain';
import {
  formatDateOnly,
  MT_ORG_TIMEZONE,
  MtButton,
  MtNote,
  MtRadioGroup,
  MtSettingsSection,
  MtTextField,
  ToastService,
  type MtOption,
} from '@materia/ui';

import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';

/**
 * Settings → Clerk (`/settings/clerk`, AI-02a; owners and admins): the firm's own Anthropic API key
 * and the model Clerk runs on (ADR-011b). The key is pasted into a password field, sent once to
 * `clerk-setApiKey` (which validates and encrypts it) and cleared; the page only ever shows its last
 * four characters. AI-13 adds budgets and usage to this page.
 */
@Component({
  selector: 'mt-clerk-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtNote, MtRadioGroup, MtSettingsSection, MtTextField],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  template: `
    <h1 class="title-l" style="margin: 0">Clerk</h1>
    <p style="margin: 0; color: var(--text-secondary)">
      Clerk runs on your firm’s own Anthropic account. Add an API key from the Anthropic Console to turn it on.
    </p>

    <mt-note data-disclosure>
      Clerk sends matter context (documents, key facts and your questions) to Anthropic under your firm’s own Anthropic
      account and terms. Your firm pays Anthropic directly and sets data retention and spend limits in its Anthropic
      Console.
    </mt-note>

    @if (loadError(); as message) {
      <mt-note tone="danger">{{ message }}</mt-note>
    }

    <mt-settings-section
      title="Anthropic API key"
      description="Stored encrypted. Nobody can see it again after you save it, including you."
      [headingLevel]="2"
    >
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
    </mt-settings-section>

    <mt-settings-section
      title="Model"
      description="Applies to everyone in your practice. Your firm’s Anthropic account is billed per token."
      [headingLevel]="2"
    >
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
    </mt-settings-section>
  `,
  styles: `
    .mono {
      font-family: var(--font-mono);
    }
  `,
})
export class ClerkSettingsPage {
  private readonly callables = inject(CALLABLES);
  private readonly toasts = inject(ToastService);
  private readonly timeZone = inject(MT_ORG_TIMEZONE);

  protected readonly status = signal<ClerkKeyStatus | null>(null);
  protected readonly loadError = signal<string | null>(null);
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
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const status = await this.callables.call<object, ClerkKeyStatus>('clerk-getApiKeyStatus', {});
      this.status.set(status);
      this.model.set(status.model);
      this.loadError.set(null);
    } catch (error) {
      this.loadError.set(errorCopy(error));
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
      await this.load();
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
      await this.load();
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
