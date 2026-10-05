import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { EVENT_KEY_FACTS, keyFactValue, stageIndex, type KeyFactId } from '@materia/domain';
import {
  DialogService,
  MtButton,
  MtEstateStepper,
  MtIconButton,
  MtNote,
  ToastService,
  type StageVm,
} from '@materia/ui';

import { MatterScreen } from './matter-screen';
import {
  eventKindLabel,
  keyFactLabel,
  matterErrorCopy,
  stageRequirementsOf,
  type StageRequirements,
} from './matter-view';
import { MatterNameDialog, type MatterNameDialogData } from '../matters/matter-name-dialog';

/** A refused move: the stage asked for and what it needs. */
interface Blocked extends StageRequirements {
  stageId: string;
  title: string;
}

/** Why a member who isn't a lawyer can't choose an earlier stage. */
export const STAGE_BACK_LOCKED = 'Only a lawyer can move a matter back a stage';

/**
 * The matter's stages (CORE-06): the template's (or the type's default) stages as an EstateStepper,
 * the completion criteria in each stage's tooltip. Choosing another stage calls
 * `matters-changeStage`; when the move needs something first (`MATTER_STAGE_REQUIREMENTS`), a note
 * lists it: key facts with a button that starts editing each one on the Overview, and (CORE-07)
 * matter events and template tasks by name. With templates on, moving back is for lawyers and asks
 * for a reason; earlier stages are locked, with a tooltip, for everyone else.
 */
@Component({
  selector: 'mt-matter-stages',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtEstateStepper, MtIconButton, MtNote],
  host: { class: 'mt-col', style: 'gap: var(--space-8)' },
  template: `
    @if (stages().length) {
      <mt-estate-stepper
        [stages]="stages()"
        [current]="current()"
        [interactive]="movable() && !moving()"
        (stageSelect)="move($event)"
      />
    }
    @if (blocked(); as b) {
      <mt-note tone="warning" class="blocked">
        <div class="mt-row" style="gap: var(--space-8); align-items: flex-start">
          <div class="mt-col mt-grow" style="gap: var(--space-6)">
            @if (missing().length) {
              <div class="mt-row mt-wrap" style="gap: var(--space-8); align-items: center">
                <span>To move to {{ b.title }}, record:</span>
                @for (fact of missing(); track fact) {
                  <button mtButton variant="secondary" size="sm" iconStart="compose" (click)="record(fact)">
                    {{ factLabel(fact) }}
                  </button>
                }
              </div>
            }
            @if (otherEvents().length) {
              <span class="requirement events"
                >{{ missing().length ? 'Also record' : 'To move to ' + b.title + ', record' }} these events:
                {{ eventLabels() }}.</span
              >
            }
            @if (b.tasks.length) {
              <span class="requirement tasks"
                >{{
                  missing().length || otherEvents().length ? 'And finish' : 'To move to ' + b.title + ', finish'
                }}
                these tasks: {{ taskTitles() }}.</span
              >
            }
            @if (!missing().length) {
              <div class="mt-row mt-wrap" style="gap: var(--space-8); align-items: center">
                @if (!otherEvents().length && !b.tasks.length) {
                  <span>Everything {{ b.title }} needs is recorded.</span>
                }
                <button mtButton variant="primary" size="sm" [loading]="moving()" (click)="retry(b)">
                  {{ otherEvents().length || b.tasks.length ? 'Try again' : 'Move to ' + b.title }}
                </button>
              </div>
            }
          </div>
          <button
            mtIconButton
            icon="x"
            size="sm"
            label="Dismiss"
            [tooltip]="false"
            (click)="blocked.set(null)"
          ></button>
        </div>
      </mt-note>
    }
  `,
})
export class MatterStages {
  protected readonly screen = inject(MatterScreen);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly dialogs = inject(DialogService);

  protected readonly moving = signal(false);
  /** Stages move while the matter is live and not closed or archived. */
  readonly movable = computed(() => {
    const status = this.screen.value()?.status;
    return this.screen.editable() && status !== 'closed' && status !== 'archived';
  });
  protected readonly blocked = signal<Blocked | null>(null);
  protected readonly factLabel = keyFactLabel;

  /** With templates on, moving back is for `matter.status` (lawyers and above) with a reason. */
  private readonly backNeedsLawyer = computed(() => this.screen.templatesOn() && !this.screen.canStatus());

  private readonly currentIndex = computed(() => stageIndex(this.screen.stages(), this.screen.value()?.stageId));
  readonly stages = computed<StageVm[]>(() =>
    this.screen.stages().map((stage, i) => ({
      id: stage.id,
      title: stage.title,
      description: stage.criteria || undefined,
      locked: this.backNeedsLawyer() && i < this.currentIndex() ? STAGE_BACK_LOCKED : undefined,
    })),
  );
  readonly current = computed(() => this.screen.stages()[this.currentIndex()]?.id ?? null);

  /** The blocked move's facts still not recorded, including events a key fact stands for (date of death, grant date). */
  protected readonly missing = computed(() => {
    const matter = this.screen.value();
    const blocked = this.blocked();
    if (!blocked) return [];
    const eventFacts = blocked.events.flatMap((kind) => EVENT_KEY_FACTS[kind] ?? []);
    const facts = [...new Set([...blocked.facts, ...eventFacts])];
    if (!matter) return facts;
    return facts.filter((id) => {
      const value = keyFactValue(matter, id);
      return value === undefined || value === '';
    });
  });
  /** Missing events no key fact stands for (they are recorded as matter events). */
  protected readonly otherEvents = computed(() =>
    (this.blocked()?.events ?? []).filter((kind) => !EVENT_KEY_FACTS[kind]),
  );
  protected readonly eventLabels = computed(() => this.otherEvents().map(eventKindLabel).join(', '));
  protected readonly taskTitles = computed(() =>
    (this.blocked()?.tasks ?? []).map((key) => this.screen.taskTitle(key)).join(', '),
  );

  /** Moves the matter to `stage` (the stepper, or ⌘K's "Change stage…", CORE-15). */
  move(stage: StageVm): void {
    if (stage.id === this.current() || stage.locked) return;
    const back = this.screen.stages().findIndex((s) => s.id === stage.id) < this.currentIndex();
    if (back && this.screen.templatesOn()) void this.moveBack(stage);
    else void this.changeStage(stage.id, stage.title);
  }

  /** Moving back (templates on): asks why first; the reason goes to the matter's activity. */
  private async moveBack(stage: StageVm): Promise<void> {
    const matter = this.screen.value();
    if (!matter || !this.movable()) return;
    const data: MatterNameDialogData = {
      title: `Move back to ${stage.title}`,
      label: 'Reason',
      confirm: 'Move back',
      description: 'Say why the matter is going back a stage. The reason is kept in the matter’s activity.',
      maxLength: 500,
    };
    const reason = await this.dialogs.open<MatterNameDialogData, string | undefined>(MatterNameDialog, { data }).result;
    if (reason) await this.changeStage(stage.id, stage.title, reason);
  }

  protected retry(blocked: Blocked): void {
    void this.changeStage(blocked.stageId, blocked.title);
  }

  /** Starts editing a missing key fact on the Overview. */
  protected record(fact: KeyFactId): void {
    this.screen.editingFact.set(fact);
    void this.router.navigate(['overview'], { relativeTo: this.route });
  }

  private async changeStage(stageId: string, title: string, reason?: string): Promise<void> {
    const matter = this.screen.value();
    if (!matter || this.moving() || !this.movable()) return;
    this.moving.set(true);
    try {
      await this.screen.api.changeStage({ matterId: matter.id, stageId, ...(reason ? { reason } : {}) });
      this.blocked.set(null);
      this.toasts.show({ title: `Moved to ${title}`, tone: 'success' });
    } catch (error) {
      const requirements = stageRequirementsOf(error);
      if (requirements) this.blocked.set({ stageId, title, ...requirements });
      else
        this.toasts.show({ title: 'Couldn’t change the stage', description: matterErrorCopy(error), tone: 'danger' });
    } finally {
      this.moving.set(false);
    }
  }
}
