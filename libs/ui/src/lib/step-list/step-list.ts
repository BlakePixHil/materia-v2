import { NgTemplateOutlet } from '@angular/common';
import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  ViewEncapsulation,
} from '@angular/core';

import { stepStates } from '../estate-stepper/estate-stepper';
import { MtIcon } from '../icon/icon';

/** A step in a StepList. */
export interface StepVm {
  id: string;
  title: string;
  description?: string | undefined;
}

/**
 * StepList (`mt-step-list`): numbered steps for setup flows (onboarding, imports, new matter
 * intake). Steps before the current one show a tick unless `completed` lists them explicitly. With
 * `interactive`, each completed step is a button that emits `stepSelect`, so people can go back to
 * it (the flow decides what happens); the current and upcoming steps stay plain text.
 */
@Component({
  selector: 'mt-step-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/steps.css',
  styles: `
    .mt-steps .mt-step-btn {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      column-gap: var(--space-12);
      margin: 0;
      padding: 0;
      border: 0;
      background: none;
      font: inherit;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }
    .mt-steps .mt-step-btn .mt-step-t {
      text-decoration: underline;
      text-decoration-color: var(--border-strong);
      text-underline-offset: 3px;
    }
    .mt-steps .mt-step-btn:hover .mt-step-t {
      color: var(--text-primary);
    }
    .mt-steps .mt-step-btn:focus-visible {
      outline: none;
    }
    .mt-steps .mt-step-btn:focus-visible .n {
      box-shadow: var(--focus-ring);
    }
  `,
  imports: [MtIcon, NgTemplateOutlet],
  host: { style: 'display: block' },
  template: `
    <ol class="mt-steps" [attr.aria-label]="label()">
      @for (step of steps(); track step.id; let i = $index) {
        <li
          [attr.data-state]="states()[i] === 'upcoming' ? null : states()[i]"
          [attr.aria-current]="states()[i] === 'current' ? 'step' : null"
        >
          @if (interactive() && states()[i] === 'done') {
            <button type="button" class="mt-step-btn" (click)="stepSelect.emit(step)">
              <ng-container [ngTemplateOutlet]="body" [ngTemplateOutletContext]="{ $implicit: step, i: i }" />
            </button>
          } @else {
            <ng-container [ngTemplateOutlet]="body" [ngTemplateOutletContext]="{ $implicit: step, i: i }" />
          }
        </li>
      }
    </ol>
    <ng-template #body let-step let-i="i">
      <span class="n" aria-hidden="true">
        @if (states()[i] === 'done') {
          <mt-icon name="check" />
        } @else {
          {{ i + 1 }}
        }
      </span>
      <span>
        <span class="mt-step-t">{{ step.title }}</span>
        @if (states()[i] === 'done') {
          <span class="mt-sr">, complete</span>
        }
        @if (step.description; as text) {
          <span class="sub">{{ text }}</span>
        }
      </span>
    </ng-template>
  `,
})
export class MtStepList {
  readonly steps = input.required<readonly StepVm[]>();
  readonly current = input<string | null>(null);
  readonly completed = input<readonly string[]>();
  readonly label = input('Steps');
  /** Completed steps become buttons that emit `stepSelect`. */
  readonly interactive = input(false, { transform: booleanAttribute });
  readonly stepSelect = output<StepVm>();
  protected readonly states = computed(() => stepStates(this.steps(), this.current(), this.completed()));
}
