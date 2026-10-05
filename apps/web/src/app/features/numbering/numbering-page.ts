import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { OrgContext } from '@materia/data-access';
import { orgSettingsRepository } from '@materia/data-access/repository';
import {
  DEFAULT_EXTERNAL_SYSTEM_NAME,
  DEFAULT_MATTER_NUMBER_FORMAT,
  DEFAULT_MATTER_TYPE_CODES,
  externalRefUrl,
  formatMatterNumber,
  isExternalUrlTemplate,
  matterNumberFormatProblem,
  MatterTypeCodeSchema,
  MatterTypeSchema,
  type MatterType,
} from '@materia/domain';
import { MATTER_TYPE_LABELS, MtButton, MtNote, MtSettingsSection, MtTextField, ToastService } from '@materia/ui';

import { errorCopy } from '../../core/error-copy';

const TYPES = MatterTypeSchema.options;

/** A form value: the stored value, or empty for "use the default". */
type Codes = Record<MatterType, string>;
const emptyCodes = (): Codes => Object.fromEntries(TYPES.map((type) => [type, ''])) as Codes;

/**
 * Settings → Matter numbering (`/settings/numbering`, CORE-21a; owners and admins): the practice's
 * number format with a live preview, the `{TYPE}` code of each matter type, and the firm's other
 * system (Elite 3E, say) with an optional link template. Saved client-direct on `orgs/{orgId}`
 * (the rules allow `org.settings` roles; the audit trigger records it). A new format applies to
 * new matters only; existing numbers change one at a time from the matter's "…" menu.
 */
@Component({
  selector: 'mt-numbering-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtNote, MtSettingsSection, MtTextField],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  template: `
    <h1 class="title-l" style="margin: 0">Matter numbering</h1>
    <p style="margin: 0; color: var(--text-secondary)">
      How new matters are numbered, and where the firm keeps the same matter in another system. To change an existing
      matter’s number, use “Change matter number” in the matter’s “…” menu.
    </p>

    @switch (org.status()) {
      @case ('loading') {
        <p role="status" style="margin: 0; color: var(--text-tertiary)">Loading settings…</p>
      }
      @case ('error') {
        <mt-note tone="danger">{{ loadError() }}</mt-note>
      }
    }

    <form class="mt-col" style="gap: 24px" (submit)="$event.preventDefault(); save()">
      <mt-settings-section
        title="Number format"
        description="New matters only. Tokens: {YYYY} year, {YY} two-digit year, {TYPE} matter type code, {seq} running number ({seq:4} pads to 0001). The running number restarts each year."
        [headingLevel]="2"
      >
        <mt-text-field
          name="format"
          label="Format"
          [placeholder]="defaultFormat"
          [error]="formatProblem() ?? undefined"
          [ngModel]="format()"
          (ngModelChange)="format.set($event ?? '')"
        />
        <p class="caption" style="margin: 0; color: var(--text-secondary)" aria-live="polite" data-preview>
          @if (!formatProblem()) {
            Next probate matter, for example: <strong class="mono">{{ preview() }}</strong>
          }
        </p>
      </mt-settings-section>

      <mt-settings-section
        title="Matter type codes"
        description="What {TYPE} becomes for each matter type. 1 to 6 letters or digits; leave empty for the default."
        [headingLevel]="2"
      >
        <div class="codes">
          @for (type of types; track type) {
            <mt-text-field
              size="sm"
              [name]="'code-' + type"
              [label]="typeLabel(type)"
              [placeholder]="defaultCodes[type]"
              [error]="codeProblems()[type]"
              [ngModel]="codes()[type]"
              (ngModelChange)="setCode(type, $event ?? '')"
            />
          }
        </div>
      </mt-settings-section>

      <mt-settings-section
        title="Practice management system"
        description="The system the firm also records matters in. Each matter can hold its number there, and the matter screen links to it when you add a link template."
        [headingLevel]="2"
      >
        <mt-text-field
          name="systemName"
          label="System name"
          [placeholder]="defaultSystem"
          [error]="systemNameProblem() ?? undefined"
          [ngModel]="systemName()"
          (ngModelChange)="systemName.set($event ?? '')"
        />
        <mt-text-field
          name="urlTemplate"
          label="Link template"
          placeholder="https://3e.yourfirm.com.au/matter/{ref}"
          description="Optional. {ref} is replaced with the matter’s number in that system."
          [error]="urlProblem() ?? undefined"
          [ngModel]="urlTemplate()"
          (ngModelChange)="urlTemplate.set($event ?? '')"
        />
        @if (urlPreview(); as url) {
          <p class="caption" style="margin: 0; color: var(--text-secondary)">
            Example link: <span class="mono">{{ url }}</span>
          </p>
        }
      </mt-settings-section>

      <div class="mt-row" style="gap: 8px">
        <button mtButton variant="primary" type="submit" [loading]="saving()" [disabled]="!ready()">Save</button>
        <button mtButton variant="ghost" type="button" [disabled]="!dirty()" (click)="reset()">Discard changes</button>
      </div>
    </form>
  `,
  styles: `
    .codes {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: var(--space-12);
    }
    .mono {
      font-family: var(--font-mono);
      overflow-wrap: anywhere;
    }
  `,
})
export class NumberingPage {
  private readonly context = inject(OrgContext);
  private readonly toasts = inject(ToastService);
  private readonly repo = orgSettingsRepository();
  protected readonly org = this.repo.watch(() => this.context.orgId());

  protected readonly types = TYPES;
  protected readonly defaultCodes = DEFAULT_MATTER_TYPE_CODES;
  protected readonly defaultFormat = DEFAULT_MATTER_NUMBER_FORMAT;
  protected readonly defaultSystem = DEFAULT_EXTERNAL_SYSTEM_NAME;

  protected readonly format = signal('');
  protected readonly codes = signal<Codes>(emptyCodes());
  protected readonly systemName = signal('');
  protected readonly urlTemplate = signal('');
  protected readonly saving = signal(false);
  private readonly loaded = signal<string | null>(null);

  protected readonly formatProblem = computed(() => matterNumberFormatProblem(this.format()));
  protected readonly preview = computed(() =>
    formatMatterNumber(this.format().trim(), new Date().getFullYear(), 1, this.code('probate')),
  );
  protected readonly codeProblems = computed(() => {
    const problems: Partial<Record<MatterType, string>> = {};
    for (const type of TYPES) {
      const value = this.codes()[type].trim();
      const parsed = value ? MatterTypeCodeSchema.safeParse(value) : undefined;
      if (parsed && !parsed.success) problems[type] = parsed.error.issues[0]?.message ?? 'Invalid code';
    }
    return problems;
  });
  protected readonly systemNameProblem = computed(() =>
    this.systemName().trim().length > 30 ? 'Keep it to 30 characters or fewer.' : null,
  );
  protected readonly urlProblem = computed(() => {
    const value = this.urlTemplate().trim();
    if (!value) return null;
    if (value.length > 500) return 'Keep it to 500 characters or fewer.';
    return isExternalUrlTemplate(value) ? null : 'Use a web address starting https:// that contains {ref}.';
  });
  protected readonly urlPreview = computed(() =>
    this.urlProblem() ? null : externalRefUrl(this.urlTemplate(), '104233'),
  );
  private readonly valid = computed(
    () =>
      !this.formatProblem() &&
      !Object.keys(this.codeProblems()).length &&
      !this.systemNameProblem() &&
      !this.urlProblem(),
  );
  protected readonly dirty = computed(() => this.loaded() !== null && this.loaded() !== JSON.stringify(this.patch()));
  protected readonly ready = computed(() => this.dirty() && this.valid() && !this.saving());
  protected readonly loadError = computed(() => {
    const error = this.org.error();
    return error ? errorCopy(error) : 'Couldn’t load the settings.';
  });

  constructor() {
    // Fill the form from the stored settings when they load (and after a save), not while editing.
    effect(() => {
      const org = this.org.value();
      if (!org) return;
      untracked(() => {
        if (this.dirty()) return;
        this.format.set(org.matterNumberFormat || DEFAULT_MATTER_NUMBER_FORMAT);
        this.codes.set({ ...emptyCodes(), ...(org.matterTypeCodes ?? {}) } as Codes);
        this.systemName.set(org.externalSystem?.name ?? '');
        this.urlTemplate.set(org.externalSystem?.urlTemplate ?? '');
        this.loaded.set(JSON.stringify(this.patch()));
      });
    });
  }

  protected typeLabel(type: MatterType): string {
    return MATTER_TYPE_LABELS[type];
  }

  protected setCode(type: MatterType, value: string): void {
    this.codes.update((codes) => ({ ...codes, [type]: value }));
  }

  private code(type: MatterType): string {
    const value = this.codes()[type].trim();
    return value && MatterTypeCodeSchema.safeParse(value).success ? value : DEFAULT_MATTER_TYPE_CODES[type];
  }

  /** The org fields the form writes; empty values are left out (removed on save). */
  private patch() {
    const codes = Object.fromEntries(
      TYPES.map((type) => [type, this.codes()[type].trim()] as const).filter(([, value]) => !!value),
    );
    const name = this.systemName().trim();
    const urlTemplate = this.urlTemplate().trim();
    return {
      matterNumberFormat: this.format().trim(),
      ...(Object.keys(codes).length ? { matterTypeCodes: codes } : {}),
      ...(name || urlTemplate
        ? { externalSystem: { name: name || DEFAULT_EXTERNAL_SYSTEM_NAME, ...(urlTemplate ? { urlTemplate } : {}) } }
        : {}),
    };
  }

  protected reset(): void {
    this.loaded.set(null);
    const org = this.org.value();
    this.format.set(org?.matterNumberFormat || DEFAULT_MATTER_NUMBER_FORMAT);
    this.codes.set({ ...emptyCodes(), ...(org?.matterTypeCodes ?? {}) } as Codes);
    this.systemName.set(org?.externalSystem?.name ?? '');
    this.urlTemplate.set(org?.externalSystem?.urlTemplate ?? '');
    this.loaded.set(JSON.stringify(this.patch()));
  }

  protected async save(): Promise<void> {
    const orgId = this.context.orgId();
    if (!orgId || !this.ready()) return;
    const patch = this.patch();
    const remove = (['matterTypeCodes', 'externalSystem'] as const).filter((field) => !(field in patch));
    this.saving.set(true);
    try {
      await this.repo.update(orgId, patch, { remove });
      this.loaded.set(JSON.stringify(patch));
      this.toasts.show({ title: 'Matter numbering saved', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'The settings didn’t save', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.saving.set(false);
    }
  }
}
