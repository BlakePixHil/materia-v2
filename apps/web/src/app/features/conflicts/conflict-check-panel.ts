import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormArray, FormControl, FormGroup, ReactiveFormsModule, Validators, type ValidatorFn } from '@angular/forms';
import { startWith } from 'rxjs';

import { can, OrgContext } from '@materia/data-access';
import { CONFLICT_CALLABLES, MEMBER_LIST_QUERY, membersRepository } from '@materia/data-access/repository';
import {
  DomainError,
  hasAdverseHit,
  type ConflictHitMatter,
  type ConflictStatus,
  type ConflictSubject,
  type DetermineConflictInput,
  type DetermineConflictResult,
  type Matter,
  type PartyRole,
  type RunConflictCheckInput,
  type RunConflictCheckResult,
} from '@materia/domain';
import {
  formatDateOnly,
  MT_ORG_TIMEZONE,
  MtBadge,
  MtButton,
  MtIconButton,
  MtNote,
  MtRadioGroup,
  MtSelect,
  MtTextarea,
  MtTextField,
  type MtOption,
} from '@materia/ui';

import {
  CONFLICT_STATUS_LABELS,
  CONFLICT_STATUS_TONES,
  formatDob,
  groupHits,
  hitMatterBadge,
  matchReasons,
  parseDob,
  roleName,
  scorePercent,
  SUBJECT_ROLE_OPTIONS,
} from './conflict-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';

/** The matter's recorded determination (`matter.conflictCheck`). */
export type ConflictDetermination = Matter['conflictCheck'];

/** What a run returned, with the subjects it ran on (intake keeps both). */
export interface ConflictRun extends RunConflictCheckResult {
  subjects: ConflictSubject[];
}

type Decision = Exclude<ConflictStatus, 'pending'>;

const DECISION_OPTIONS: MtOption<Decision>[] = [
  { value: 'clear', label: 'Clear', description: 'No conflict. The matter can open.' },
  {
    value: 'potential',
    label: 'Potential conflict, waive it',
    description: 'A possible conflict you have managed (for example, with informed consent). Say why.',
  },
  { value: 'conflict', label: 'Conflict', description: 'The practice can’t act. The matter can’t open.' },
];

const MESSAGES = {
  date: 'Enter a date like 14/06/1968.',
  email: 'Enter an email like name@example.com.',
  abn: 'An ABN is 11 digits.',
  required: 'Enter a name.',
} as const;

const dobValidator: ValidatorFn = (control) => {
  const value = String(control.value ?? '').trim();
  return !value || parseDob(value) ? null : { date: true };
};

const abnValidator: ValidatorFn = (control) => {
  const digits = String(control.value ?? '').replace(/\s/g, '');
  return !digits || /^\d{11}$/.test(digits) ? null : { abn: true };
};

function subjectGroup(subject?: Partial<ConflictSubject>) {
  return new FormGroup({
    name: new FormControl(subject?.name ?? '', { nonNullable: true, validators: [Validators.required] }),
    role: new FormControl<PartyRole>(subject?.role ?? 'client', { nonNullable: true }),
    dob: new FormControl(formatDob(subject?.dob), { nonNullable: true, validators: [dobValidator] }),
    email: new FormControl(subject?.email ?? '', { nonNullable: true, validators: [Validators.email] }),
    abn: new FormControl(subject?.abn ?? '', { nonNullable: true, validators: [abnValidator] }),
    kind: new FormControl<'person' | 'organisation'>(subject?.kind ?? 'person', { nonNullable: true }),
    /** The contact it was picked from; dropped once the name is edited (it's someone else then). */
    contactId: new FormControl<string | null>(subject?.contactId ?? null),
    pickedName: new FormControl(subject?.name ?? '', { nonNullable: true }),
  });
}
type SubjectGroup = ReturnType<typeof subjectGroup>;

/** A form row as a `conflicts-run` subject. */
function toSubject(group: SubjectGroup): ConflictSubject {
  const value = group.getRawValue();
  const name = value.name.trim();
  const abn = value.abn.replace(/\s/g, '');
  const dob = parseDob(value.dob);
  const email = value.email.trim();
  const contactId = value.contactId && name === value.pickedName.trim() ? value.contactId : null;
  return {
    kind: abn ? 'organisation' : value.kind,
    name,
    role: value.role,
    ...(dob ? { dob } : {}),
    ...(email ? { email } : {}),
    ...(abn ? { abn } : {}),
    ...(contactId ? { contactId } : {}),
  };
}

/** Whether two subject lists are the same people in the same roles (a run on one stands for the other). */
export function sameSubjects(a: readonly ConflictSubject[], b: readonly ConflictSubject[]): boolean {
  const key = (list: readonly ConflictSubject[]) =>
    JSON.stringify(
      list.map((s) => [s.contactId ?? null, s.name, s.role, s.dob ?? null, s.email ?? null, s.abn ?? null]),
    );
  return key(a) === key(b);
}

/**
 * The conflict check (CORE-02), reusable by intake (CORE-05) and the matter's check page: the
 * people and organisations to check (prefilled, editable), `conflicts-run`, the matches under each
 * subject (score, why, and every matter they're on, with adverse roles flagged), and the lawyer's
 * determination through `conflicts-determine`. A run never decides anything: even "no matches" needs
 * a lawyer to record "Clear".
 */
@Component({
  selector: 'mt-conflict-check-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MtBadge,
    MtButton,
    MtIconButton,
    MtNote,
    MtRadioGroup,
    MtSelect,
    MtTextarea,
    MtTextField,
  ],
  host: { class: 'mt-conflict-panel' },
  template: `
    <section class="card" aria-labelledby="mt-conflict-subjects-h">
      <div class="card-h">
        <h2 id="mt-conflict-subjects-h" class="heading">People and organisations to check</h2>
        <span class="caption t-3 count">{{ subjectForms.length }}</span>
      </div>
      <form id="mt-conflict-run-form" class="subjects" (submit)="$event.preventDefault(); run()">
        @for (group of subjectForms.controls; track group; let i = $index) {
          <fieldset class="subject" [formGroup]="group">
            <legend class="mt-sr">{{ subjectLabel(i) }}</legend>
            <mt-text-field
              class="name"
              label="Name"
              formControlName="name"
              autocomplete="off"
              [required]="true"
              [errorMessages]="messages"
            />
            <mt-select class="role" label="Role" formControlName="role" [options]="roles" [native]="true" />
            <mt-text-field
              label="Date of birth"
              formControlName="dob"
              placeholder="DD/MM/YYYY"
              autocomplete="off"
              [optional]="true"
              [errorMessages]="messages"
            />
            <mt-text-field
              label="Email"
              type="email"
              formControlName="email"
              autocomplete="off"
              [optional]="true"
              [errorMessages]="messages"
            />
            <mt-text-field
              label="ABN"
              formControlName="abn"
              inputmode="numeric"
              autocomplete="off"
              [optional]="true"
              [errorMessages]="messages"
            />
            <button
              mtIconButton
              class="remove"
              icon="trash"
              size="sm"
              type="button"
              [label]="'Remove ' + subjectLabel(i)"
              [disabled]="subjectForms.length === 1 || running()"
              (click)="remove(i)"
            ></button>
          </fieldset>
        }
      </form>
      <div class="mt-row mt-wrap">
        <button mtButton variant="ghost" size="sm" iconStart="plus" type="button" (click)="add()">
          Add person or organisation
        </button>
        @if (canRun()) {
          <button
            mtButton
            class="mt-ml"
            variant="primary"
            size="sm"
            type="submit"
            form="mt-conflict-run-form"
            iconStart="search"
            [loading]="running()"
          >
            {{ result() ? 'Run again' : 'Run conflict check' }}
          </button>
        }
      </div>
      @if (!canRun()) {
        <mt-note>Your role can’t run conflict checks. Ask a paralegal or lawyer.</mt-note>
      }
      @if (runError(); as message) {
        <mt-note tone="danger">{{ message }}</mt-note>
      }
    </section>

    @if (result(); as current) {
      <section class="card results" aria-labelledby="mt-conflict-results-h" aria-live="polite">
        <div class="card-h">
          <h2 id="mt-conflict-results-h" class="heading">Results</h2>
          <span class="caption t-3">{{ hitSummary() }}</span>
        </div>
        <p class="caption t-2 intro">
          Scores show how closely each contact matches. Common names match often: check the reasons before deciding.
        </p>
        @if (adverse()) {
          <mt-note tone="danger"
            >Some matches are on the other side of a matter (marked Adverse). Look closely before deciding.</mt-note
          >
        }
        @for (group of groups(); track group.index) {
          <section class="subject-result" [attr.aria-label]="'Matches for ' + group.subject.name">
            <h3 class="label">
              {{ group.subject.name }} <span class="t-3">· {{ role(group.subject.role) }}</span>
            </h3>
            @for (hit of group.hits; track hit.contactId) {
              <article class="hit" [attr.data-adverse]="hasAdverse(hit.matters) ? '' : null">
                <div class="hit-h">
                  <span class="label">{{ hit.displayName }}</span>
                  @if (hit.self) {
                    <mt-badge tone="neutral">This contact</mt-badge>
                    <span class="caption t-2">Their other matters</span>
                  } @else {
                    <mt-badge [tone]="hit.score >= 0.9 ? 'danger' : 'warning'">{{ score(hit.score) }} match</mt-badge>
                    <span class="caption t-2">{{ reasons(hit.reasons) }}</span>
                  }
                </div>
                @if (hit.viaMergedContactId) {
                  <p class="caption t-3 merged">Matched a contact that has since been merged into this one.</p>
                }
                @if (hit.matters.length) {
                  <table class="hit-matters">
                    <caption class="mt-sr">
                      Matters
                      {{
                        hit.displayName
                      }}
                      is on
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Ref</th>
                        <th scope="col">Matter</th>
                        <th scope="col">Status</th>
                        <th scope="col">Role</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (matter of hit.matters; track matter.matterId + matter.role) {
                        <tr [attr.data-adverse]="matter.adverse ? '' : null">
                          <td class="mono-s">{{ matter.number }}</td>
                          <td>{{ matter.title }}</td>
                          <td>
                            @let badge = matterBadge(matter);
                            <mt-badge [tone]="badge.tone">{{ badge.text }}</mt-badge>
                          </td>
                          <td>
                            <span class="role-cell">
                              {{ role(matter.role) }}
                              @if (matter.adverse) {
                                <mt-badge tone="danger" [attr.title]="matter.adverse"
                                  >Adverse: {{ matter.adverse }}</mt-badge
                                >
                              }
                            </span>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <p class="caption t-3">Not a party on any matter.</p>
                }
              </article>
            } @empty {
              <p class="none caption t-2">No matches</p>
            }
          </section>
        }
      </section>
    }

    @if (determination()) {
      <section class="card determination" aria-labelledby="mt-conflict-determination-h">
        <div class="card-h">
          <h2 id="mt-conflict-determination-h" class="heading">Determination</h2>
          <mt-badge class="mt-ml" [tone]="statusTone()">{{ statusLabel() }}</mt-badge>
        </div>
        @if (recorded(); as check) {
          <dl class="recorded">
            <div>
              <dt class="caption t-3">Recorded by</dt>
              <dd>{{ memberName(check.checkedBy) }}</dd>
            </div>
            <div>
              <dt class="caption t-3">On</dt>
              <dd>{{ when(check.checkedAt) }}</dd>
            </div>
            @if (check.reason) {
              <div class="reason">
                <dt class="caption t-3">Reason</dt>
                <dd>{{ check.reason }}</dd>
              </div>
            }
          </dl>
        } @else {
          <p class="caption t-2">
            Not determined yet. The matter stays a lead until a lawyer records Clear or waives a potential conflict.
          </p>
        }
        @if (matterId()) {
          @if (canDetermine()) {
            @if (result()) {
              <form class="decide" [formGroup]="decision" (submit)="$event.preventDefault(); determine()">
                <mt-radio-group label="Your determination" formControlName="status" [options]="decisions" />
                @if (decision.controls.status.value === 'clear' && adverse()) {
                  <mt-note tone="warning"
                    >You’re recording Clear despite adverse matches. Be sure before you do.</mt-note
                  >
                }
                <mt-textarea
                  label="Reason"
                  formControlName="reason"
                  [optional]="decision.controls.status.value === 'clear'"
                  [required]="decision.controls.status.value !== 'clear'"
                  [error]="reasonError() ?? undefined"
                  [rows]="2"
                />
                @if (determineError(); as message) {
                  <mt-note tone="danger">{{ message }}</mt-note>
                }
                <div class="mt-row">
                  <button mtButton variant="primary" size="sm" type="submit" [loading]="determining()">
                    Record determination
                  </button>
                </div>
              </form>
            } @else {
              <p class="caption t-2">Run the check to record a determination.</p>
            }
          } @else {
            <mt-note>A lawyer must determine this check. You can run it and review the matches.</mt-note>
          }
        }
      </section>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      min-width: 0;
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
      padding: var(--space-16);
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card);
      min-width: 0;
    }
    .card-h {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      min-height: 24px;
    }
    .card-h h2 {
      margin: 0;
    }
    .subjects {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
    }
    .subject {
      display: grid;
      grid-template-columns:
        minmax(160px, 2fr) minmax(120px, 1fr) minmax(110px, 1fr) minmax(140px, 1.4fr) minmax(110px, 1fr)
        auto;
      align-items: start;
      gap: var(--space-8);
      margin: 0;
      padding: 0 0 var(--space-12);
      border: 0;
      border-bottom: 1px solid var(--border-subtle);
      min-width: 0;
    }
    .subject .remove {
      margin-top: 22px;
    }
    .intro {
      margin: 0;
    }
    .subject-result {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      padding-top: var(--space-12);
      border-top: 1px solid var(--border-subtle);
    }
    .subject-result h3 {
      margin: 0;
    }
    .none {
      margin: 0;
      padding: var(--space-8) var(--space-12);
      border-radius: var(--radius-md);
      background: var(--bg-canvas);
    }
    .hit {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      padding: var(--space-12);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
    }
    .hit[data-adverse] {
      border-color: var(--border-danger);
    }
    .hit-h {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-8);
    }
    .merged {
      margin: 0;
    }
    .hit-matters {
      width: 100%;
      border-collapse: collapse;
      font: 400 13px/18px var(--font-sans);
    }
    .hit-matters th {
      text-align: left;
      font: 500 12px/16px var(--font-sans);
      color: var(--text-tertiary);
      padding: var(--space-4) var(--space-8);
      border-bottom: 1px solid var(--border-subtle);
    }
    .hit-matters td {
      padding: var(--space-6) var(--space-8);
      border-bottom: 1px solid var(--border-subtle);
      vertical-align: middle;
    }
    .hit-matters tr:last-child td {
      border-bottom: 0;
    }
    .hit-matters tr[data-adverse] td {
      background: var(--bg-danger-subtle);
      color: var(--text-primary);
    }
    .role-cell {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-6);
    }
    .recorded {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, max-content));
      gap: var(--space-8) var(--space-24);
      margin: 0;
    }
    .recorded dd {
      margin: 0;
    }
    .recorded .reason {
      grid-column: 1 / -1;
    }
    .decide {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
      padding-top: var(--space-12);
      border-top: 1px solid var(--border-subtle);
    }
    @media (max-width: 900px) {
      .subject {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      }
      .subject .name {
        grid-column: 1 / -1;
      }
      .subject .remove {
        margin-top: 0;
      }
      .hit-matters thead {
        display: none;
      }
      .hit-matters tr {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--space-4) var(--space-8);
        padding: var(--space-6) 0;
        border-bottom: 1px solid var(--border-subtle);
      }
      .hit-matters td {
        border: 0;
        padding: 0;
      }
    }
  `,
})
export class ConflictCheckPanel {
  private readonly callables = inject(CALLABLES);
  private readonly timeZone = inject(MT_ORG_TIMEZONE);
  private readonly context = inject(OrgContext);

  /** The people and organisations to check, as the matter (or intake) knows them. Replaces the form when it changes. */
  readonly subjects = input<readonly ConflictSubject[]>([]);
  /** The matter being checked: its own parties aren't hits, and determinations are recorded on it. */
  readonly matterId = input<string>();
  /** The matter's recorded determination, if any. */
  readonly current = input<ConflictDetermination | null | undefined>(null);
  /** Runs the check as soon as subjects arrive (intake), unless `previous` already ran on them. */
  readonly autoRun = input(false);
  /** An earlier run to show again (intake keeps it while the person moves between steps). */
  readonly previous = input<ConflictRun | null>(null);
  /** Shows the determination card. Intake records its own determination, with the new matter. */
  readonly determination = input(true);

  /** A run finished (intake keeps the check id to record the determination once the matter exists). */
  readonly ran = output<ConflictRun>();
  readonly determined = output<DetermineConflictResult>();

  protected readonly canRun = can('conflict.run');
  protected readonly canDetermine = can('conflict.determine');
  protected readonly roles = SUBJECT_ROLE_OPTIONS;
  protected readonly decisions = DECISION_OPTIONS;
  protected readonly messages = MESSAGES;

  protected readonly subjectForms = new FormArray<SubjectGroup>([subjectGroup()]);
  protected readonly decision = new FormGroup({
    status: new FormControl<Decision>('clear', { nonNullable: true }),
    reason: new FormControl('', { nonNullable: true }),
  });
  private readonly decisionValue = toSignal(this.decision.valueChanges.pipe(startWith(this.decision.value)));
  private readonly reasonTouched = signal(false);

  private readonly runAction = this.callables.action<Omit<RunConflictCheckInput, 'requestId'>, RunConflictCheckResult>(
    CONFLICT_CALLABLES.run,
  );
  private readonly determineAction = this.callables.action<
    Omit<DetermineConflictInput, 'requestId'>,
    DetermineConflictResult
  >(CONFLICT_CALLABLES.determine);
  protected readonly running = this.runAction.pending;
  protected readonly determining = this.determineAction.pending;
  protected readonly runError = computed(() => (this.runAction.error() ? errorCopy(this.runAction.error()) : null));
  protected readonly determineError = computed(() => {
    const error = this.determineAction.error();
    if (!error) return null;
    if (error instanceof DomainError && error.code === 'INVALID_ARGUMENT' && error.details?.['fields']) {
      return 'Give a reason for a potential conflict or a conflict.';
    }
    return errorCopy(error);
  });

  protected readonly result = signal<ConflictRun | null>(null);
  /** A determination made here, shown until the matter's own copy catches up. */
  private readonly local = signal<ConflictDetermination | null>(null);

  protected readonly groups = computed(() => {
    const result = this.result();
    return result ? groupHits(result.subjects, result.hits) : [];
  });
  protected readonly adverse = computed(() => hasAdverseHit(this.result()?.hits ?? []));
  protected readonly hitSummary = computed(() => {
    const hits = this.result()?.hits.length ?? 0;
    return hits === 0 ? 'No matches' : hits === 1 ? '1 match' : `${hits} matches`;
  });

  protected readonly recorded = computed(() => {
    const check = this.local() ?? this.current();
    return check && check.status !== 'pending' ? check : null;
  });
  protected readonly statusLabel = computed(() => CONFLICT_STATUS_LABELS[this.recorded()?.status ?? 'pending']);
  protected readonly statusTone = computed(() => CONFLICT_STATUS_TONES[this.recorded()?.status ?? 'pending']);
  protected readonly reasonError = computed(() => {
    const value = this.decisionValue();
    if (!this.reasonTouched() || value?.status === 'clear' || value?.reason?.trim()) return null;
    return value?.status === 'conflict' ? 'Say why this is a conflict.' : 'Say why the potential conflict is waived.';
  });

  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 });
  private readonly memberNames = computed(
    () => new Map(this.members.value().map((member) => [member.id, member.displayName] as const)),
  );

  constructor() {
    effect(() => {
      const subjects = this.subjects();
      untracked(() => {
        if (!subjects.length) return;
        this.subjectForms.clear();
        subjects.forEach((subject) => this.subjectForms.push(subjectGroup(subject)));
        const previous = this.previous();
        if (previous && sameSubjects(previous.subjects, subjects)) this.result.set(previous);
        else if (this.autoRun()) void this.run();
      });
    });
    // A newer determination on the matter replaces the one made here.
    effect(() => {
      this.current();
      untracked(() => this.local.set(null));
    });
  }

  protected subjectLabel(index: number): string {
    const name = this.subjectForms.at(index)?.controls.name.value.trim();
    return name || `person ${index + 1}`;
  }

  protected role(role: string): string {
    return roleName(role);
  }

  protected score(score: number): string {
    return scorePercent(score);
  }

  protected reasons(reasons: readonly string[]): string {
    return matchReasons(reasons);
  }

  protected matterBadge = hitMatterBadge;

  protected hasAdverse(matters: readonly ConflictHitMatter[]): boolean {
    return matters.some((matter) => !!matter.adverse);
  }

  protected memberName(uid: string | undefined): string {
    if (!uid) return 'Unknown';
    return this.memberNames().get(uid) ?? 'Former member';
  }

  protected when(at: Date | undefined): string {
    return at ? formatDateOnly(at, this.timeZone) : '—';
  }

  protected add(): void {
    this.subjectForms.push(subjectGroup());
  }

  protected remove(index: number): void {
    if (this.subjectForms.length > 1) this.subjectForms.removeAt(index);
  }

  /** Runs `conflicts-run` on the subjects as typed. */
  async run(): Promise<void> {
    if (!this.canRun() || this.running()) return;
    this.subjectForms.markAllAsTouched();
    if (this.subjectForms.invalid) return;
    const subjects = this.subjectForms.controls.map(toSubject);
    const matterId = this.matterId();
    try {
      const response = await this.runAction.run({ subjects, ...(matterId ? { excludeMatterId: matterId } : {}) });
      const result: ConflictRun = { ...response, hits: response.hits ?? [], subjects };
      this.result.set(result);
      this.decision.reset({ status: 'clear', reason: '' });
      this.reasonTouched.set(false);
      this.ran.emit(result);
    } catch {
      // Shown from runError(); "Run again" reuses the request id.
    }
  }

  /** Records the lawyer's determination through `conflicts-determine`. */
  async determine(): Promise<void> {
    const result = this.result();
    const matterId = this.matterId();
    if (!result || !matterId || !this.canDetermine() || this.determining()) return;
    this.reasonTouched.set(true);
    const { status, reason } = this.decision.getRawValue();
    const trimmed = reason.trim();
    if (status !== 'clear' && !trimmed) return;
    try {
      const response = await this.determineAction.run({
        checkId: result.checkId,
        matterId,
        status,
        ...(trimmed ? { reason: trimmed } : {}),
      });
      this.local.set({
        status: response.status,
        checkedAt: new Date(),
        checkedBy: this.context.uid() ?? undefined,
        resultId: result.checkId,
        reason: trimmed || undefined,
      });
      this.determined.emit(response);
    } catch {
      // Shown from determineError().
    }
  }
}
