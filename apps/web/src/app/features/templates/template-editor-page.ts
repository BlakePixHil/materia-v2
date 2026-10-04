import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  Injector,
  runInInjectionContext,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import {
  matterTemplateVersionsRepository,
  orgTemplatesRepository,
  templateCallables,
} from '@materia/data-access/repository';
import {
  DomainError,
  keyFactsFor,
  PrioritySchema,
  systemTemplate,
  type EventKind,
  type KeyFactId,
  type Priority,
} from '@materia/domain';
import {
  DialogService,
  MATTER_TYPE_LABELS,
  MtBadge,
  MtButton,
  MtCheckbox,
  MtNote,
  MtSelect,
  MtTextarea,
  MtTextField,
  ToastService,
  type MtOption,
} from '@materia/ui';

import { StageMappingDialog, type StageMappingDialogData } from './stage-mapping-dialog';
import {
  draftContent,
  draftProblems,
  errorAt,
  EVENT_KINDS,
  fieldLabel,
  nextKey,
  serverFieldErrors,
  templateDraft,
  type FieldErrors,
  type StageDraft,
  type TaskDraft,
  type TemplateDraft,
} from './template-draft';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { eventKindLabel } from '../matter-detail/matter-view';

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No priority',
};

/**
 * A template's editor (`/settings/templates/:id`, CORE-07): its name, stages (name, criteria,
 * entry requirements, terminal; added, removed and reordered), tasks (stage, assignee, due date,
 * priority, checklist) and deadline rule ids. "Save draft" checks the draft here first
 * (`templateProblems` and the field rules) and then with `templates-save`, showing errors at their
 * fields. "Publish" saves, then publishes the next version; if matters are in stages it removes,
 * it asks where they go (TEMPLATE_STAGE_MAPPING_REQUIRED).
 */
@Component({
  selector: 'mt-template-editor-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/card.css'],
  imports: [FormsModule, RouterLink, MtBadge, MtButton, MtCheckbox, MtNote, MtSelect, MtTextarea, MtTextField],
  host: { class: 'mt-col mt-template-editor' },
  template: `
    <a class="caption" routerLink="/settings/templates">Matter templates</a>
    @if (template.status() === 'loading' && !draft()) {
      <p role="status" class="t-3">Loading the template…</p>
    } @else if (!draft()) {
      <h1 class="title-l">Template not found</h1>
      <p class="t-3">It may have been removed. Go back to the templates to choose another.</p>
    }
    @if (draft(); as d) {
      <header class="mt-col" style="gap: var(--space-6)">
        <h1 class="title-l">{{ d.name || 'Untitled template' }}</h1>
        <div class="mt-row mt-wrap" style="gap: var(--space-8); align-items: center">
          <span class="caption t-2">{{ typeLabel() }}</span>
          @if (template.value()?.published) {
            <mt-badge tone="success">Published v{{ version() }}</mt-badge>
          } @else {
            <mt-badge tone="warning">Not published yet</mt-badge>
          }
          @if (basedOn(); as text) {
            <span class="caption t-3">Based on {{ text }}</span>
          }
          @if (dirty()) {
            <span class="caption t-2" role="status">Unsaved changes</span>
          }
        </div>
      </header>

      @if (errorList().length) {
        <mt-note tone="danger" class="problems">
          <p style="margin: 0">Fix {{ errorList().length === 1 ? 'this problem' : 'these problems' }} first:</p>
          <ul>
            @for (item of errorList(); track item.path) {
              <li>{{ item.label }}: {{ item.message }}</li>
            }
          </ul>
        </mt-note>
      }
      @if (error(); as message) {
        <mt-note tone="danger" role="alert">{{ message }}</mt-note>
      }

      <section class="mt-card" data-pad aria-labelledby="mt-tpl-details">
        <h2 class="mt-card-title" id="mt-tpl-details">Details</h2>
        <mt-text-field
          label="Template name"
          [required]="true"
          [error]="err('name')"
          [ngModel]="d.name"
          (ngModelChange)="edit('name', (draft) => (draft.name = $event ?? ''))"
        />
      </section>

      <section class="mt-card mt-col" data-pad aria-labelledby="mt-tpl-stages" style="gap: var(--space-12)">
        <h2 class="mt-card-title" id="mt-tpl-stages">Stages</h2>
        <p class="caption t-3" style="margin: 0">
          Matters move through these in order. Requirements must be met to move forward into a stage.
        </p>
        @for (stage of d.stages; track $index; let i = $index, first = $first, last = $last) {
          <fieldset class="item">
            <legend>Stage {{ i + 1 }}</legend>
            <div class="mt-row mt-wrap fields">
              <mt-text-field
                class="mt-grow"
                label="Stage name"
                [required]="true"
                [error]="err('stages.' + i + '.name')"
                [ngModel]="stage.name"
                (ngModelChange)="editStage(i, 'name', (s) => (s.name = $event ?? ''))"
              />
              <mt-text-field
                label="Stage id"
                description="Lower case, digits and underscores"
                [required]="true"
                [error]="err('stages.' + i + '.id')"
                [ngModel]="stage.id"
                (ngModelChange)="editStage(i, 'id', (s) => (s.id = $event ?? ''))"
              />
            </div>
            <mt-text-field
              label="Completion criteria"
              [optional]="true"
              [error]="err('stages.' + i + '.criteria')"
              [ngModel]="stage.criteria"
              (ngModelChange)="editStage(i, 'criteria', (s) => (s.criteria = $event ?? ''))"
            />
            <mt-checkbox
              label="Terminal stage"
              description="The matter’s work is finished here"
              [ngModel]="stage.terminal"
              (ngModelChange)="editStage(i, 'terminal', (s) => (s.terminal = !!$event))"
            />
            <details [open]="!!err('stages.' + i + '.entryRequires')">
              <summary>Entry requirements ({{ requirementCount(stage) }})</summary>
              <div class="mt-col requires">
                @if (err('stages.' + i + '.entryRequires'); as message) {
                  <p class="mt-error" role="alert">{{ message }}</p>
                }
                <fieldset class="choices">
                  <legend>Key facts recorded</legend>
                  @for (fact of facts(); track fact.value) {
                    <mt-checkbox
                      [label]="fact.label"
                      [ngModel]="stage.facts.includes(fact.value)"
                      (ngModelChange)="toggle(i, 'facts', fact.value, $event)"
                    />
                  }
                </fieldset>
                <fieldset class="choices">
                  <legend>Events known</legend>
                  @for (kind of eventKinds; track kind) {
                    <mt-checkbox
                      [label]="eventLabel(kind)"
                      [ngModel]="stage.events.includes(kind)"
                      (ngModelChange)="toggle(i, 'events', kind, $event)"
                    />
                  }
                </fieldset>
                <fieldset class="choices">
                  <legend>Tasks done</legend>
                  @for (task of earlierTasks(i); track task.key) {
                    <mt-checkbox
                      [label]="task.title || task.key"
                      [ngModel]="stage.tasksDone.includes(task.key)"
                      (ngModelChange)="toggle(i, 'tasksDone', task.key, $event)"
                    />
                  } @empty {
                    <p class="caption t-3" style="margin: 0">No tasks in earlier stages.</p>
                  }
                </fieldset>
              </div>
            </details>
            <div class="mt-row actions">
              <button
                mtButton
                variant="ghost"
                size="sm"
                [attr.aria-label]="'Move stage ' + (i + 1) + ' up'"
                [disabled]="first"
                (click)="moveStage(i, -1)"
              >
                Move up
              </button>
              <button
                mtButton
                variant="ghost"
                size="sm"
                [attr.aria-label]="'Move stage ' + (i + 1) + ' down'"
                [disabled]="last"
                (click)="moveStage(i, 1)"
              >
                Move down
              </button>
              <button
                mtButton
                variant="ghost"
                size="sm"
                iconStart="trash"
                [attr.aria-label]="'Remove stage ' + (i + 1)"
                (click)="removeStage(i)"
              >
                Remove stage
              </button>
            </div>
          </fieldset>
        }
        <div><button mtButton size="sm" iconStart="plus" (click)="addStage()">Add stage</button></div>
      </section>

      <section class="mt-card mt-col" data-pad aria-labelledby="mt-tpl-tasks" style="gap: var(--space-12)">
        <h2 class="mt-card-title" id="mt-tpl-tasks">Tasks</h2>
        <p class="caption t-3" style="margin: 0">
          Created on a matter when it enters the task’s stage. Statutory deadlines aren’t tasks: they come from the
          deadline rules below.
        </p>
        @for (task of d.tasks; track $index; let i = $index) {
          <details
            class="item task"
            [attr.data-task]="task.key"
            [open]="openTasks().has(i) || hasErrors('tasks.' + i)"
            (toggle)="setOpen(i, $any($event.target).open)"
          >
            <summary>
              {{ task.title || 'Untitled task' }}
              <span class="caption t-3">· {{ stageName(task.stageId) }}</span>
            </summary>
            <div class="mt-col" style="gap: var(--space-12); padding-top: var(--space-12)">
              <div class="mt-row mt-wrap fields">
                <mt-text-field
                  class="mt-grow"
                  label="Task title"
                  [required]="true"
                  [error]="err('tasks.' + i + '.title')"
                  [ngModel]="task.title"
                  (ngModelChange)="editTask(i, 'title', (t) => (t.title = $event ?? ''))"
                />
                <mt-text-field
                  label="Task key"
                  [required]="true"
                  [error]="err('tasks.' + i + '.key')"
                  [ngModel]="task.key"
                  (ngModelChange)="editTask(i, 'key', (t) => (t.key = $event ?? ''))"
                />
              </div>
              <div class="mt-row mt-wrap fields">
                <mt-select
                  label="Stage"
                  [native]="true"
                  [options]="stageOptions()"
                  [error]="err('tasks.' + i + '.stageId')"
                  [ngModel]="task.stageId"
                  (ngModelChange)="editTask(i, 'stageId', (t) => (t.stageId = $event ?? ''))"
                />
                <mt-select
                  label="Assign to"
                  [native]="true"
                  [options]="assignOptions"
                  [ngModel]="task.assignTo"
                  (ngModelChange)="editTask(i, 'assignTo', (t) => (t.assignTo = $event ?? 'nobody'))"
                />
                <mt-select
                  label="Priority"
                  [native]="true"
                  [options]="priorityOptions"
                  [ngModel]="task.priority"
                  (ngModelChange)="editTask(i, 'priority', (t) => (t.priority = $event ?? 'medium'))"
                />
              </div>
              <div class="mt-row mt-wrap fields">
                <mt-select
                  label="Due"
                  [native]="true"
                  [options]="dueOptions"
                  [error]="err('tasks.' + i + '.due')"
                  [ngModel]="task.dueKind"
                  (ngModelChange)="editTask(i, 'due', (t) => (t.dueKind = $event ?? 'none'))"
                />
                @if (task.dueKind === 'event') {
                  <mt-select
                    label="After event"
                    [native]="true"
                    [options]="eventOptions"
                    [ngModel]="task.dueEvent"
                    (ngModelChange)="editTask(i, 'due', (t) => (t.dueEvent = $event ?? 'date_of_death'))"
                  />
                }
                @if (task.dueKind !== 'none') {
                  <mt-text-field
                    label="Offset days"
                    inputmode="numeric"
                    [description]="
                      task.dueKind === 'event' ? 'Negative for before the event' : 'Days after the stage starts'
                    "
                    [ngModel]="task.offsetDays"
                    (ngModelChange)="editTask(i, 'due', (t) => (t.offsetDays = $event ?? ''))"
                  />
                }
              </div>
              <mt-textarea
                label="Checklist"
                description="One item per line"
                [optional]="true"
                [rows]="2"
                [error]="err('tasks.' + i + '.checklist')"
                [ngModel]="task.checklist"
                (ngModelChange)="editTask(i, 'checklist', (t) => (t.checklist = $event ?? ''))"
              />
              <div>
                <button mtButton variant="ghost" size="sm" iconStart="trash" (click)="removeTask(i)">
                  Remove task
                </button>
              </div>
            </div>
          </details>
        } @empty {
          <p class="caption t-3" style="margin: 0">No tasks.</p>
        }
        <div><button mtButton size="sm" iconStart="plus" (click)="addTask()">Add task</button></div>
      </section>

      <section class="mt-card" data-pad aria-labelledby="mt-tpl-rules">
        <h2 class="mt-card-title" id="mt-tpl-rules">Deadline rules</h2>
        <mt-textarea
          label="Deadline rule ids"
          description="One per line. The deadline engine computes statutory deadlines from these rules."
          [optional]="true"
          [rows]="3"
          [error]="err('deadlineRuleIds')"
          [ngModel]="d.deadlineRuleIds"
          (ngModelChange)="edit('deadlineRuleIds', (draft) => (draft.deadlineRuleIds = $event ?? ''))"
        />
      </section>

      <div class="mt-row mt-wrap footer">
        <button mtButton variant="secondary" [loading]="saving()" [disabled]="publishing()" (click)="save()">
          Save draft
        </button>
        <button mtButton variant="primary" [loading]="publishing()" [disabled]="saving()" (click)="publish()">
          Publish v{{ version() + 1 }}
        </button>
      </div>
    }
  `,
  styles: `
    .mt-template-editor {
      gap: var(--space-16);
      max-width: 860px;
    }
    .mt-template-editor h1,
    .mt-template-editor h2,
    .mt-template-editor p {
      margin: 0;
    }
    .mt-template-editor .item {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: var(--space-12);
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
      min-width: 0;
    }
    .mt-template-editor .item legend {
      font: 600 13px/18px var(--font-sans);
      padding: 0 var(--space-4);
    }
    .mt-template-editor details.task {
      display: block;
    }
    .mt-template-editor summary {
      cursor: pointer;
      font: 500 13px/18px var(--font-sans);
    }
    .mt-template-editor .fields,
    .mt-template-editor .actions,
    .mt-template-editor .footer {
      gap: var(--space-8);
      align-items: flex-start;
    }
    .mt-template-editor .requires {
      gap: var(--space-12);
      padding-top: var(--space-8);
    }
    .mt-template-editor .choices {
      border: 0;
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-8) var(--space-16);
    }
    .mt-template-editor .choices legend {
      font: 500 12px/16px var(--font-sans);
      color: var(--text-secondary);
      padding: 0 0 var(--space-4);
    }
    .mt-template-editor .problems ul {
      margin: var(--space-4) 0 0;
      padding-left: var(--space-16);
    }
  `,
})
export class TemplateEditorPage {
  private readonly injector = inject(Injector);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly api = templateCallables(inject(CALLABLES));

  protected readonly id = toSignal(inject(ActivatedRoute).paramMap.pipe(map((p) => p.get('id') ?? '')), {
    initialValue: '',
  });
  protected readonly template = orgTemplatesRepository().watch(() => this.id() || null);
  /** What is being edited; loaded once from the template, then only changed here. */
  protected readonly draft = signal<TemplateDraft | null>(null);
  protected readonly dirty = signal(false);
  protected readonly errors = signal<FieldErrors>({});
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly publishing = signal(false);
  /** Task cards opened by the person (by index). */
  protected readonly openTasks = signal<ReadonlySet<number>>(new Set());

  protected readonly version = computed(() => this.template.value()?.version ?? 0);
  protected readonly typeLabel = computed(() => {
    const type = this.draft()?.matterType;
    return type ? MATTER_TYPE_LABELS[type] : '';
  });
  protected readonly basedOn = computed(() => {
    const basedOn = this.template.value()?.basedOn;
    if (!basedOn) return null;
    const system = systemTemplate(basedOn.templateId);
    return system ? `${system.name} (system) v${basedOn.version}` : `another template, v${basedOn.version}`;
  });
  protected readonly errorList = computed(() =>
    Object.entries(this.errors()).map(([path, message]) => ({ path, label: fieldLabel(path), message })),
  );
  protected readonly facts = computed<MtOption<KeyFactId>[]>(() => {
    const type = this.draft()?.matterType;
    return type ? keyFactsFor(type).map((fact) => ({ value: fact.id, label: fact.label })) : [];
  });
  protected readonly stageOptions = computed<MtOption<string>[]>(() =>
    (this.draft()?.stages ?? []).map((stage, i) => ({ value: stage.id, label: stage.name || `Stage ${i + 1}` })),
  );

  protected readonly eventKinds = EVENT_KINDS;
  protected readonly eventLabel = eventKindLabel;
  protected readonly eventOptions: MtOption<EventKind>[] = EVENT_KINDS.map((kind) => ({
    value: kind,
    label: eventKindLabel(kind),
  }));
  protected readonly priorityOptions: MtOption<Priority>[] = PrioritySchema.options.map((priority) => ({
    value: priority,
    label: PRIORITY_LABELS[priority],
  }));
  protected readonly assignOptions: MtOption<TaskDraft['assignTo']>[] = [
    { value: 'responsible', label: 'Responsible lawyer' },
    { value: 'role:paralegal', label: 'A paralegal' },
    { value: 'nobody', label: 'Nobody' },
  ];
  protected readonly dueOptions: MtOption<TaskDraft['dueKind']>[] = [
    { value: 'none', label: 'No due date' },
    { value: 'event', label: 'Days from an event' },
    { value: 'stage', label: 'Days from stage entry' },
  ];

  constructor() {
    let loadedFor: string | null = null;
    effect(() => {
      const value = this.template.value();
      if (!value || value.id === loadedFor) return;
      loadedFor = value.id;
      untracked(() => {
        this.draft.set(templateDraft(value));
        this.dirty.set(false);
        this.errors.set({});
        this.openTasks.set(new Set());
      });
    });
  }

  // ---------- reading the draft ----------

  protected err(path: string): string | undefined {
    return errorAt(this.errors(), path);
  }

  protected hasErrors(prefix: string): boolean {
    return Object.keys(this.errors()).some((key) => key.startsWith(`${prefix}.`));
  }

  protected requirementCount(stage: StageDraft): number {
    return stage.facts.length + stage.events.length + stage.tasksDone.length;
  }

  /** Tasks of the stages before stage `i` (a stage can require only those to be done). */
  protected earlierTasks(i: number): TaskDraft[] {
    const draft = this.draft();
    if (!draft) return [];
    const earlier = new Set(draft.stages.slice(0, i).map((stage) => stage.id));
    return draft.tasks.filter((task) => earlier.has(task.stageId));
  }

  protected stageName(stageId: string): string {
    return this.draft()?.stages.find((stage) => stage.id === stageId)?.name || 'No stage';
  }

  protected setOpen(i: number, open: boolean): void {
    if (this.openTasks().has(i) === open) return;
    this.openTasks.update((current) => {
      const next = new Set(current);
      if (open) next.add(i);
      else next.delete(i);
      return next;
    });
  }

  // ---------- editing ----------

  /** Applies a change to a copy of the draft and clears the field's error (`path`, or everything for `''`). */
  protected edit(path: string, change: (draft: TemplateDraft) => void): void {
    const current = this.draft();
    if (!current) return;
    const next = structuredClone(current);
    change(next);
    this.draft.set(next);
    this.dirty.set(true);
    this.error.set(null);
    this.errors.update((errors) =>
      path
        ? Object.fromEntries(Object.entries(errors).filter(([key]) => key !== path && !key.startsWith(`${path}.`)))
        : {},
    );
  }

  protected editStage(i: number, field: string, change: (stage: StageDraft) => void): void {
    this.edit(`stages.${i}.${field}`, (draft) => {
      const stage = draft.stages[i];
      if (!stage) return;
      const before = stage.id;
      change(stage);
      // Renaming a stage id carries its tasks along.
      if (stage.id !== before) for (const task of draft.tasks) if (task.stageId === before) task.stageId = stage.id;
    });
  }

  protected editTask(i: number, field: string, change: (task: TaskDraft) => void): void {
    this.edit(`tasks.${i}.${field}`, (draft) => {
      const task = draft.tasks[i];
      if (!task) return;
      const before = task.key;
      change(task);
      // Renaming a task key keeps the stages that require it.
      if (task.key !== before) {
        for (const stage of draft.stages)
          stage.tasksDone = stage.tasksDone.map((key) => (key === before ? task.key : key));
      }
    });
  }

  protected toggle<K extends 'facts' | 'events' | 'tasksDone'>(
    i: number,
    list: K,
    value: StageDraft[K][number],
    on: boolean,
  ): void {
    this.editStage(i, 'entryRequires', (stage) => {
      const items: string[] = stage[list];
      const next = on ? [...new Set([...items, value])] : items.filter((item) => item !== value);
      Object.assign(stage, { [list]: next });
    });
  }

  protected addStage(): void {
    this.edit('', (draft) => {
      const id = nextKey(
        'stage',
        draft.stages.map((stage) => stage.id),
      );
      draft.stages.push({ id, name: '', criteria: '', facts: [], events: [], tasksDone: [], terminal: false });
    });
  }

  protected removeStage(i: number): void {
    this.edit('', (draft) => void draft.stages.splice(i, 1));
  }

  protected moveStage(i: number, by: -1 | 1): void {
    this.edit('', (draft) => {
      const [stage] = draft.stages.splice(i, 1);
      if (stage) draft.stages.splice(i + by, 0, stage);
    });
  }

  protected addTask(): void {
    const index = this.draft()?.tasks.length ?? 0;
    this.edit('', (draft) => {
      draft.tasks.push({
        key: nextKey(
          'task',
          draft.tasks.map((task) => task.key),
        ),
        title: '',
        stageId: draft.stages[0]?.id ?? '',
        assignTo: 'responsible',
        dueKind: 'none',
        dueEvent: 'date_of_death',
        offsetDays: '',
        priority: 'medium',
        checklist: '',
      });
    });
    this.openTasks.set(new Set([index]));
  }

  protected removeTask(i: number): void {
    this.edit('', (draft) => {
      const [task] = draft.tasks.splice(i, 1);
      if (task) for (const stage of draft.stages) stage.tasksDone = stage.tasksDone.filter((key) => key !== task.key);
    });
    this.openTasks.set(new Set());
  }

  // ---------- saving and publishing ----------

  /** Checks the draft here, then saves it (`templates-save`); false when something needs fixing. */
  async save({ quiet = false } = {}): Promise<boolean> {
    const draft = this.draft();
    const templateId = this.id();
    if (!draft || !templateId || this.saving()) return false;
    this.error.set(null);
    const problems = draftProblems(draft);
    this.errors.set(problems);
    if (Object.keys(problems).length) return false;
    const content = draftContent(draft);
    this.saving.set(true);
    try {
      await this.api.save({
        templateId,
        name: content.name,
        stages: content.stages,
        tasks: content.tasks,
        deadlineRuleIds: content.deadlineRuleIds,
      });
      this.dirty.set(false);
      if (!quiet) this.toasts.show({ title: 'Draft saved', tone: 'success' });
      return true;
    } catch (error) {
      this.showError(error);
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  /** Saves unsaved changes, then publishes the next version; asks for a stage mapping when needed. */
  async publish(): Promise<void> {
    const templateId = this.id();
    if (!templateId || this.publishing()) return;
    if (this.dirty() && !(await this.save({ quiet: true }))) return;
    this.publishing.set(true);
    try {
      await this.publishVersion(templateId);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'TEMPLATE_STAGE_MAPPING_REQUIRED') {
        await this.askForMapping(templateId, error);
      } else {
        this.showError(error);
      }
    } finally {
      this.publishing.set(false);
    }
  }

  private async publishVersion(templateId: string, stageMapping?: Record<string, string>): Promise<void> {
    const { version } = await this.api.publish({ templateId, ...(stageMapping ? { stageMapping } : {}) });
    this.toasts.show({
      title: `Published v${version}`,
      description: 'New matters get this version. Existing matters can be upgraded from their screen.',
      tone: 'success',
    });
  }

  private async askForMapping(templateId: string, error: DomainError): Promise<void> {
    const ids = (key: string) => {
      const value = error.details?.[key];
      return Array.isArray(value) ? value.map(String) : [];
    };
    const names = await this.publishedStageNames(templateId);
    const draftNames = new Map((this.draft()?.stages ?? []).map((stage) => [stage.id, stage.name]));
    const data: StageMappingDialogData = {
      name: this.draft()?.name ?? 'template',
      removed: ids('stages').map((id) => ({ value: id, label: names.get(id) ?? id })),
      allowed: ids('allowed').map((id) => ({ value: id, label: draftNames.get(id) || id })),
      submit: async (mapping) => {
        try {
          await this.publishVersion(templateId, mapping);
          return undefined;
        } catch (refused) {
          const fields = serverFieldErrors(refused);
          if (!fields) return { '': errorCopy(refused) };
          return Object.fromEntries(
            Object.entries(fields).map(([path, message]) => [path.replace(/^stageMapping\./, ''), message]),
          );
        }
      },
    };
    await this.dialogs.open<StageMappingDialogData, Record<string, string> | undefined>(StageMappingDialog, { data })
      .result;
  }

  /** The names of the published version's stages (the removed stages are only there). */
  private async publishedStageNames(templateId: string): Promise<Map<string, string>> {
    const version = this.version();
    if (!version) return new Map();
    try {
      const versions = runInInjectionContext(this.injector, () => matterTemplateVersionsRepository(templateId));
      const found = await versions.get(String(version));
      return new Map((found?.stages ?? []).map((stage) => [stage.id, stage.name ?? stage.title ?? stage.id]));
    } catch {
      return new Map();
    }
  }

  private showError(error: unknown): void {
    const fields = serverFieldErrors(error);
    if (fields) this.errors.set(fields);
    else this.error.set(errorCopy(error));
  }
}
