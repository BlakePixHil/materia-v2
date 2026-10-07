import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';

import {
  DOC_TEMPLATES_QUERY,
  docTemplateCallables,
  docTemplatesRepository,
  type DocTemplateItem,
  type WithId,
} from '@materia/data-access/repository';
import {
  DOC_TEMPLATE_KIND_LABELS,
  SYSTEM_DOC_TEMPLATES,
  systemDocTemplate,
  templateInputs,
  type SystemDocTemplate,
} from '@materia/domain';
import {
  DialogService,
  MATTER_TYPE_LABELS,
  MT_MENU,
  MtBadge,
  MtButton,
  MtIconButton,
  MtNote,
  MtSettingsRow,
  MtSettingsSection,
  MtSkeleton,
  ToastService,
} from '@materia/ui';

import {
  docTemplateErrorCopy,
  downloadBase64,
  replacedBy,
  templateStatus,
  unpublishedLatest,
} from './document-templates-view';
import { LetterheadSettings } from './letterhead-settings';
import { TemplateFields } from './template-fields';
import type { TemplateTestData } from './template-test-dialog';
import type { TemplateUploadData, TemplateUploadResult } from './template-upload-dialog';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import type { HasUnsavedChanges } from '../settings/unsaved-changes';

type Template = WithId<DocTemplateItem>;

/**
 * Settings → Document templates (`/settings/document-templates`, INT-06, ADR-047; owners and
 * admins): the letterhead details, the firm's own .docx templates (upload, new versions, test
 * merge against a matter, publish, download, delete), the built-in letterhead and samples (test
 * merge, download to start from, replace), and the Template fields help. People generate
 * documents from published templates on a matter's Documents tab.
 */
@Component({
  selector: 'mt-document-templates-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MT_MENU,
    MtBadge,
    MtButton,
    MtIconButton,
    MtNote,
    MtSettingsRow,
    MtSettingsSection,
    MtSkeleton,
    LetterheadSettings,
    TemplateFields,
  ],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  template: `
    <div class="mt-row head">
      <div class="mt-col mt-grow" style="gap: 6px">
        <h1 class="title-l" style="margin: 0">Document templates</h1>
        <p style="margin: 0; color: var(--text-secondary)">
          Word templates for letters, file notes and disclosures. On a matter’s Documents tab, New from template fills
          one in from the matter and saves it with the matter’s documents.
        </p>
      </div>
      <mt-badge>Owners and admins</mt-badge>
    </div>

    <mt-letterhead-settings />

    <mt-settings-section
      title="Your templates"
      description="Upload a .docx with tags such as {client.fullName}. A new upload is a draft: test-merge it on a matter, then publish it."
      [headingLevel]="2"
    >
      <div class="mt-row" style="gap: 8px">
        <button mtButton variant="primary" size="sm" iconStart="upload" (click)="upload()">Upload template</button>
      </div>
      @switch (templates.status()) {
        @case ('loading') {
          <mt-skeleton variant="fields" framed label="Loading templates…" />
        }
        @case ('error') {
          <mt-note tone="danger">
            {{ loadError() }}
            <button mtButton size="sm" (click)="templates.refresh()">Try again</button>
          </mt-note>
        }
      }
      @for (template of templates.value(); track template.id) {
        <mt-settings-row [title]="template.name" [description]="details(template)" [attr.data-template]="template.id">
          <div class="actions">
            <mt-badge [tone]="status(template).tone">{{ status(template).label }}</mt-badge>
            @if (latest(template); as version) {
              <button
                mtButton
                size="sm"
                variant="secondary"
                [loading]="busy() === template.id"
                [disabled]="!!busy()"
                [attr.aria-label]="'Publish v' + version + ' of ' + template.name"
                (click)="publish(template, version)"
              >
                Publish v{{ version }}
              </button>
            }
            <button
              mtButton
              size="sm"
              variant="ghost"
              [attr.aria-label]="'Test merge ' + template.name"
              (click)="test(template.id, template.name, inputsOf(template))"
            >
              Test merge
            </button>
            <button
              mtIconButton
              icon="more"
              size="sm"
              [label]="'More actions for ' + template.name"
              [mtMenuTrigger]="menu"
            ></button>
            <ng-template #menu>
              <mt-menu [attr.aria-label]="template.name">
                <button mtMenuItem icon="upload" (click)="upload({ template })">Upload new version</button>
                <button mtMenuItem icon="settings" (click)="upload({ template, detailsOnly: true })">
                  Edit details
                </button>
                <button mtMenuItem icon="arrow-down" (click)="download(template.id)">
                  Download v{{ template.version }}
                </button>
                @if (template.published) {
                  <button mtMenuItem icon="eye" (click)="unpublish(template)">Unpublish</button>
                }
                <mt-menu-separator />
                <button mtMenuItem icon="trash" (click)="remove(template)">Delete</button>
              </mt-menu>
            </ng-template>
          </div>
        </mt-settings-row>
        @for (warning of warnings(template); track warning) {
          <mt-note tone="info">{{ template.name }}: {{ warning }}</mt-note>
        }
      } @empty {
        @if (templates.status() === 'ready') {
          <p style="margin: 0; color: var(--text-tertiary)" data-testid="no-templates">
            None yet. Download a built-in template below, change it in Word and upload it, or upload your own.
          </p>
        }
      }
    </mt-settings-section>

    <mt-settings-section
      title="Built-in templates"
      description="Ready on every matter, with your letterhead details. Download one to start your own: once yours is published with Replaces set, it takes the built-in one’s place."
      [headingLevel]="2"
    >
      @for (template of system; track template.id) {
        <mt-settings-row
          [title]="template.name"
          [description]="template.description"
          [attr.data-template]="template.id"
        >
          <div class="actions">
            @if (replaced().get(template.id); as by) {
              <mt-badge tone="info">Replaced by {{ by }}</mt-badge>
            } @else {
              <mt-badge>Built in</mt-badge>
            }
            <button
              mtButton
              size="sm"
              variant="ghost"
              [attr.aria-label]="'Test merge ' + template.name"
              (click)="test(template.id, template.name, template.inputs)"
            >
              Test merge
            </button>
            <button
              mtIconButton
              icon="arrow-down"
              size="sm"
              [label]="'Download ' + template.name"
              (click)="download(template.id)"
            ></button>
            <button
              mtButton
              size="sm"
              variant="secondary"
              [attr.aria-label]="'Replace ' + template.name"
              (click)="upload({ replaces: template })"
            >
              Replace
            </button>
          </div>
        </mt-settings-row>
      }
      @if (costsPlaceholder) {
        <mt-note tone="warning">
          The costs disclosure is an illustrative placeholder, not reviewed by a practitioner. Replace it with your own
          before sending it to a client.
        </mt-note>
      }
    </mt-settings-section>

    <mt-template-fields />
  `,
  styles: `
    .head {
      align-items: flex-start;
      gap: var(--space-16, 16px);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      align-items: center;
      gap: var(--space-8, 8px);
    }
    @media (max-width: 599px) {
      .head {
        flex-direction: column;
      }
      .actions {
        justify-content: flex-start;
      }
    }
  `,
})
export class DocumentTemplatesPage implements HasUnsavedChanges {
  private readonly api = docTemplateCallables(inject(CALLABLES));
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly letterhead = viewChild(LetterheadSettings);

  protected readonly templates = docTemplatesRepository().watchQuery(DOC_TEMPLATES_QUERY);
  protected readonly system: readonly SystemDocTemplate[] = SYSTEM_DOC_TEMPLATES;
  protected readonly costsPlaceholder = !!systemDocTemplate('system-costs-disclosure');
  protected readonly replaced = computed(() => replacedBy(this.templates.value()));
  protected readonly busy = signal<string | null>(null);
  protected readonly loadError = computed(() => errorCopy(this.templates.error()));

  readonly unsaved = computed(() => this.letterhead()?.unsaved() ?? false);

  protected readonly status = templateStatus;
  protected readonly latest = unpublishedLatest;

  protected details(template: Template): string {
    const types = template.matterTypes.length
      ? template.matterTypes.map((type) => MATTER_TYPE_LABELS[type]).join(', ')
      : 'every matter';
    const replaces = template.replaces
      ? ` · replaces ${systemDocTemplate(template.replaces)?.name ?? 'a built-in template'}`
      : '';
    return `${DOC_TEMPLATE_KIND_LABELS[template.kind]} · v${template.version} · ${template.fields.length} fields · offered on ${types}${replaces}`;
  }

  protected warnings(template: Template): string[] {
    return template.versions.find((v) => v.version === template.version)?.warnings ?? [];
  }

  protected inputsOf(template: Template) {
    return templateInputs(template.fields);
  }

  protected async upload(data: TemplateUploadData = {}): Promise<void> {
    const { TemplateUploadDialog } = await import('./template-upload-dialog');
    const result = await this.dialogs.open<TemplateUploadData, TemplateUploadResult>(TemplateUploadDialog, { data })
      .result;
    if (!result) return;
    if (data.detailsOnly) {
      this.toasts.show({ title: 'Template details saved', tone: 'success' });
      return;
    }
    const template: TemplateTestData = {
      templateId: result.templateId,
      name: result.name,
      version: result.version,
      inputs: templateInputs(result.fields),
    };
    this.toasts.show({
      title: `${result.name} v${result.version} uploaded`,
      description: result.warnings.length
        ? result.warnings.join(' ')
        : `${result.fields.length} fields checked. Test-merge it, then publish it.`,
      tone: 'success',
      duration: 8000,
      action: { label: 'Test merge', run: () => void this.openTest(template) },
    });
  }

  protected test(templateId: string, name: string, inputs: TemplateTestData['inputs']): void {
    void this.openTest({ templateId, name, inputs });
  }

  private async openTest(data: TemplateTestData): Promise<void> {
    const { TemplateTestDialog } = await import('./template-test-dialog');
    await this.dialogs.open<TemplateTestData, undefined>(TemplateTestDialog, { data }).result;
  }

  protected async publish(template: Template, version: number): Promise<void> {
    this.busy.set(template.id);
    try {
      await this.api.publishTemplate({ templateId: template.id, version });
      this.toasts.show({
        title: `${template.name} v${version} published`,
        description: 'New documents use this version from now on.',
        tone: 'success',
      });
    } catch (error) {
      this.toasts.show({
        title: 'The template wasn’t published',
        description: docTemplateErrorCopy(error),
        tone: 'danger',
      });
    } finally {
      this.busy.set(null);
    }
  }

  protected async unpublish(template: Template): Promise<void> {
    try {
      await this.api.unpublishTemplate(template.id);
      this.toasts.show({
        title: `${template.name} unpublished`,
        description: 'It’s no longer offered on matters.',
        tone: 'success',
      });
    } catch (error) {
      this.toasts.show({
        title: 'The template wasn’t unpublished',
        description: docTemplateErrorCopy(error),
        tone: 'danger',
      });
    }
  }

  protected async remove(template: Template): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: `Delete ${template.name}?`,
      body: 'It’s no longer offered on matters. Documents already generated from it stay as they are.',
      confirmLabel: 'Delete template',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await this.api.deleteTemplate(template.id);
      this.toasts.show({ title: `${template.name} deleted`, tone: 'success' });
    } catch (error) {
      this.toasts.show({
        title: 'The template wasn’t deleted',
        description: docTemplateErrorCopy(error),
        tone: 'danger',
      });
    }
  }

  protected async download(templateId: string): Promise<void> {
    try {
      const file = await this.api.downloadTemplate({ templateId });
      downloadBase64(file.fileName, file.contentBase64);
    } catch (error) {
      this.toasts.show({
        title: 'The template didn’t download',
        description: docTemplateErrorCopy(error),
        tone: 'danger',
      });
    }
  }
}
