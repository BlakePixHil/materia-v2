import { ChangeDetectionStrategy, Component, computed, input, ViewEncapsulation } from '@angular/core';

import { stepStates } from '../estate-stepper/estate-stepper';
import { MtIcon } from '../icon/icon';

/** A step in a StepList. */
export interface StepVm {
  id: string;
  title: string;
  description?: string | undefined;
}

/**
 * StepList (`mt-step-list`): numbered steps for setup flows (onboarding, imports). Steps before the
 * current one show a tick unless `completed` lists them explicitly.
 */
@Component({
  selector: 'mt-step-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/steps.css',
  imports: [MtIcon],
  host: { style: 'display: block' },
  template: `
    <ol class="mt-steps" [attr.aria-label]="label()">
      @for (step of steps(); track step.id; let i = $index) {
        <li
          [attr.data-state]="states()[i] === 'upcoming' ? null : states()[i]"
          [attr.aria-current]="states()[i] === 'current' ? 'step' : null"
        >
          <span class="n" aria-hidden="true">
            @if (states()[i] === 'done') {
              <mt-icon name="check" />
            } @else {
              {{ i + 1 }}
            }
          </span>
          <span>
            {{ step.title }}
            @if (states()[i] === 'done') {
              <span class="mt-sr">, complete</span>
            }
            @if (step.description; as text) {
              <span class="sub">{{ text }}</span>
            }
          </span>
        </li>
      }
    </ol>
  `,
})
export class MtStepList {
  readonly steps = input.required<readonly StepVm[]>();
  readonly current = input<string | null>(null);
  readonly completed = input<readonly string[]>();
  readonly label = input('Steps');
  protected readonly states = computed(() => stepStates(this.steps(), this.current(), this.completed()));
}
