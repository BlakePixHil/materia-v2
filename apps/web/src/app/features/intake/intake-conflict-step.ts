import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can } from '@materia/data-access';
import { hasAdverseHit, type ConflictStatus } from '@materia/domain';
import { MtButton, MtNote, MtRadioGroup, MtTextarea, type MtOption } from '@materia/ui';

import { conflictSubjects } from './intake-state';
import { IntakeStore } from './intake-store';
import { ConflictCheckPanel, sameSubjects, type ConflictRun } from '../conflicts/conflict-check-panel';

const DETERMINATIONS: MtOption<ConflictStatus>[] = [
  { value: 'pending', label: 'Decide later', description: 'The matter is created as a lead until a lawyer decides.' },
  { value: 'clear', label: 'Clear', description: 'No conflict. The matter opens.' },
  {
    value: 'potential',
    label: 'Potential conflict, waive it',
    description: 'A possible conflict you have managed (for example, with informed consent). Say why.',
  },
  { value: 'conflict', label: 'Conflict', description: 'The practice can’t act. The matter can only be a lead.' },
];

/**
 * Step 6: the conflict check (CORE-02's panel) runs by itself on everyone the earlier steps put on
 * the matter, and runs again when they change. A lawyer records the determination here, with the
 * new matter; other roles create a lead for a lawyer to decide. A conflict means a lead only, and
 * offers to discard the intake.
 */
@Component({
  selector: 'mt-intake-conflict-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ConflictCheckPanel, MtButton, MtNote, MtRadioGroup, MtTextarea],
  template: `
    @let c = store.state().conflict;
    <mt-conflict-check-panel
      [subjects]="subjects()"
      [autoRun]="true"
      [previous]="c.run"
      [determination]="false"
      (ran)="ran($event)"
    />
    <section class="card mt-col" aria-labelledby="intake-determination-h">
      <h2 id="intake-determination-h" class="heading">Determination</h2>
      @if (!c.run) {
        <p class="caption t-2" role="status">The check runs on the people above. Run it again after changing them.</p>
        @if (store.error('checkId'); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
      } @else if (canDetermine()) {
        @if (adverse() && c.status === 'clear') {
          <mt-note tone="warning">You’re recording Clear despite adverse matches. Be sure before you do.</mt-note>
        }
        <mt-radio-group
          label="Your determination"
          [options]="options"
          [ngModel]="c.status"
          (ngModelChange)="status($event)"
        />
        @if (c.status === 'potential' || c.status === 'conflict') {
          <mt-textarea
            label="Reason"
            [rows]="2"
            [error]="store.error('reason')"
            [ngModel]="c.reason"
            (ngModelChange)="reason($event ?? '')"
          />
        }
      } @else {
        <mt-note>A lawyer must determine this check. The matter is created as a lead until they do.</mt-note>
      }
      @if (c.status === 'conflict') {
        <mt-note tone="danger" data-testid="conflict-lead-warning">
          With a conflict, the matter can only be created as a lead: it can’t open. You can still create it to keep a
          record, or discard this intake.
        </mt-note>
        <div>
          <button mtButton variant="danger" size="sm" type="button" iconStart="trash" (click)="discard.emit()">
            Discard intake
          </button>
        </div>
      }
    </section>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
    }
    .card {
      gap: var(--space-12);
      padding: var(--space-16);
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card);
    }
    .card h2,
    .card p {
      margin: 0;
    }
  `,
})
export class IntakeConflictStep {
  protected readonly store = inject(IntakeStore);
  protected readonly canDetermine = can('conflict.determine');
  protected readonly options = DETERMINATIONS;
  readonly discard = output();

  /** The subjects, kept as the same array while they are the same people (a new array re-runs the check). */
  protected readonly subjects = computed(() => conflictSubjects(this.store.state()), { equal: sameSubjects });
  protected readonly adverse = computed(() => hasAdverseHit(this.store.state().conflict.run?.hits ?? []));

  protected ran(run: ConflictRun): void {
    // A new run needs a new determination.
    this.store.update((s) => ({ ...s, conflict: { run, status: 'pending', reason: '' } }));
  }

  protected status(status: ConflictStatus | null): void {
    if (status) this.store.update((s) => ({ ...s, conflict: { ...s.conflict, status } }));
  }

  protected reason(reason: string): void {
    this.store.update((s) => ({ ...s, conflict: { ...s.conflict, reason } }));
  }
}
