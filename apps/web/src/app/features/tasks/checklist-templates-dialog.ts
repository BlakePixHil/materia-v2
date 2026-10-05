import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can } from '@materia/data-access';
import {
  CHECKLIST_TEMPLATES_QUERY,
  checklistTemplatesRepository,
  type ChecklistTemplateItem,
  type WithId,
} from '@materia/data-access/repository';
import {
  CHECKLIST_TEMPLATE_DUE_MAX_DAYS,
  CHECKLIST_TEMPLATE_ITEM_MAX,
  CHECKLIST_TEMPLATE_ITEMS_MAX,
  CHECKLIST_TEMPLATE_NAME_MAX,
  checklistTemplateItemsFromTask,
  checklistTemplateLines,
  checklistTemplateNameFromTask,
  filterChecklistTemplates,
  type ChecklistItem,
  type Priority,
} from '@materia/domain';
import {
  DialogService,
  injectDialogRef,
  MtButton,
  MtDialog,
  MtIconButton,
  MtNote,
  MtSearchField,
  MtSelect,
  MtTextarea,
  MtTextField,
  ToastService,
  type MtOption,
} from '@materia/ui';

import { PRIORITY_NAMES, PRIORITY_ORDER } from './task-view';
import { errorCopy } from '../../core/error-copy';

export type ChecklistTemplate = WithId<ChecklistTemplateItem>;

export interface ChecklistTemplatesDialogData {
  /** The task the templates apply to: its title, and its checklist for "Save as a template". */
  title: string;
  checklist: readonly ChecklistItem[];
}

/** The template to apply to the task; the dialog is dismissed without one. */
export interface ChecklistTemplatesDialogResult {
  template: ChecklistTemplate;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 items · High priority · Due in 7 days". */
export function templateSummary(template: Pick<ChecklistTemplateItem, 'items' | 'priority' | 'dueInDays'>): string {
  const parts = [plural(template.items.length, 'item')];
  if (template.priority && template.priority !== 'none') parts.push(`${PRIORITY_NAMES[template.priority]} priority`);
  if (template.dueInDays === 0) parts.push('Due today');
  else if (typeof template.dueInDays === 'number') parts.push(`Due in ${plural(template.dueInDays, 'day')}`);
  return parts.join(' · ');
}

interface FormErrors {
  name?: string;
  items?: string;
  dueInDays?: string;
}

/**
 * A task's checklist templates (CORE-08d), from "Templates" in its details: the org's templates,
 * searchable by name, to apply to the task (the page writes it, see `TaskActions`). task.edit roles
 * also create, edit and delete templates here (client-direct writes; a delete is soft), and save the
 * task's checklist as a new one. Items are one per line.
 */
@Component({
  selector: 'mt-checklist-templates-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [FormsModule, MtButton, MtDialog, MtIconButton, MtNote, MtSearchField, MtSelect, MtTextarea, MtTextField],
  host: { class: 'mt-checklist-templates' },
  template: `
    <mt-dialog [title]="heading()" [closeOnOutsideClick]="false">
      @if (view() === 'list') {
        <div class="mt-col" style="gap: var(--space-12)">
          <p class="caption t-2 intro">
            Applying adds the items “{{ data.title }}” doesn’t have yet, and fills in its priority and due date if
            they’re empty.
          </p>
          <div class="mt-row tools">
            <span class="search">
              <mt-search-field
                #search
                label="Search checklist templates"
                placeholder="Search templates"
                [debounce]="0"
                (queryChange)="query.set($event)"
              />
            </span>
            @if (canManage()) {
              <button mtButton variant="secondary" size="sm" iconStart="plus" (click)="startNew()">New template</button>
            }
          </div>
          @if (canManage() && data.checklist.length) {
            <button mtButton variant="ghost" size="sm" iconStart="copy" class="save-task" (click)="saveFromTask()">
              Save this task’s checklist as a template
            </button>
          }
          @if (loading()) {
            <p class="caption t-3" role="status">Loading templates…</p>
          } @else {
            <ul class="list" aria-label="Checklist templates">
              @for (template of shown(); track template.id) {
                <li class="item">
                  <div class="info">
                    <span class="label name">{{ template.name }}</span>
                    <span class="caption t-3">{{ summary(template) }}</span>
                  </div>
                  <button
                    mtButton
                    variant="secondary"
                    size="sm"
                    [attr.aria-label]="'Apply ' + template.name"
                    (click)="apply(template)"
                  >
                    Apply
                  </button>
                  @if (canManage()) {
                    <button
                      mtIconButton
                      icon="compose"
                      size="sm"
                      [label]="'Edit ' + template.name"
                      (click)="startEdit(template)"
                    ></button>
                    <button
                      mtIconButton
                      icon="trash"
                      size="sm"
                      [label]="'Delete ' + template.name"
                      (click)="remove(template)"
                    ></button>
                  }
                </li>
              } @empty {
                <li class="caption t-3 empty">
                  @if (query().trim()) {
                    No templates match “{{ query().trim() }}”.
                  } @else if (canManage()) {
                    No checklist templates yet. Create one for the checklists you use again and again.
                  } @else {
                    No checklist templates yet.
                  }
                </li>
              }
            </ul>
          }
        </div>
      } @else {
        <form
          id="mt-checklist-template-form"
          class="mt-col"
          style="gap: var(--space-16)"
          (submit)="$event.preventDefault(); save()"
        >
          <mt-text-field
            name="name"
            label="Name"
            placeholder="Probate kick-off"
            [required]="true"
            [error]="errors().name"
            [ngModel]="name()"
            (ngModelChange)="name.set($event ?? ''); clearError('name')"
          />
          <mt-textarea
            name="items"
            label="Items"
            [description]="'One per line, up to ' + itemsMax + '.'"
            [rows]="6"
            [required]="true"
            [error]="errors().items"
            [ngModel]="itemsText()"
            (ngModelChange)="itemsText.set($event ?? ''); clearError('items')"
          />
          <div class="mt-row defaults">
            <mt-select
              name="priority"
              label="Priority"
              description="Used when the task has none."
              [native]="true"
              [options]="priorityOptions"
              [ngModel]="priority()"
              (ngModelChange)="priority.set($event ?? 'none')"
            />
            <mt-text-field
              name="dueInDays"
              label="Due in (days)"
              type="number"
              inputmode="numeric"
              description="From today, when the task has no due date."
              [optional]="true"
              [error]="errors().dueInDays"
              [ngModel]="dueInDays()"
              (ngModelChange)="dueInDays.set($event ?? ''); clearError('dueInDays')"
            />
          </div>
        </form>
      }
      @if (error(); as message) {
        <mt-note tone="danger">{{ message }}</mt-note>
      }
      <ng-container mtDialogFooter>
        @if (view() === 'list') {
          <button mtButton variant="ghost" (click)="ref.close()">Close</button>
        } @else {
          <button mtButton variant="ghost" (click)="backToList()">Cancel</button>
          <button mtButton variant="primary" type="submit" form="mt-checklist-template-form">
            {{ editing() ? 'Save template' : 'Create template' }}
          </button>
        }
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .mt-checklist-templates .intro {
      margin: 0;
    }
    .mt-checklist-templates .tools {
      gap: var(--space-8);
      align-items: center;
    }
    .mt-checklist-templates .tools .search {
      display: flex;
      flex: 1 1 auto;
      min-width: 0;
    }
    .mt-checklist-templates .save-task {
      align-self: flex-start;
      margin-left: calc(-1 * var(--space-8));
    }
    .mt-checklist-templates .list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
    }
    .mt-checklist-templates .item {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      padding: var(--space-8) 0;
      border-bottom: 1px solid var(--border-subtle);
    }
    .mt-checklist-templates .item:last-child {
      border-bottom: none;
    }
    .mt-checklist-templates .info {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-width: 0;
    }
    .mt-checklist-templates .name {
      overflow-wrap: anywhere;
    }
    .mt-checklist-templates .empty {
      padding: var(--space-8) 0;
      border-bottom: none;
    }
    .mt-checklist-templates .defaults {
      gap: var(--space-16);
      flex-wrap: wrap;
      align-items: flex-start;
    }
    .mt-checklist-templates .defaults > * {
      flex: 1 1 180px;
    }
  `,
})
export class ChecklistTemplatesDialog {
  protected readonly ref = injectDialogRef<ChecklistTemplatesDialogData, ChecklistTemplatesDialogResult | undefined>();
  protected readonly data = this.ref.data;
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly repo = checklistTemplatesRepository();
  private readonly templates = this.repo.watchQuery(CHECKLIST_TEMPLATES_QUERY);

  protected readonly canManage = can('task.edit');
  protected readonly itemsMax = CHECKLIST_TEMPLATE_ITEMS_MAX;
  protected readonly priorityOptions: MtOption<Priority>[] = [
    { value: 'none', label: 'No default' },
    ...PRIORITY_ORDER.filter((p) => p !== 'none').map((value) => ({ value, label: PRIORITY_NAMES[value] })),
  ];

  protected readonly view = signal<'list' | 'form'>('list');
  protected readonly query = signal('');
  protected readonly loading = computed(() => this.templates.status() === 'loading' && !this.templates.value().length);
  protected readonly shown = computed(() => filterChecklistTemplates(this.templates.value(), this.query()));
  protected readonly error = signal<string | null>(null);

  protected readonly editing = signal<ChecklistTemplate | null>(null);
  protected readonly name = signal('');
  protected readonly itemsText = signal('');
  protected readonly priority = signal<Priority>('none');
  protected readonly dueInDays = signal('');
  protected readonly errors = signal<FormErrors>({});

  protected readonly heading = computed(() => {
    if (this.view() === 'list') return 'Checklist templates';
    const editing = this.editing();
    return editing ? `Edit ${editing.name}` : 'New checklist template';
  });

  protected readonly summary = templateSummary;

  protected apply(template: ChecklistTemplate): void {
    void this.ref.close({ template });
  }

  protected startNew(): void {
    this.openForm(null, { name: '', items: [] });
  }

  /** "Save this task's checklist as a template": the form, filled in from the task. */
  protected saveFromTask(): void {
    this.openForm(null, {
      name: checklistTemplateNameFromTask(this.data.title),
      items: checklistTemplateItemsFromTask(this.data.checklist),
    });
  }

  protected startEdit(template: ChecklistTemplate): void {
    this.openForm(template, template);
  }

  private openForm(editing: ChecklistTemplate | null, from: Partial<ChecklistTemplateItem>): void {
    this.editing.set(editing);
    this.name.set(from.name ?? '');
    this.itemsText.set((from.items ?? []).join('\n'));
    this.priority.set(from.priority ?? 'none');
    this.dueInDays.set(typeof from.dueInDays === 'number' ? String(from.dueInDays) : '');
    this.errors.set({});
    this.error.set(null);
    this.view.set('form');
    this.focusLater('mt-text-field input');
  }

  protected backToList(): void {
    this.view.set('list');
    this.editing.set(null);
    this.error.set(null);
    this.focusLater('mt-search-field input');
  }

  private focusLater(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }

  protected clearError(field: keyof FormErrors): void {
    if (this.errors()[field]) this.errors.update((errors) => ({ ...errors, [field]: undefined }));
  }

  /** Checks the form; the template's fields, or null with the errors shown. */
  private validated(): { name: string; items: string[]; priority: Priority; dueInDays: number | null } | null {
    const errors: FormErrors = {};
    const name = this.name().trim();
    if (!name) errors.name = 'Enter a name.';
    else if (name.length > CHECKLIST_TEMPLATE_NAME_MAX) {
      errors.name = `Keep the name to ${CHECKLIST_TEMPLATE_NAME_MAX} characters or fewer.`;
    }
    const lines = this.itemsText().split(/\r?\n/);
    const items = checklistTemplateLines(this.itemsText());
    if (lines.some((line) => line.trim().length > CHECKLIST_TEMPLATE_ITEM_MAX)) {
      errors.items = `Keep each item to ${CHECKLIST_TEMPLATE_ITEM_MAX} characters or fewer.`;
    } else if (!items.length) errors.items = 'Add at least one item.';
    else if (items.length > CHECKLIST_TEMPLATE_ITEMS_MAX) {
      errors.items = `Up to ${CHECKLIST_TEMPLATE_ITEMS_MAX} items (this has ${items.length}).`;
    }
    const daysText = String(this.dueInDays()).trim();
    const days = daysText ? Number(daysText) : null;
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > CHECKLIST_TEMPLATE_DUE_MAX_DAYS)) {
      errors.dueInDays = `Enter a whole number of days from 0 to ${CHECKLIST_TEMPLATE_DUE_MAX_DAYS}.`;
    }
    this.errors.set(errors);
    if (errors.name || errors.items || errors.dueInDays) return null;
    return { name, items, priority: this.priority(), dueInDays: days };
  }

  /**
   * Creates or updates the template without waiting for the server (the write queues offline and
   * the list shows it at once); a failure shows a toast. Back to the list afterwards.
   */
  protected save(): void {
    const fields = this.validated();
    if (!fields) return;
    const editing = this.editing();
    const values: Record<string, unknown> = { name: fields.name, items: fields.items };
    if (fields.priority !== 'none') values['priority'] = fields.priority;
    if (fields.dueInDays !== null) values['dueInDays'] = fields.dueInDays;
    const work = editing
      ? this.repo.update(editing.id, values, {
          remove: [
            ...(fields.priority === 'none' && editing.priority !== undefined ? ['priority'] : []),
            ...(fields.dueInDays === null && editing.dueInDays !== undefined ? ['dueInDays'] : []),
          ],
        })
      : this.repo.create(values);
    work.catch((error: unknown) =>
      this.toasts.show({ title: 'The template didn’t save', description: errorCopy(error), tone: 'danger' }),
    );
    this.toasts.show({ title: editing ? `Saved “${fields.name}”` : `Created “${fields.name}”`, tone: 'success' });
    this.backToList();
  }

  protected async remove(template: ChecklistTemplate): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: `Delete “${template.name}”?`,
      body: 'It’s removed for everyone in the practice. Checklists it already added to tasks stay as they are.',
      confirmLabel: 'Delete template',
      tone: 'danger',
    });
    if (!ok) return;
    this.repo
      .softDelete(template.id)
      .catch((error: unknown) =>
        this.toasts.show({ title: 'The template didn’t delete', description: errorCopy(error), tone: 'danger' }),
      );
    this.toasts.show({ title: `Deleted “${template.name}”`, tone: 'success' });
  }
}
