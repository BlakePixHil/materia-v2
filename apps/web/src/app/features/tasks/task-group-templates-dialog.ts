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
  TASK_GROUP_TEMPLATES_QUERY,
  taskGroupTemplatesRepository,
  type TaskGroupTemplateItem,
  type WithId,
} from '@materia/data-access/repository';
import {
  filterChecklistTemplates,
  parseTaskGroupOutline,
  TASK_GROUP_TEMPLATE_NAME_MAX,
  TASK_GROUP_TEMPLATE_TASKS_MAX,
  taskGroupOutline,
  taskGroupTemplateName,
  taskGroupTemplateTasks,
  type TaskGroupSourceTask,
  type TaskGroupTemplateTask,
} from '@materia/domain';
import {
  DialogService,
  injectDialogRef,
  MtButton,
  MtDialog,
  MtIconButton,
  MtNote,
  MtSearchField,
  MtTextarea,
  MtTextField,
  ToastService,
} from '@materia/ui';

import { errorCopy } from '../../core/error-copy';

export type GroupTemplate = WithId<TaskGroupTemplateItem>;

/** A named group on the matter, for "Save a group as a template". */
export interface TaskGroupSource {
  name: string;
  tasks: readonly TaskGroupSourceTask[];
}

export interface TaskGroupTemplatesDialogData {
  /** The matter's named groups, in list order. */
  groups: readonly TaskGroupSource[];
}

/** The template to add to the matter; the dialog is dismissed without one. */
export interface TaskGroupTemplatesDialogResult {
  template: GroupTemplate;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 tasks · 5 checklist items". */
export function groupTemplateSummary(tasks: readonly Pick<TaskGroupTemplateTask, 'checklist'>[]): string {
  const items = tasks.reduce((sum, task) => sum + task.checklist.length, 0);
  return items ? `${plural(tasks.length, 'task')} · ${plural(items, 'checklist item')}` : plural(tasks.length, 'task');
}

const OUTLINE_PLACEHOLDER = [
  'Order the death certificate !high in 3 days',
  '  - Two certified copies',
  '  - Send one to the bank',
  'Write to the bank',
].join('\n');

interface FormErrors {
  name?: string;
  tasks?: string;
}

/**
 * Task group templates (CORE-08f), from "Templates" on a matter's Tasks tab: the org's templates,
 * searchable by name, to add to the matter as a group of tasks (the page writes them, see
 * `TaskActions.addTaskGroup`). task.edit roles also create, edit and delete templates here
 * (client-direct writes; a delete is soft), and save one of the matter's groups as a new one.
 * A template is written as an outline: a task per line, its checklist items indented beneath it.
 */
@Component({
  selector: 'mt-task-group-templates-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [FormsModule, MtButton, MtDialog, MtIconButton, MtNote, MtSearchField, MtTextarea, MtTextField],
  host: { class: 'mt-task-group-templates' },
  template: `
    <mt-dialog [title]="heading()" [closeOnOutsideClick]="false">
      @if (view() === 'list') {
        <div class="mt-col" style="gap: var(--space-12)">
          <p class="caption t-2 intro">
            Adding a template puts its tasks, with their checklists, in a new group at the end of this matter’s tasks.
          </p>
          <div class="mt-row tools">
            <span class="search">
              <mt-search-field
                #search
                label="Search task group templates"
                placeholder="Search templates"
                [debounce]="0"
                (queryChange)="query.set($event)"
              />
            </span>
            @if (canManage()) {
              <button mtButton variant="secondary" size="sm" iconStart="plus" (click)="startNew()">New template</button>
            }
          </div>
          @if (loading()) {
            <p class="caption t-3" role="status">Loading templates…</p>
          } @else {
            <ul class="list" aria-label="Task group templates">
              @for (template of shown(); track template.id) {
                <li class="item">
                  <div class="info">
                    <span class="label name">{{ template.name }}</span>
                    <span class="caption t-3">{{ summary(template.tasks) }}</span>
                  </div>
                  <button
                    mtButton
                    variant="secondary"
                    size="sm"
                    [attr.aria-label]="'Add ' + template.name"
                    (click)="apply(template)"
                  >
                    Add
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
                    No task group templates yet. Create one for the sets of tasks you use on matter after matter.
                  } @else {
                    No task group templates yet.
                  }
                </li>
              }
            </ul>
          }
          @if (canManage() && data.groups.length) {
            <div class="mt-col save-groups">
              <span class="caption t-2">Save a group on this matter as a template</span>
              <div class="mt-row groups">
                @for (group of data.groups; track group.name) {
                  <button
                    mtButton
                    variant="ghost"
                    size="sm"
                    iconStart="copy"
                    [attr.aria-label]="'Save ' + group.name + ' as a template'"
                    (click)="saveGroup(group)"
                  >
                    {{ group.name }}
                  </button>
                }
              </div>
            </div>
          }
        </div>
      } @else {
        <form
          id="mt-task-group-template-form"
          class="mt-col"
          style="gap: var(--space-16)"
          (submit)="$event.preventDefault(); save()"
        >
          <mt-text-field
            name="name"
            label="Name"
            description="The group the tasks go into."
            placeholder="Probate kick-off"
            [required]="true"
            [error]="errors().name"
            [ngModel]="name()"
            (ngModelChange)="name.set($event ?? ''); clearError('name')"
          />
          <mt-textarea
            name="tasks"
            label="Tasks"
            description="One task per line. Indent a line with spaces to make it a checklist item of the task above. End a task with !high or “in 7 days” to set its priority or due date."
            [placeholder]="placeholder"
            [rows]="8"
            [required]="true"
            [error]="errors().tasks"
            [ngModel]="outline()"
            (ngModelChange)="outline.set($event ?? ''); clearError('tasks')"
          />
          @if (preview(); as text) {
            <p class="caption t-3 preview" aria-live="polite">Reads as {{ text }}.</p>
          }
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
          <button mtButton variant="primary" type="submit" form="mt-task-group-template-form">
            {{ editing() ? 'Save template' : 'Create template' }}
          </button>
        }
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .mt-task-group-templates .intro,
    .mt-task-group-templates .preview {
      margin: 0;
    }
    .mt-task-group-templates .tools {
      gap: var(--space-8);
      align-items: center;
    }
    .mt-task-group-templates .tools .search {
      display: flex;
      flex: 1 1 auto;
      min-width: 0;
    }
    .mt-task-group-templates .list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
    }
    .mt-task-group-templates .item {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      padding: var(--space-8) 0;
      border-bottom: 1px solid var(--border-subtle);
    }
    .mt-task-group-templates .item:last-child {
      border-bottom: none;
    }
    .mt-task-group-templates .info {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-width: 0;
    }
    .mt-task-group-templates .name {
      overflow-wrap: anywhere;
    }
    .mt-task-group-templates .empty {
      padding: var(--space-8) 0;
    }
    .mt-task-group-templates .save-groups {
      gap: var(--space-4);
      padding-top: var(--space-12);
      border-top: 1px solid var(--border-subtle);
    }
    .mt-task-group-templates .groups {
      flex-wrap: wrap;
      gap: var(--space-4);
      margin-left: calc(-1 * var(--space-8));
    }
  `,
})
export class TaskGroupTemplatesDialog {
  protected readonly ref = injectDialogRef<TaskGroupTemplatesDialogData, TaskGroupTemplatesDialogResult | undefined>();
  protected readonly data = this.ref.data;
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly repo = taskGroupTemplatesRepository();
  private readonly templates = this.repo.watchQuery(TASK_GROUP_TEMPLATES_QUERY);

  protected readonly canManage = can('task.edit');
  protected readonly placeholder = OUTLINE_PLACEHOLDER;

  protected readonly view = signal<'list' | 'form'>('list');
  protected readonly query = signal('');
  protected readonly loading = computed(() => this.templates.status() === 'loading' && !this.templates.value().length);
  protected readonly shown = computed(() => filterChecklistTemplates(this.templates.value(), this.query()));
  protected readonly error = signal<string | null>(null);

  protected readonly editing = signal<GroupTemplate | null>(null);
  protected readonly name = signal('');
  protected readonly outline = signal('');
  protected readonly errors = signal<FormErrors>({});
  private readonly parsed = computed(() => parseTaskGroupOutline(this.outline()));
  /** "2 tasks · 3 checklist items" while the outline has any. */
  protected readonly preview = computed(() => {
    const { tasks } = this.parsed();
    return tasks.length ? groupTemplateSummary(tasks) : '';
  });

  protected readonly heading = computed(() => {
    if (this.view() === 'list') return 'Task group templates';
    const editing = this.editing();
    return editing ? `Edit ${editing.name}` : 'New task group template';
  });

  protected readonly summary = groupTemplateSummary;

  protected apply(template: GroupTemplate): void {
    void this.ref.close({ template });
  }

  protected startNew(): void {
    this.openForm(null, '', []);
  }

  /** "Save a group as a template": the form, filled in from the group's tasks. */
  protected saveGroup(group: TaskGroupSource): void {
    this.openForm(null, taskGroupTemplateName(group.name), taskGroupTemplateTasks(group.tasks));
  }

  protected startEdit(template: GroupTemplate): void {
    this.openForm(template, template.name, template.tasks);
  }

  private openForm(editing: GroupTemplate | null, name: string, tasks: readonly TaskGroupTemplateTask[]): void {
    this.editing.set(editing);
    this.name.set(name);
    this.outline.set(taskGroupOutline(tasks));
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
  private validated(): { name: string; tasks: TaskGroupTemplateTask[] } | null {
    const errors: FormErrors = {};
    const name = this.name().trim();
    if (!name) errors.name = 'Enter a name.';
    else if (name.length > TASK_GROUP_TEMPLATE_NAME_MAX) {
      errors.name = `Keep the name to ${TASK_GROUP_TEMPLATE_NAME_MAX} characters or fewer.`;
    }
    const { tasks, problems } = this.parsed();
    if (!tasks.length) errors.tasks = 'Add at least one task.';
    else if (problems.length) errors.tasks = problems.join(' ');
    this.errors.set(errors);
    if (errors.name || errors.tasks) return null;
    return { name, tasks: tasks.slice(0, TASK_GROUP_TEMPLATE_TASKS_MAX) };
  }

  /**
   * Creates or updates the template without waiting for the server (the write queues offline and
   * the list shows it at once); a failure shows a toast. Back to the list afterwards.
   */
  protected save(): void {
    const fields = this.validated();
    if (!fields) return;
    const editing = this.editing();
    const work = editing ? this.repo.update(editing.id, fields) : this.repo.create(fields);
    work.catch((error: unknown) =>
      this.toasts.show({ title: 'The template didn’t save', description: errorCopy(error), tone: 'danger' }),
    );
    this.toasts.show({ title: editing ? `Saved “${fields.name}”` : `Created “${fields.name}”`, tone: 'success' });
    this.backToList();
  }

  protected async remove(template: GroupTemplate): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: `Delete “${template.name}”?`,
      body: 'It’s removed for everyone in the practice. Tasks it already added to matters stay as they are.',
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
