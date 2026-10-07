import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { ORG_TEMPLATES_QUERY, orgTemplatesRepository, templateCallables } from '@materia/data-access/repository';
import { systemTemplates } from '@materia/domain';
import {
  MATTER_TYPE_LABELS,
  MtBadge,
  MtButton,
  MtNote,
  MtSettingsRow,
  MtSettingsSection,
  ToastService,
} from '@materia/ui';

import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';

/**
 * Settings → Templates (`/settings/templates`, CORE-07; owners and admins, behind
 * `templates.system`): the system templates that ship with Materia, which "Customise" copies into
 * an editable org template (`templates-clone`), and the org's templates with their published
 * version. Matters keep the version they were given; publishing makes a new one.
 */
@Component({
  selector: 'mt-templates-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MtBadge, MtButton, MtNote, MtSettingsRow, MtSettingsSection],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  template: `
    <div class="mt-col" style="gap: 6px">
      <h1 class="title-l" style="margin: 0">Matter templates</h1>
      <p style="margin: 0; color: var(--text-secondary)">
        A template sets a matter type’s stages, the tasks each stage creates and the deadline rules that apply. Matters
        keep the version they started on until someone upgrades them.
      </p>
    </div>

    @if (error(); as message) {
      <mt-note tone="danger">{{ message }}</mt-note>
    }

    <mt-settings-section title="Your templates" [headingLevel]="2">
      @switch (templates.status()) {
        @case ('loading') {
          <p role="status" style="margin: 0; color: var(--text-tertiary)">Loading templates…</p>
        }
        @case ('error') {
          <mt-note tone="danger">
            {{ loadError() }}
            <button mtButton size="sm" (click)="templates.refresh()">Try again</button>
          </mt-note>
        }
      }
      @for (template of templates.value(); track template.id) {
        <mt-settings-row
          [title]="template.name"
          [description]="
            typeLabel(template.matterType) +
            (template.basedOn ? ' · based on ' + sourceName(template.basedOn.templateId) : '')
          "
          [attr.data-template]="template.id"
        >
          <div class="mt-row" style="gap: 8px; align-items: center">
            @if (template.published) {
              <mt-badge tone="success">Published v{{ template.version }}</mt-badge>
            } @else {
              <mt-badge tone="warning">Draft</mt-badge>
            }
            <a mtButton size="sm" [routerLink]="template.id" [attr.aria-label]="'Edit ' + template.name">Edit</a>
          </div>
        </mt-settings-row>
      } @empty {
        @if (templates.status() === 'ready') {
          <p style="margin: 0; color: var(--text-tertiary)">
            None yet. Customise a system template below to make one for your practice.
          </p>
        }
      }
    </mt-settings-section>

    <mt-settings-section
      title="System templates"
      description="Maintained by Materia. Customise one to change its stages or tasks for your practice."
      [headingLevel]="2"
    >
      @for (template of system; track template.id) {
        <mt-settings-row
          [title]="template.name"
          [description]="
            typeLabel(template.matterType) +
            ' · ' +
            template.stages.length +
            ' stages · ' +
            template.tasks.length +
            ' tasks'
          "
          [attr.data-template]="template.id"
        >
          <div class="mt-row" style="gap: 8px; align-items: center">
            <mt-badge>System v{{ template.version }}</mt-badge>
            <button
              mtButton
              size="sm"
              [loading]="cloning() === template.id"
              [disabled]="!!cloning()"
              [attr.aria-label]="'Customise ' + template.name"
              (click)="customise(template.id, template.name)"
            >
              Customise
            </button>
          </div>
        </mt-settings-row>
      }
    </mt-settings-section>
  `,
})
export class TemplatesPage {
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly api = templateCallables(inject(CALLABLES));

  protected readonly templates = orgTemplatesRepository().watchQuery(ORG_TEMPLATES_QUERY);
  protected readonly system = systemTemplates();
  protected readonly cloning = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loadError = computed(() => {
    const error = this.templates.error();
    return error ? errorCopy(error) : '';
  });

  protected typeLabel(type: keyof typeof MATTER_TYPE_LABELS): string {
    return MATTER_TYPE_LABELS[type];
  }

  /** "Probate (system)" or the org template's name. */
  protected sourceName(templateId: string): string {
    const system = this.system.find((template) => template.id === templateId);
    if (system) return `${system.name} (system)`;
    return this.templates.value().find((template) => template.id === templateId)?.name ?? 'another template';
  }

  /** Copies a system template into a new org draft and opens it. */
  protected async customise(templateId: string, name: string): Promise<void> {
    this.error.set(null);
    this.cloning.set(templateId);
    try {
      const { templateId: id } = await this.api.clone({ sourceTemplateId: templateId, name: `${name} (customised)` });
      this.toasts.show({ title: `Copied ${name}`, description: 'Edit it, then publish to use it.', tone: 'success' });
      await this.router.navigate(['/settings/templates', id]);
    } catch (error) {
      this.error.set(errorCopy(error));
    } finally {
      this.cloning.set(null);
    }
  }
}
