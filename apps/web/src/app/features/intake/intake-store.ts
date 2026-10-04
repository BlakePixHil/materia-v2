import { computed, inject, Injectable, signal } from '@angular/core';

import { INTAKE_STEPS, type IntakeStepId } from '@materia/domain';
import { MT_TODAY } from '@materia/ui';

import {
  emptyIntakeState,
  validateStep,
  type IntakeContact,
  type IntakeDetailsState,
  type IntakeFeesState,
  type IntakeReviewState,
  type IntakeState,
} from './intake-state';

/**
 * The New matter form's state, shared by the page and its steps (provided by the page). Steps
 * read `state()` and change it through the helpers; a step's errors show once someone tried to
 * leave it (`showErrors`).
 */
@Injectable()
export class IntakeStore {
  readonly today = inject(MT_TODAY);
  readonly state = signal<IntakeState>(emptyIntakeState());
  readonly step = signal<IntakeStepId>('type');
  /** Steps whose errors are shown (someone pressed Next on them, or came back to them). */
  private readonly shown = signal<ReadonlySet<IntakeStepId>>(new Set());

  readonly stepIndex = computed(() => INTAKE_STEPS.indexOf(this.step()));
  /** Errors of every step, by field. */
  readonly errors = computed(() => {
    const state = this.state();
    const today = this.today();
    return Object.fromEntries(INTAKE_STEPS.map((step) => [step, validateStep(state, step, today)])) as Record<
      IntakeStepId,
      Record<string, string>
    >;
  });
  readonly valid = (step: IntakeStepId) => Object.keys(this.errors()[step]).length === 0;

  /** The error to show for a field of the current step (once errors are shown). */
  error(field: string, step: IntakeStepId = this.step()): string | undefined {
    return this.shown().has(step) ? this.errors()[step][field] : undefined;
  }

  showErrors(step: IntakeStepId = this.step()): void {
    this.shown.update((set) => new Set([...set, step]));
  }

  update(recipe: (state: IntakeState) => IntakeState): void {
    this.state.update(recipe);
  }

  details(patch: Partial<IntakeDetailsState>): void {
    this.state.update((s) => ({ ...s, details: { ...s.details, ...patch } }));
  }

  fees(patch: Partial<IntakeFeesState>): void {
    this.state.update((s) => ({ ...s, fees: { ...s.fees, ...patch } }));
  }

  review(patch: Partial<IntakeReviewState>): void {
    this.state.update((s) => ({ ...s, review: { ...s.review, ...patch } }));
  }

  /** Remembers a contact's name and details for later steps. */
  remember(id: string, contact: IntakeContact): void {
    this.state.update((s) => ({ ...s, contacts: { ...s.contacts, [id]: contact } }));
  }

  name(id: string | null | undefined): string {
    return (id && this.state().contacts[id]?.name) || 'Unknown contact';
  }

  reset(state: IntakeState = emptyIntakeState(), step: IntakeStepId = 'type'): void {
    this.state.set(state);
    this.step.set(step);
    this.shown.set(new Set());
  }
}
