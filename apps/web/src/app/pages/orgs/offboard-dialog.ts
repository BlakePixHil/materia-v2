import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  can,
  OFFBOARDING_CALLABLES,
  type OffboardingPlan,
  type OffboardMemberInput,
  type OffboardMemberResult,
  type PersonalTasksChoice,
  type Role,
} from '@materia/domain';
import {
  injectDialogRef,
  MtButton,
  MtDialog,
  MtNote,
  MtRadioGroup,
  MtSelect,
  MtSkeleton,
  type MtOption,
} from '@materia/ui';

import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { MtNeedsConnection } from '../../core/pwa/needs-connection';

/** A person who could take on the leaver's work. */
export interface OffboardCandidate {
  uid: string;
  displayName: string;
  role: Role;
  status: string;
}

export interface OffboardDialogData {
  uid: string;
  displayName: string;
  /** Everyone in the practice; the dialog offers those who can take the work. */
  people: OffboardCandidate[];
}

type WorkKind = 'tasks' | 'deadlines' | 'matters';

const KINDS: { kind: WorkKind; one: string; many: string; label: string }[] = [
  { kind: 'tasks', one: 'open task', many: 'open tasks', label: 'Who takes their open tasks' },
  { kind: 'deadlines', one: 'upcoming deadline', many: 'upcoming deadlines', label: 'Who takes their deadlines' },
  {
    kind: 'matters',
    one: 'matter they’re responsible for',
    many: 'matters they’re responsible for',
    label: 'Who becomes responsible for their matters',
  },
];

const PERSONAL_OPTIONS: MtOption<PersonalTasksChoice>[] = [
  {
    value: 'export',
    label: 'Export them to me, then delete them',
    description: 'A spreadsheet (CSV) of their personal tasks, kept for 7 days, then the tasks are deleted.',
  },
  { value: 'delete', label: 'Delete them', description: 'Their personal tasks are private to them.' },
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const fieldsOf = (error: unknown): Record<string, string[]> =>
  (error as { details?: { fields?: Record<string, string[]> } } | null)?.details?.fields ?? {};

/**
 * Removing a member (SEC-05, extending FND-17's removal): a two-step wizard from the team page.
 * 1. Hand on their work: what `orgs-offboardingPlan` found (open tasks, upcoming deadlines, the
 *    matters they're responsible for), each to someone active and not read-only, who can see
 *    privileged matters when any of it is privileged.
 * 2. Their personal tasks (exported to you as a CSV, or deleted) and what else happens: a running
 *    timer is stopped and saved as draft time, their connections are disconnected, they lose access.
 * Then `orgs-offboardMember` (confirming it's you) does it all. Closes with its result.
 */
@Component({
  selector: 'mt-offboard-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtNeedsConnection, MtNote, MtRadioGroup, MtSelect, MtSkeleton],
  template: `
    <mt-dialog
      [title]="'Remove ' + data.displayName"
      [description]="step() === 1 ? 'Step 1 of 2: hand on their work.' : 'Step 2 of 2: their own things, then remove.'"
      [closeOnOutsideClick]="false"
    >
      <div class="mt-col" style="gap: 16px" data-offboard>
        @if (loadError(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        } @else if (plan(); as p) {
          @if (step() === 1) {
            @if (kinds().length) {
              @for (k of kinds(); track k.kind) {
                <mt-select
                  [name]="'reassign-' + k.kind"
                  [label]="k.label"
                  [description]="describe(p, k.kind)"
                  [native]="true"
                  placeholder="Choose a person"
                  [options]="options(p, k.kind)"
                  [error]="errors()['reassign.' + k.kind]?.[0]"
                  [ngModel]="reassign()[k.kind] ?? null"
                  (ngModelChange)="choose(k.kind, $event)"
                />
              }
            } @else {
              <p style="margin: 0">{{ data.displayName }} has no open tasks, deadlines or matters to hand on.</p>
            }
          } @else {
            @if (p.personalTasks) {
              <mt-radio-group
                name="personalTasks"
                [label]="'Their ' + plural(p.personalTasks, 'personal task', 'personal tasks')"
                [options]="personalOptions"
                [ngModel]="personalTasks()"
                (ngModelChange)="personalTasks.set($event ?? 'export')"
              />
            }
            <ul class="mt-col" style="margin: 0; padding-left: 20px; gap: 4px" data-offboard-summary>
              @for (line of summary(); track line) {
                <li>{{ line }}</li>
              }
            </ul>
          }
          @if (error(); as message) {
            <mt-note tone="danger">{{ message }}</mt-note>
          }
        } @else {
          <mt-skeleton variant="fields" label="Checking what they leave behind…" />
        }
      </div>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" type="button" (click)="ref.close()">Cancel</button>
        @if (plan()) {
          @if (step() === 1) {
            <button mtButton variant="primary" type="button" [disabled]="!stepOneDone()" (click)="next()">Next</button>
          } @else {
            <button mtButton variant="ghost" type="button" (click)="step.set(1)">Back</button>
            <button mtButton mtNeedsConnection variant="danger" type="button" [loading]="busy()" (click)="remove()">
              Remove {{ data.displayName }}
            </button>
          }
        }
      </ng-container>
    </mt-dialog>
  `,
})
export class OffboardDialog {
  protected readonly ref = injectDialogRef<OffboardDialogData, OffboardMemberResult>();
  protected readonly data = this.ref.data;
  private readonly callables = inject(CALLABLES);

  protected readonly personalOptions = PERSONAL_OPTIONS;
  protected readonly plural = plural;
  protected readonly plan = signal<OffboardingPlan | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly step = signal<1 | 2>(1);
  protected readonly reassign = signal<Partial<Record<WorkKind, string>>>({});
  protected readonly personalTasks = signal<PersonalTasksChoice>('export');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly errors = signal<Record<string, string[]>>({});

  /** The kinds of work they leave, in order. */
  protected readonly kinds = computed(() => {
    const p = this.plan();
    return p ? KINDS.filter((k) => p[k.kind] > 0) : [];
  });
  protected readonly stepOneDone = computed(() => this.kinds().every((k) => !!this.reassign()[k.kind]));

  protected readonly summary = computed(() => {
    const p = this.plan();
    if (!p) return [];
    const name = this.data.displayName;
    const takers = this.kinds().map((k) => {
      const to = this.data.people.find((person) => person.uid === this.reassign()[k.kind])?.displayName ?? '';
      return `${plural(p[k.kind], k.one, k.many)} go to ${to}.`;
    });
    return [
      ...takers,
      ...(p.timer ? [`Their running timer is stopped and saved as draft time.`] : []),
      ...(p.integrations
        ? [`${plural(p.integrations, 'connection', 'connections')} (Microsoft, Google) are disconnected.`]
        : []),
      `${name} loses access to the practice straight away. Their records and history stay.`,
    ];
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.plan.set(
        await this.callables.call<{ uid: string }, OffboardingPlan>(OFFBOARDING_CALLABLES.plan, { uid: this.data.uid }),
      );
    } catch (error) {
      this.loadError.set(errorCopy(error));
    }
  }

  /** Who can take a kind of work: active, not leaving, not read-only, and privileged-capable when needed. */
  protected options(plan: OffboardingPlan, kind: WorkKind): MtOption<string>[] {
    return this.data.people
      .filter((person) => person.uid !== this.data.uid && person.status === 'active' && person.role !== 'readonly')
      .filter((person) => !plan.privileged[kind] || can(person.role, 'privileged.view'))
      .map((person) => ({ value: person.uid, label: person.displayName }));
  }

  protected describe(plan: OffboardingPlan, kind: WorkKind): string {
    const k = KINDS.find((entry) => entry.kind === kind) as (typeof KINDS)[number];
    const count = plural(plan[kind], k.one, k.many);
    return plan.privileged[kind]
      ? `${count}, some privileged: only people who can see privileged matters are listed.`
      : `${count}.`;
  }

  protected choose(kind: WorkKind, uid: string | null): void {
    this.reassign.update((current) => ({ ...current, [kind]: uid ?? undefined }));
    this.errors.update((current) => ({ ...current, [`reassign.${kind}`]: [] }));
  }

  protected next(): void {
    if (this.stepOneDone()) this.step.set(2);
  }

  protected async remove(): Promise<void> {
    const plan = this.plan();
    if (!plan) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const reassign = Object.fromEntries(this.kinds().map((k) => [k.kind, this.reassign()[k.kind]]));
      const result = await this.callables.call<Omit<OffboardMemberInput, 'requestId'>, OffboardMemberResult>(
        OFFBOARDING_CALLABLES.offboard,
        { uid: this.data.uid, reassign, personalTasks: plan.personalTasks ? this.personalTasks() : 'delete' },
        { idempotent: true },
      );
      void this.ref.close(result);
    } catch (error) {
      const fields = fieldsOf(error);
      this.errors.set(fields);
      // A taker who can't take the work: back to step 1, where the message shows.
      if (Object.keys(fields).some((field) => field.startsWith('reassign.'))) this.step.set(1);
      this.error.set(errorCopy(error));
    } finally {
      this.busy.set(false);
    }
  }
}
