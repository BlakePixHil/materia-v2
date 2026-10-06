import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  docTemplateCallables,
  LETTERHEAD_DOC,
  letterheadRepository,
  type LetterheadItem,
} from '@materia/data-access/repository';
import { LetterheadDetailsSchema } from '@materia/domain';
import { MtButton, MtNote, MtSettingsSection, MtTextarea, MtTextField, ToastService } from '@materia/ui';

import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { warnBeforeUnload } from '../settings/unsaved-changes';

interface LetterheadForm {
  address: string;
  phone: string;
  email: string;
  website: string;
  footer: string;
}

const formOf = (doc: LetterheadItem | null | undefined): LetterheadForm => ({
  address: doc?.address ?? '',
  phone: doc?.phone ?? '',
  email: doc?.email ?? '',
  website: doc?.website ?? '',
  footer: doc?.footer ?? '',
});

/**
 * Settings → Document templates → Letterhead details (INT-06): the address, phone, email, website
 * and footer line the letterhead and every template's `{firm.…}` tags print. The firm's name and
 * ABN come from Settings → Practice. Shown once the stored details have loaded, so nothing typed is
 * overwritten; saved through `docs-saveLetterhead`.
 */
@Component({
  selector: 'mt-letterhead-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtNote, MtSettingsSection, MtTextarea, MtTextField],
  template: `
    <mt-settings-section
      title="Letterhead details"
      description="Printed at the top of the letterhead and in any {firm.…} tag. Your practice name and ABN come from Settings → Practice."
      [headingLevel]="2"
    >
      @switch (doc.status()) {
        @case ('loading') {
          <p role="status" style="margin: 0; color: var(--text-tertiary)">Loading letterhead details…</p>
        }
        @case ('error') {
          <mt-note tone="danger">{{ loadError() }}</mt-note>
        }
        @default {
          <form
            class="mt-col"
            style="gap: var(--space-12, 12px)"
            aria-label="Letterhead details"
            (submit)="$event.preventDefault(); save()"
          >
            <mt-textarea
              name="address"
              label="Address"
              description="On separate lines, as it should print."
              placeholder="Level 2, 10 Example Street&#10;Geelong VIC 3220"
              [rows]="2"
              [error]="problems()['address']"
              [ngModel]="form().address"
              (ngModelChange)="set({ address: $event ?? '' })"
            />
            <div class="trio">
              <mt-text-field
                name="phone"
                label="Phone"
                inputmode="tel"
                autocomplete="off"
                [error]="problems()['phone']"
                [ngModel]="form().phone"
                (ngModelChange)="set({ phone: $event ?? '' })"
              />
              <mt-text-field
                name="email"
                label="Email"
                type="email"
                autocomplete="off"
                [error]="problems()['email']"
                [ngModel]="form().email"
                (ngModelChange)="set({ email: $event ?? '' })"
              />
              <mt-text-field
                name="website"
                label="Website"
                autocomplete="off"
                optional
                [error]="problems()['website']"
                [ngModel]="form().website"
                (ngModelChange)="set({ website: $event ?? '' })"
              />
            </div>
            <mt-text-field
              name="footer"
              label="Footer line"
              description="At the foot of every page, for example your professional standards scheme statement."
              autocomplete="off"
              optional
              [error]="problems()['footer']"
              [ngModel]="form().footer"
              (ngModelChange)="set({ footer: $event ?? '' })"
            />
            <div class="mt-row" style="gap: 8px">
              <button mtButton variant="primary" size="sm" type="submit" [loading]="saving()" [disabled]="!ready()">
                Save letterhead
              </button>
              <button mtButton variant="ghost" size="sm" type="button" [disabled]="!unsaved()" (click)="reset()">
                Discard changes
              </button>
            </div>
          </form>
        }
      }
    </mt-settings-section>
  `,
  styles: `
    .trio {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: var(--space-12, 12px);
      align-items: start;
    }
  `,
})
export class LetterheadSettings {
  private readonly api = docTemplateCallables(inject(CALLABLES));
  private readonly toasts = inject(ToastService);
  protected readonly doc = letterheadRepository().watch(LETTERHEAD_DOC);

  protected readonly form = signal<LetterheadForm>(formOf(undefined));
  private readonly saved = signal<LetterheadForm>(formOf(undefined));
  protected readonly saving = signal(false);

  readonly unsaved = computed(() => JSON.stringify(this.saved()) !== JSON.stringify(this.form()));
  private readonly parsed = computed(() => {
    const trimmed = Object.entries(this.form())
      .map(([key, value]) => [key, (value as string).trim()] as const)
      .filter(([, value]) => value !== '');
    return LetterheadDetailsSchema.safeParse(Object.fromEntries(trimmed));
  });
  protected readonly problems = computed((): Record<string, string | undefined> => {
    const parsed = this.parsed();
    if (parsed.success) return {};
    return Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), 'Too long']));
  });
  protected readonly ready = computed(() => this.unsaved() && this.parsed().success && !this.saving());
  protected readonly loadError = computed(() => errorCopy(this.doc.error()));

  constructor() {
    warnBeforeUnload(this.unsaved);
    // Follow the stored details until someone starts typing.
    effect(() => {
      const doc = this.doc.value();
      if (this.doc.status() === 'loading') return;
      untracked(() => {
        if (this.unsaved() || this.saving()) return;
        this.form.set(formOf(doc));
        this.saved.set(formOf(doc));
      });
    });
  }

  protected set(patch: Partial<LetterheadForm>): void {
    this.form.update((form) => ({ ...form, ...patch }));
  }

  protected reset(): void {
    this.form.set(this.saved());
  }

  protected async save(): Promise<void> {
    const parsed = this.parsed();
    if (!this.ready() || !parsed.success) return;
    this.saving.set(true);
    try {
      await this.api.saveLetterhead(parsed.data);
      const saved = formOf(parsed.data);
      this.form.set(saved);
      this.saved.set(saved);
      this.toasts.show({ title: 'Letterhead details saved', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'The letterhead details didn’t save', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.saving.set(false);
    }
  }
}
