import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { docTemplateCallables, type DocTemplateItem, type WithId } from '@materia/data-access/repository';
import {
  DOC_TEMPLATE_KIND_LABELS,
  DOC_TEMPLATE_KINDS,
  DOC_TEMPLATE_NAME_MAX,
  MatterTypeSchema,
  SYSTEM_DOC_TEMPLATES,
  type DocTemplateKind,
  type DocTemplateProblem,
  type MatterType,
  type SaveDocTemplateResult,
  type SystemDocTemplate,
} from '@materia/domain';
import {
  injectDialogRef,
  MATTER_TYPE_LABELS,
  MtButton,
  MtCheckbox,
  MtDialog,
  MtNote,
  MtSelect,
  MtTextField,
  type MtOption,
} from '@materia/ui';

import { docTemplateErrorCopy, fileBase64, TEMPLATE_MAX_BYTES, templateProblems } from './document-templates-view';
import { CALLABLES } from '../../core/data/callables';

export interface TemplateUploadData {
  /** A new version of this template; otherwise a new template. */
  template?: WithId<DocTemplateItem>;
  /** Replace this built-in template (its kind and name to start from). */
  replaces?: SystemDocTemplate;
  /** Change the details only, without a new file. */
  detailsOnly?: boolean;
}

export interface TemplateUploadResult extends SaveDocTemplateResult {
  name: string;
}

/**
 * Upload a .docx template, or a new version of one, or change a template's details (INT-06):
 * name, kind, the matter types it's offered on and the built-in template it replaces. The server
 * checks every tag and scans the file; a refused tag is listed by name. Closes with the saved
 * template and version (unpublished: the page offers to test-merge and publish it).
 */
@Component({
  selector: 'mt-template-upload-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtCheckbox, MtDialog, MtNote, MtSelect, MtTextField],
  template: `
    <mt-dialog size="md" [title]="title" [description]="description">
      <form
        id="mt-template-upload-form"
        class="mt-col"
        style="gap: var(--space-12, 12px)"
        aria-label="Template"
        (submit)="$event.preventDefault(); save()"
      >
        @if (!data.detailsOnly) {
          <div class="file mt-col" style="gap: 6px">
            <span class="label" id="mt-template-file-label">Word file (.docx)</span>
            <input
              #picker
              type="file"
              hidden
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              data-testid="template-file-input"
              aria-labelledby="mt-template-file-label"
              (change)="picked($event)"
            />
            <div class="mt-row" style="gap: 8px; align-items: center; flex-wrap: wrap">
              <button mtButton variant="secondary" size="sm" type="button" iconStart="upload" (click)="picker.click()">
                {{ file() ? 'Choose another file' : 'Choose file' }}
              </button>
              <span class="caption" [class.t-3]="!file()" data-testid="template-file-name">
                {{ file()?.name ?? 'No file chosen. Up to 5 MB.' }}
              </span>
            </div>
            @if (fileProblem(); as text) {
              <p class="caption" role="alert" style="margin: 0; color: var(--text-danger)">{{ text }}</p>
            }
          </div>
        }
        <mt-text-field
          name="name"
          label="Name"
          autocomplete="off"
          [error]="nameProblem() ?? undefined"
          [ngModel]="name()"
          (ngModelChange)="name.set($event ?? '')"
        />
        <div class="pair">
          <mt-select
            name="kind"
            label="Kind"
            description="Where generated documents are filed."
            [native]="true"
            [options]="kinds"
            [ngModel]="kind()"
            (ngModelChange)="kind.set($event ?? 'other')"
          />
          <mt-select
            name="replaces"
            label="Replaces built-in template"
            description="Hidden on matters while this one is published."
            [native]="true"
            [options]="systemOptions"
            [ngModel]="replaces()"
            (ngModelChange)="replaces.set($event ?? '')"
          />
        </div>
        <fieldset class="types">
          <legend class="label">Offered on</legend>
          <p class="caption t-3" style="margin: 0 0 6px">Leave all unticked to offer it on every matter.</p>
          <div class="checks">
            @for (type of matterTypes; track type) {
              <mt-checkbox
                [name]="'type-' + type"
                [label]="typeLabels[type]"
                [ngModel]="types().includes(type)"
                (ngModelChange)="toggle(type, !!$event)"
              />
            }
          </div>
        </fieldset>
        @if (error(); as message) {
          <mt-note tone="danger" role="alert">
            {{ message }}
            @if (problems().length) {
              <ul class="problems" data-testid="template-problems">
                @for (problem of problems(); track $index) {
                  <li>{{ problem.message }}</li>
                }
              </ul>
            }
          </mt-note>
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" type="button" (click)="ref.close()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-template-upload-form" [loading]="saving()">
          {{ data.detailsOnly ? 'Save details' : data.template ? 'Upload version' : 'Upload template' }}
        </button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .pair {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: var(--space-12, 12px);
      align-items: start;
    }
    .types {
      border: 0;
      margin: 0;
      padding: 0;
    }
    .checks {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 6px var(--space-12, 12px);
    }
    .problems {
      margin: 6px 0 0;
      padding-left: 18px;
    }
  `,
})
export class TemplateUploadDialog {
  protected readonly ref = injectDialogRef<TemplateUploadData, TemplateUploadResult>();
  protected readonly data = this.ref.data;
  private readonly api = docTemplateCallables(inject(CALLABLES));

  private readonly existing = this.data.template;
  protected readonly title = this.data.detailsOnly
    ? `Edit ${this.existing?.name ?? 'template'}`
    : this.existing
      ? `New version of ${this.existing.name}`
      : this.data.replaces
        ? `Replace ${this.data.replaces.name}`
        : 'Upload template';
  protected readonly description = this.existing
    ? this.data.detailsOnly
      ? 'Name, kind and where it’s offered.'
      : `Saved as v${this.existing.version + 1}. Matters keep using the published version until you publish this one.`
    : 'Saved as a draft. Test-merge it on a matter, then publish it.';

  protected readonly kinds: MtOption<DocTemplateKind>[] = DOC_TEMPLATE_KINDS.map((kind) => ({
    value: kind,
    label: DOC_TEMPLATE_KIND_LABELS[kind],
  }));
  protected readonly systemOptions: MtOption<string>[] = [
    { value: '', label: 'None' },
    ...SYSTEM_DOC_TEMPLATES.map((t) => ({ value: t.id, label: t.name })),
  ];
  protected readonly matterTypes: readonly MatterType[] = MatterTypeSchema.options;
  protected readonly typeLabels = MATTER_TYPE_LABELS;

  protected readonly file = signal<File | null>(null);
  protected readonly name = signal(this.existing?.name ?? this.data.replaces?.name ?? '');
  protected readonly kind = signal<DocTemplateKind>(this.existing?.kind ?? this.data.replaces?.kind ?? 'letter');
  protected readonly replaces = signal(this.existing?.replaces ?? this.data.replaces?.id ?? '');
  protected readonly types = signal<readonly MatterType[]>(this.existing?.matterTypes ?? []);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly problems = signal<DocTemplateProblem[]>([]);
  protected readonly fileProblem = signal<string | null>(null);
  private readonly attempted = signal(false);

  protected readonly nameProblem = computed(() => {
    const name = this.name().trim();
    if (!this.attempted()) return null;
    if (!name) return 'Name the template';
    return name.length > DOC_TEMPLATE_NAME_MAX ? `Up to ${DOC_TEMPLATE_NAME_MAX} characters` : null;
  });

  protected picked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    this.error.set(null);
    this.problems.set([]);
    if (!file) return;
    if (!/\.docx$/i.test(file.name)) {
      this.fileProblem.set('Choose a Word .docx file. Save older .doc files as .docx in Word first.');
      return;
    }
    if (file.size === 0 || file.size > TEMPLATE_MAX_BYTES) {
      this.fileProblem.set('A template can be up to 5 MB.');
      return;
    }
    this.fileProblem.set(null);
    this.file.set(file);
    if (!this.name().trim()) this.name.set(file.name.replace(/\.docx$/i, ''));
  }

  protected toggle(type: MatterType, on: boolean): void {
    this.types.update((types) => (on ? [...new Set([...types, type])] : types.filter((t) => t !== type)));
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.attempted.set(true);
    const file = this.file();
    if (!this.data.detailsOnly && !file) this.fileProblem.set('Choose the .docx file to upload.');
    if (this.nameProblem() || this.fileProblem() || (!this.data.detailsOnly && !file)) return;
    this.saving.set(true);
    this.error.set(null);
    this.problems.set([]);
    try {
      const name = this.name().trim();
      const replaces = this.replaces();
      const result = await this.api.saveTemplate({
        ...(this.existing ? { templateId: this.existing.id } : {}),
        name,
        kind: this.kind(),
        matterTypes: [...this.types()],
        ...(replaces ? { replaces } : this.existing?.replaces ? { replaces: null } : {}),
        ...(file && !this.data.detailsOnly
          ? { file: { fileName: file.name, contentBase64: await fileBase64(file) } }
          : {}),
      });
      this.ref.close({ ...result, name });
    } catch (error) {
      this.error.set(docTemplateErrorCopy(error));
      this.problems.set(templateProblems(error));
    } finally {
      this.saving.set(false);
    }
  }
}
