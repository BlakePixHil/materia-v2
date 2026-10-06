import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { DOC_MERGE_FIELD_SECTIONS, type MergeField } from '@materia/domain';
import { MtIconButton, MtSettingsSection, ToastService } from '@materia/ui';

/**
 * The "Template fields" help panel (INT-06): every tag a template can use, generated from the
 * domain catalogue the server checks uploads against, with how formatters, lists, conditions and
 * the formatted body work. Each tag copies with one click.
 */
@Component({
  selector: 'mt-template-fields',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtIconButton, MtSettingsSection],
  template: `
    <mt-settings-section
      title="Template fields"
      description="Type these tags into your Word template, braces included. Materia fills them in from the matter."
      [headingLevel]="2"
    >
      <div class="how" data-testid="template-field-rules">
        <p>
          <code>{{ '{' }}client.fullName{{ '}' }}</code> prints a value. Add a formatter after a bar:
          <code>{{ '{' }}deceased.dateOfDeath|date{{ '}' }}</code> (3 October 2026),
          <code>{{ '{' }}fee.amount|money{{ '}' }}</code> ($4,400.00), <code>|upper</code> or <code>|lower</code>. Dates
          and amounts are formatted anyway.
        </p>
        <p>
          A list repeats what is between its tags:
          <code>{{ '{' }}#beneficiaries{{ '}' }}{{ '{' }}name{{ '}' }}{{ '{' }}/beneficiaries{{ '}' }}</code
          >. Put the tags on their own lines to repeat whole paragraphs or table rows.
        </p>
        <p>
          The same tags around any field show text only when it has a value:
          <code>{{ conditionExample }}</code
          >.
        </p>
        <p>
          <code>{{ '{' }}&#64;body{{ '}' }}</code
          >, on a paragraph of its own, takes formatted text typed when the document is generated: headings, bold,
          italics and lists.
        </p>
        <p>
          A field with no value prints <code>[[missing: client.address]]</code>, and Materia lists it, so nothing goes
          out with a gap.
        </p>
      </div>
      @for (section of sections; track section.id) {
        <details class="group" [attr.data-section]="section.id">
          <summary>
            <span class="label">{{ section.title }}</span>
            <span class="caption t-3">{{ section.description }}</span>
          </summary>
          <ul class="fields">
            @for (field of section.fields; track field.tag) {
              <li>
                <span class="tag">
                  <code>{{ shown(field) }}</code>
                  <button
                    mtIconButton
                    type="button"
                    icon="copy"
                    size="sm"
                    [label]="'Copy ' + shown(field)"
                    (click)="copy(shown(field))"
                  ></button>
                </span>
                <span class="what">
                  {{ field.label }}
                  @if (field.example) {
                    <span class="caption t-3">e.g. {{ field.example }}</span>
                  }
                  @if (field.optional) {
                    <span class="caption t-3">Blank when there’s none.</span>
                  }
                </span>
                @if (field.items; as items) {
                  <span class="items caption t-3">
                    Inside the list:
                    @for (item of items; track item.tag; let last = $last) {
                      <code>{{ '{' }}{{ item.tag }}{{ '}' }}</code
                      >{{ last ? '' : ' ' }}
                    }
                  </span>
                }
              </li>
            }
          </ul>
        </details>
      }
    </mt-settings-section>
  `,
  styles: `
    .how p {
      margin: 0 0 var(--space-8, 8px);
      color: var(--text-secondary);
    }
    code {
      font-family: var(--font-mono, ui-monospace, monospace);
      font-size: 0.9em;
      background: var(--surface-sunken, var(--surface-2));
      border-radius: 4px;
      padding: 0 4px;
      overflow-wrap: anywhere;
    }
    .group {
      border-top: 1px solid var(--border-subtle);
      padding: var(--space-8, 8px) 0;
    }
    summary {
      cursor: pointer;
      display: flex;
      flex-wrap: wrap;
      gap: 4px var(--space-8, 8px);
      align-items: baseline;
    }
    .fields {
      list-style: none;
      margin: var(--space-8, 8px) 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-4, 4px);
    }
    .fields li {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 2px var(--space-12, 12px);
      align-items: center;
    }
    .tag {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }
    .what {
      display: flex;
      flex-wrap: wrap;
      gap: 0 var(--space-8, 8px);
    }
    .items {
      grid-column: 1 / -1;
    }
    @media (max-width: 599px) {
      .fields li {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class TemplateFields {
  private readonly toasts = inject(ToastService);
  protected readonly sections = DOC_MERGE_FIELD_SECTIONS;
  protected readonly conditionExample = '{#client.email}Email: {client.email}{/client.email}';

  /** The tag as it is typed: `{client.fullName}`, `{#executors}…{/executors}`, `{@body}`. */
  protected shown(field: MergeField): string {
    if (field.type === 'list') return `{#${field.tag}}{name}{/${field.tag}}`;
    if (field.type === 'block') return `{@${field.tag}}`;
    return `{${field.tag}}`;
  }

  protected async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toasts.show({ title: `Copied ${text}`, tone: 'success' });
    } catch {
      this.toasts.show({ title: 'Couldn’t copy. Select the tag and copy it instead.', tone: 'danger' });
    }
  }
}
