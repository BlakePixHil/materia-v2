import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can } from '@materia/data-access';
import { DOC_TEMPLATES_QUERY, docTemplateCallables, docTemplatesRepository } from '@materia/data-access/repository';
import {
  DOC_BODY_MAX,
  DOC_TEMPLATE_KIND_LABELS,
  longDate,
  offeredDocTemplates,
  templateInputs,
  type DocTemplateInput,
  type GenerateDocumentResult,
  type MatterType,
} from '@materia/domain';
import {
  injectDialogRef,
  MT_TODAY,
  MtButton,
  MtCheckbox,
  MtDialog,
  MtNote,
  MtRadioGroup,
  MtTextarea,
  MtTextField,
  type MtOption,
} from '@materia/ui';

import { docTemplateErrorCopy, templateProblems } from './document-templates-view';
import { CALLABLES } from '../../core/data/callables';
import { MtNeedsConnection } from '../../core/pwa/needs-connection';

export interface GenerateDocumentData {
  matterId: string;
  matterType: MatterType;
  /** "HV-2026-0001 · Estate of Margaret Doyle", under the title. */
  matterLabel: string;
  /** The matter is privileged, so the document is too. */
  privilegedMatter: boolean;
}

interface Choice {
  id: string;
  name: string;
  inputs: readonly DocTemplateInput[];
}

/**
 * New from template (INT-06): picks one of the firm's published templates offered for the matter's
 * type, or a built-in one, takes a body or recipient when the template has those tags, and
 * generates the document on the matter through `docs-generate` (filed under the template kind's
 * category, `source: generated`, with a PDF preview to follow). Closes with the result, whose
 * `missing` fields the tab reports.
 */
@Component({
  selector: 'mt-generate-document-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MtButton,
    MtCheckbox,
    MtDialog,
    MtNeedsConnection,
    MtNote,
    MtRadioGroup,
    MtTextarea,
    MtTextField,
  ],
  template: `
    <mt-dialog size="md" title="New from template" [description]="data.matterLabel">
      <form
        id="mt-generate-form"
        class="mt-col"
        style="gap: var(--space-12, 12px)"
        aria-label="New from template"
        (submit)="$event.preventDefault(); generate()"
      >
        @if (templates.status() === 'loading') {
          <p role="status" class="caption t-3" style="margin: 0">Loading templates…</p>
        } @else {
          <mt-radio-group
            name="template"
            label="Template"
            [options]="options()"
            [ngModel]="chosenId()"
            (ngModelChange)="choose($event)"
          />
        }
        <mt-text-field
          name="name"
          label="Document name"
          optional
          autocomplete="off"
          [placeholder]="defaultName()"
          [ngModel]="name()"
          (ngModelChange)="name.set($event ?? '')"
        />
        @if (inputs().includes('recipient')) {
          <div class="pair">
            <mt-text-field
              name="recipientName"
              label="To"
              optional
              autocomplete="off"
              [ngModel]="recipientName()"
              (ngModelChange)="recipientName.set($event ?? '')"
            />
            <mt-textarea
              name="recipientAddress"
              label="Their address"
              optional
              [rows]="2"
              [ngModel]="recipientAddress()"
              (ngModelChange)="recipientAddress.set($event ?? '')"
            />
          </div>
        }
        @if (inputs().includes('body')) {
          <mt-textarea
            name="body"
            label="Body"
            optional
            description="# headings, **bold**, *italics*, - bullets and 1. numbers are formatted in Word."
            [rows]="6"
            [maxLength]="bodyMax"
            [ngModel]="body()"
            (ngModelChange)="body.set($event ?? '')"
          />
        }
        @if (canPrivileged() && !data.privilegedMatter) {
          <mt-checkbox
            name="privileged"
            label="Privileged"
            description="Only owners, admins and lawyers can open it."
            [ngModel]="privileged()"
            (ngModelChange)="privileged.set(!!$event)"
          />
        }
        @if (error(); as message) {
          <mt-note tone="danger" role="alert">
            {{ message }}
            @if (problems().length) {
              <ul class="problems">
                @for (problem of problems(); track $index) {
                  <li>{{ problem }}</li>
                }
              </ul>
            }
          </mt-note>
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" type="button" (click)="ref.close()">Cancel</button>
        <button
          mtButton
          variant="primary"
          type="submit"
          form="mt-generate-form"
          mtNeedsConnection
          [loading]="saving()"
          [disabled]="!chosen()"
        >
          Generate document
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
    .problems {
      margin: 6px 0 0;
      padding-left: 18px;
    }
  `,
})
export class GenerateDocumentDialog {
  protected readonly ref = injectDialogRef<GenerateDocumentData, GenerateDocumentResult>();
  protected readonly data = this.ref.data;
  private readonly api = docTemplateCallables(inject(CALLABLES));
  private readonly today = inject(MT_TODAY);
  protected readonly canPrivileged = can('privileged.view');
  protected readonly templates = docTemplatesRepository().watchQuery(DOC_TEMPLATES_QUERY);
  protected readonly bodyMax = DOC_BODY_MAX;

  private readonly choices = computed((): (Choice & { description: string })[] => {
    const offered = offeredDocTemplates(this.templates.value(), this.data.matterType);
    return [
      ...offered.org.map((t) => ({
        id: t.id,
        name: t.name,
        inputs: templateInputs(t.versions.find((v) => v.version === t.publishedVersion)?.fields ?? t.fields),
        description: `${DOC_TEMPLATE_KIND_LABELS[t.kind]} · your template`,
      })),
      ...offered.system.map((t) => ({
        id: t.id,
        name: t.name,
        inputs: t.inputs,
        description: `${DOC_TEMPLATE_KIND_LABELS[t.kind]} · built in`,
      })),
    ];
  });
  protected readonly options = computed<MtOption<string>[]>(() =>
    this.choices().map((c) => ({ value: c.id, label: c.name, description: c.description })),
  );
  protected readonly chosenId = signal<string | null>(null);
  protected readonly chosen = computed(() => this.choices().find((c) => c.id === this.chosenId()) ?? null);
  protected readonly inputs = computed(() => this.chosen()?.inputs ?? []);
  protected readonly defaultName = computed(() => {
    const chosen = this.chosen();
    return chosen ? `${chosen.name} ${longDate(this.today())}` : '';
  });

  protected readonly name = signal('');
  protected readonly body = signal('');
  protected readonly recipientName = signal('');
  protected readonly recipientAddress = signal('');
  protected readonly privileged = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly problems = signal<string[]>([]);

  protected choose(id: string | null): void {
    this.chosenId.set(id);
    this.error.set(null);
    this.problems.set([]);
  }

  protected async generate(): Promise<void> {
    const chosen = this.chosen();
    if (!chosen || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    this.problems.set([]);
    try {
      const inputs = chosen.inputs;
      const body = inputs.includes('body') ? this.body().trim() : '';
      const to = inputs.includes('recipient') ? this.recipientName().trim() : '';
      const address = inputs.includes('recipient') ? this.recipientAddress().trim() : '';
      const name = this.name().trim();
      const result = await this.api.generate({
        templateId: chosen.id,
        matterId: this.data.matterId,
        ...(name ? { name } : {}),
        ...(body || to || address
          ? {
              data: {
                ...(body ? { body } : {}),
                ...(to || address
                  ? { recipient: { ...(to ? { name: to } : {}), ...(address ? { address } : {}) } }
                  : {}),
              },
            }
          : {}),
        ...(this.privileged() ? { privileged: true } : {}),
      });
      this.ref.close(result);
    } catch (error) {
      this.error.set(docTemplateErrorCopy(error));
      this.problems.set(templateProblems(error).map((problem) => problem.message));
    } finally {
      this.saving.set(false);
    }
  }
}
