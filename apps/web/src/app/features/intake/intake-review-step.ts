import { ChangeDetectionStrategy, Component, computed, effect, inject, output, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { OrgContext } from '@materia/data-access';
import { MEMBER_LIST_QUERY, membersRepository } from '@materia/data-access/repository';
import { PrioritySchema, type IntakeStepId, type Priority } from '@materia/domain';
import {
  formatAud,
  MATTER_TYPE_LABELS,
  MtButton,
  MtCheckbox,
  MtNote,
  MtSelect,
  MtTextField,
  type MtOption,
} from '@materia/ui';

import {
  costsDisclosureFor,
  derivedParties,
  FEE_ARRANGEMENT_OPTIONS,
  hasDeceased,
  parseDollars,
  suggestedTitle,
} from './intake-state';
import { IntakeStore } from './intake-store';
import { CONFLICT_STATUS_LABELS, roleName } from '../conflicts/conflict-view';

const PRIORITY_LABELS: Record<Priority, string> = {
  none: 'No priority',
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
const PRIORITY_OPTIONS: MtOption<Priority>[] = PrioritySchema.options.map((value) => ({
  value,
  label: PRIORITY_LABELS[value],
}));

interface SummaryRow {
  step: IntakeStepId;
  label: string;
  value: string;
}

/**
 * Step 7: a summary of every step (each with a Change button), then the title, the responsible
 * lawyer, the team, labels and priority. The page's Create button sends it.
 */
@Component({
  selector: 'mt-intake-review-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtCheckbox, MtNote, MtSelect, MtTextField],
  template: `
    @let r = store.state().review;
    <section class="mt-col block" aria-labelledby="intake-summary-h">
      <h2 id="intake-summary-h" class="heading">Summary</h2>
      <dl class="summary">
        @for (row of summary(); track row.label) {
          <div>
            <dt class="caption t-3">{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
            <dd class="change">
              <button
                mtButton
                variant="ghost"
                size="sm"
                type="button"
                [attr.aria-label]="'Change ' + row.label.toLowerCase()"
                (click)="jump.emit(row.step)"
              >
                Change
              </button>
            </dd>
          </div>
        }
      </dl>
      @if (lead()) {
        <mt-note tone="warning">{{ lead() }}</mt-note>
      }
    </section>
    <section class="mt-col block" aria-labelledby="intake-matter-h">
      <h2 id="intake-matter-h" class="heading">The matter</h2>
      <mt-text-field
        label="Title"
        autocomplete="off"
        [error]="store.error('title')"
        [ngModel]="r.title"
        (ngModelChange)="title($event ?? '')"
      />
      <div class="grid">
        <mt-select
          label="Responsible lawyer"
          [native]="true"
          [options]="responsibleOptions()"
          [error]="store.error('responsibleUid')"
          [ngModel]="r.responsibleUid || null"
          (ngModelChange)="store.review({ responsibleUid: $event ?? '' })"
        />
        <mt-select
          label="Priority"
          [native]="true"
          [options]="priorities"
          [ngModel]="r.priority"
          (ngModelChange)="store.review({ priority: $event ?? 'none' })"
        />
      </div>
      <fieldset class="team">
        <legend class="label">Team</legend>
        @for (member of team(); track member.id) {
          <mt-checkbox
            [label]="member.name"
            [ngModel]="r.teamUids.includes(member.id)"
            (ngModelChange)="toggleTeam(member.id, !!$event)"
          />
        } @empty {
          <p class="caption t-3">No one else in the practice yet.</p>
        }
      </fieldset>
      <mt-text-field
        label="Labels"
        description="Separate labels with commas."
        autocomplete="off"
        [optional]="true"
        [error]="store.error('labels')"
        [ngModel]="r.labels"
        (ngModelChange)="store.review({ labels: $event ?? '' })"
      />
    </section>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-24);
    }
    .block {
      gap: var(--space-12);
    }
    .block h2 {
      margin: 0;
    }
    .summary {
      margin: 0;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
    }
    .summary > div {
      display: grid;
      grid-template-columns: minmax(120px, 160px) minmax(0, 1fr) auto;
      gap: var(--space-12);
      align-items: center;
      padding: var(--space-8) var(--space-12);
      border-bottom: 1px solid var(--border-subtle);
    }
    .summary > div:last-child {
      border-bottom: 0;
    }
    .summary dd {
      margin: 0;
      min-width: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: var(--space-12);
    }
    .team {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      margin: 0;
      padding: 0;
      border: 0;
    }
    .team legend {
      margin-bottom: var(--space-8);
    }
  `,
})
export class IntakeReviewStep {
  protected readonly store = inject(IntakeStore);
  private readonly context = inject(OrgContext);
  readonly jump = output<IntakeStepId>();
  protected readonly priorities = PRIORITY_OPTIONS;

  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 });
  private readonly active = computed(() =>
    this.members
      .value()
      .filter((m) => m.status === 'active' && m.role !== 'readonly')
      .map((m) => ({ id: m.id, name: m.displayName, role: m.role })),
  );
  protected readonly responsibleOptions = computed<MtOption<string>[]>(() =>
    this.active().map((m) => ({ value: m.id, label: m.name })),
  );
  protected readonly team = computed(() => {
    const responsible = this.store.state().review.responsibleUid;
    return this.active().filter((m) => m.id !== responsible);
  });

  protected readonly summary = computed<SummaryRow[]>(() => {
    const s = this.store.state();
    const name = (id: string | null) => this.store.name(id);
    const rows: SummaryRow[] = [
      { step: 'type', label: 'Type', value: s.type ? MATTER_TYPE_LABELS[s.type] : '—' },
      { step: 'clients', label: 'Clients', value: s.clientContactIds.map(name).join(', ') || '—' },
    ];
    const d = s.details;
    if (s.type === 'will' || s.type === 'poa') {
      rows.push({
        step: 'details',
        label: s.type === 'will' ? 'Testator' : 'Principal',
        value: name(d.personContactId),
      });
    } else if (hasDeceased(s.type)) {
      const died = d.dateOfDeathUnknown ? 'date of death unknown' : `died ${d.dateOfDeath}`;
      rows.push({ step: 'details', label: 'Deceased', value: `${name(d.deceasedContactId)}, ${died}` });
      if (d.otherSideContactIds.length) {
        rows.push({ step: 'details', label: 'Other side', value: d.otherSideContactIds.map(name).join(', ') });
      }
    } else if (s.type === 'trust') {
      rows.push({ step: 'details', label: 'Trust', value: d.trustName });
    }
    const parties = [...derivedParties(s), ...s.parties].filter((p) => p.role !== 'client');
    rows.push({
      step: 'parties',
      label: 'Parties',
      value: parties.map((p) => `${name(p.contactId)} (${roleName(p.role).toLowerCase()})`).join(', ') || '—',
    });
    const fee = s.fees;
    const arrangement = FEE_ARRANGEMENT_OPTIONS.find((o) => o.value === fee.arrangement)?.label ?? fee.arrangement;
    const amount = parseDollars(fee.arrangement === 'fixed' ? fee.amount : fee.arrangement === 'capped' ? fee.cap : '');
    const disclosure = costsDisclosureFor(fee);
    const disclosureText = disclosure
      ? `costs disclosure ${disclosure.status === 'not_required' ? 'not required' : disclosure.status} (provisional)`
      : '';
    rows.push({
      step: 'fees',
      label: 'Fees',
      value: [arrangement + (amount ? ` ${formatAud(amount)}` : ''), disclosureText].filter(Boolean).join(', '),
    });
    rows.push({
      step: 'conflict',
      label: 'Conflict check',
      value: s.conflict.run ? CONFLICT_STATUS_LABELS[s.conflict.status] : 'Not run',
    });
    return rows;
  });

  protected readonly lead = computed(() => {
    const status = this.store.state().conflict.status;
    if (status === 'conflict')
      return 'The conflict check found a conflict: the matter is created as a lead and can’t open.';
    if (status === 'pending') return 'The conflict check isn’t determined yet: the matter is created as a lead.';
    return null;
  });

  constructor() {
    // The title follows the suggestion until it's typed; the responsible lawyer starts as you.
    effect(() => {
      const suggestion = suggestedTitle(this.store.state());
      const review = this.store.state().review;
      untracked(() => {
        if (!review.titleEdited && review.title !== suggestion) this.store.review({ title: suggestion });
      });
    });
    effect(() => {
      const options = this.responsibleOptions();
      const uid = this.context.uid();
      untracked(() => {
        if (!this.store.state().review.responsibleUid && uid && options.some((o) => o.value === uid)) {
          this.store.review({ responsibleUid: uid });
        }
      });
    });
  }

  protected title(title: string): void {
    this.store.review({ title, titleEdited: true });
  }

  protected toggleTeam(uid: string, on: boolean): void {
    const team = this.store.state().review.teamUids.filter((id) => id !== uid);
    this.store.review({ teamUids: on ? [...team, uid] : team });
  }
}
