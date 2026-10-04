import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  ViewEncapsulation,
} from '@angular/core';

import { MtTooltip } from '../tooltip/tooltip';

/** A stage from the matter template. */
export interface StageVm {
  id: string;
  title: string;
  /** What finishes the stage, shown in the stage's tooltip ("Grant received from the court"). */
  description?: string | undefined;
  /**
   * Why this stage can't be chosen (interactive steppers only): the stage stays focusable with
   * `aria-disabled`, its tooltip says why, and choosing it emits nothing.
   */
  locked?: string | undefined;
}

export type MtStepState = 'done' | 'current' | 'upcoming';

/**
 * Each stage's state: those listed in `completed` are done (by default, every stage before the current
 * one), the current stage is current, the rest upcoming.
 */
export function stepStates(
  stages: readonly StageVm[],
  currentId: string | null | undefined,
  completedIds?: readonly string[],
): MtStepState[] {
  const currentIndex = stages.findIndex((stage) => stage.id === currentId);
  const completed = completedIds ? new Set(completedIds) : null;
  return stages.map((stage, i) => {
    if (i === currentIndex) return 'current';
    if (completed) return completed.has(stage.id) ? 'done' : 'upcoming';
    return currentIndex >= 0 && i < currentIndex ? 'done' : 'upcoming';
  });
}

/**
 * EstateStepper (`mt-estate-stepper`): a matter's stages from its template, as a segmented track. The
 * current stage is marked `aria-current="step"`. With `interactive`, each stage is a button that emits
 * `stageSelect` (moving a matter's stage is the feature's job). A stage's `description` (its
 * completion criteria) is the button's tooltip; a `locked` stage says why it can't be chosen.
 */
@Component({
  selector: 'mt-estate-stepper',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/stepper.css',
  styles: `
    .mt-stepper-btn[aria-disabled='true'] {
      cursor: not-allowed;
    }
  `,
  imports: [MtTooltip],
  host: { style: 'display: block' },
  template: `
    <ol class="mt-stepper" [style.--n]="stages().length" [attr.aria-label]="label()">
      @for (stage of stages(); track stage.id; let i = $index) {
        <li
          [attr.data-state]="states()[i] === 'upcoming' ? null : states()[i]"
          [attr.aria-current]="states()[i] === 'current' ? 'step' : null"
        >
          @if (interactive()) {
            <button
              type="button"
              class="mt-stepper-btn"
              [attr.aria-disabled]="stage.locked ? 'true' : null"
              [mtTooltip]="tooltip(stage)"
              [mtTooltipDisabled]="!tooltip(stage)"
              (click)="choose(stage)"
            >
              {{ stage.title }}<span class="mt-sr">{{ stateText(states()[i]) }}</span>
            </button>
          } @else {
            <span
              >{{ stage.title }}<span class="mt-sr">{{ stateText(states()[i]) }}</span>
              @if (stage.description; as text) {
                <span class="mt-sr">. {{ text }}</span>
              }
            </span>
          }
        </li>
      }
    </ol>
  `,
})
export class MtEstateStepper {
  readonly stages = input.required<readonly StageVm[]>();
  readonly current = input<string | null>(null);
  /** Stage ids that are complete; defaults to every stage before the current one. */
  readonly completed = input<readonly string[]>();
  readonly interactive = input(false, { transform: booleanAttribute });
  readonly label = input('Matter stages');
  readonly stageSelect = output<StageVm>();

  protected readonly states = computed(() => stepStates(this.stages(), this.current(), this.completed()));

  protected tooltip(stage: StageVm): string {
    return [stage.description, stage.locked].filter(Boolean).join('. ');
  }

  protected choose(stage: StageVm): void {
    if (!stage.locked) this.stageSelect.emit(stage);
  }

  protected stateText(state: MtStepState | undefined): string {
    return state === 'done' ? ', complete' : state === 'current' ? ', current' : '';
  }
}
