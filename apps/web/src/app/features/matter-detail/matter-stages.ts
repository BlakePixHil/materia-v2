import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { keyFactValue, stageIndex, type KeyFactId } from '@materia/domain';
import { MtButton, MtEstateStepper, MtIconButton, MtNote, ToastService, type StageVm } from '@materia/ui';

import { MatterScreen } from './matter-screen';
import { keyFactLabel, stageRequirementsOf } from './matter-view';
import { errorCopy } from '../../core/error-copy';

/** A refused move: the stage asked for and the key facts it needs. */
interface Blocked {
  stageId: string;
  title: string;
  facts: KeyFactId[];
}

/**
 * The matter's stages (CORE-06): the template's (or the type's default) stages as an EstateStepper,
 * the completion criteria in each stage's tooltip. Choosing another stage calls
 * `matters-changeStage`; when the move needs key facts (`MATTER_STAGE_REQUIREMENTS`), a note lists
 * them with a button that starts editing each one on the Overview.
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
        [interactive]="screen.editable() && !moving()"
        (stageSelect)="move($event)"
      />
    }
    @if (blocked(); as b) {
      <mt-note tone="warning" class="blocked">
        <div class="mt-row mt-wrap" style="gap: var(--space-8); align-items: center">
          @if (missing().length) {
            <span>To move to {{ b.title }}, record:</span>
            @for (fact of missing(); track fact) {
              <button mtButton variant="secondary" size="sm" iconStart="compose" (click)="record(fact)">
                {{ factLabel(fact) }}
              </button>
            }
          } @else {
            <span>Everything {{ b.title }} needs is recorded.</span>
            <button mtButton variant="primary" size="sm" [loading]="moving()" (click)="retry(b)">
              Move to {{ b.title }}
            </button>
          }
          <button
            mtIconButton
            class="mt-ml"
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

  protected readonly moving = signal(false);
  protected readonly blocked = signal<Blocked | null>(null);
  protected readonly factLabel = keyFactLabel;

  protected readonly stages = computed<StageVm[]>(() =>
    this.screen.stages().map((stage) => ({
      id: stage.id,
      title: stage.title,
      description: stage.criteria || undefined,
    })),
  );
  protected readonly current = computed(() => {
    const stages = this.screen.stages();
    return stages[stageIndex(stages, this.screen.value()?.stageId)]?.id ?? null;
  });
  /** The blocked move's facts that are still not recorded. */
  protected readonly missing = computed(() => {
    const matter = this.screen.value();
    const facts = this.blocked()?.facts ?? [];
    if (!matter) return facts;
    return facts.filter((id) => {
      const value = keyFactValue(matter, id);
      return value === undefined || value === '';
    });
  });

  protected move(stage: StageVm): void {
    if (stage.id !== this.current()) void this.changeStage(stage.id, stage.title);
  }

  protected retry(blocked: Blocked): void {
    void this.changeStage(blocked.stageId, blocked.title);
  }

  /** Starts editing a missing key fact on the Overview. */
  protected record(fact: KeyFactId): void {
    this.screen.editingFact.set(fact);
    void this.router.navigate(['overview'], { relativeTo: this.route });
  }

  private async changeStage(stageId: string, title: string): Promise<void> {
    const matter = this.screen.value();
    if (!matter || this.moving() || !this.screen.editable()) return;
    this.moving.set(true);
    try {
      await this.screen.api.changeStage({ matterId: matter.id, stageId });
      this.blocked.set(null);
      this.toasts.show({ title: `Moved to ${title}`, tone: 'success' });
    } catch (error) {
      const facts = stageRequirementsOf(error);
      if (facts) this.blocked.set({ stageId, title, facts });
      else this.toasts.show({ title: 'Couldn’t change the stage', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.moving.set(false);
    }
  }
}
