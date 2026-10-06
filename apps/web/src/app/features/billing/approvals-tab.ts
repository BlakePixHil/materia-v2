import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Injector,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { matterTimeRepository, type TimeEntryItem, type WithId } from '@materia/data-access/repository';
import { timeTotals, type SetTimeEntryStatusResult } from '@materia/domain';
import {
  DialogService,
  formatAud,
  MT_MENU,
  MtButton,
  MtEmptyState,
  MtIconButton,
  MtNote,
  MtSegmentedControl,
  MtTimeEntry,
  ToastService,
  type MtOption,
  type TimeEntryVm,
} from '@materia/ui';

import { BillingScreen } from './billing-screen';
import { byMatter, expectedUpdatedAt, mergeResults, reviewSummary } from './billing-view';
import {
  SendBackDialog,
  WriteDownDialog,
  type SendBackDialogData,
  type WriteDownDialogData,
  type WriteDownDialogResult,
} from './review-dialogs';
import { errorCopy } from '../../core/error-copy';
import { TimeEntryForm, type TimeEntryFormValue } from '../time/time-entry-form';
import { dayHeading } from '../time/time-view';

type Entry = WithId<TimeEntryItem>;

interface PersonGroup {
  uid: string;
  name: string;
  entries: Entry[];
  units: number;
  amountCents: number;
}

/**
 * Approvals (BILL-03, lawyers and above): drafts from the people I supervise waiting for approval,
 * grouped by person, oldest first (owners and admins can switch to everyone's). Approve one entry or
 * a person's whole list, edit the narrative or duration in place, write down or off, or send back
 * with a note. Every call carries the `updatedAt` I saw, so an entry its author edits meanwhile is
 * left alone and reported (optimistic concurrency).
 */
@Component({
  selector: 'mt-approvals-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    MT_MENU,
    MtButton,
    MtEmptyState,
    MtIconButton,
    MtNote,
    MtSegmentedControl,
    MtTimeEntry,
    TimeEntryForm,
  ],
  host: { class: 'mt-col mt-approvals-tab' },
  template: `
    @if (screen.isFirmApprover()) {
      <div class="mt-row">
        <mt-segmented-control
          label="Whose time"
          name="scope"
          [options]="scopes"
          [ngModel]="screen.approvalScope()"
          (ngModelChange)="screen.approvalScope.set($event ?? 'team')"
        />
      </div>
    }
    @switch (screen.drafts.status()) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading time to approve…</p>
      }
      @case ('error') {
        <mt-note tone="danger">{{ loadError() }}</mt-note>
      }
      @default {
        @for (group of groups(); track group.uid) {
          <section class="person" [attr.aria-labelledby]="'approve-' + group.uid" [attr.data-person]="group.uid">
            <div class="mt-row person-head">
              <h3 class="label-m" [id]="'approve-' + group.uid">{{ group.name }}</h3>
              <span class="caption t-3">
                {{ group.entries.length }} {{ group.entries.length === 1 ? 'draft' : 'drafts' }} ·
                {{ screen.unitsText(group.units) }} · {{ amount(group.amountCents) }}
              </span>
              <button
                mtButton
                class="mt-ml"
                size="sm"
                variant="secondary"
                iconStart="check-circle"
                [loading]="busy() === group.uid"
                (click)="approve(group.entries, group.uid)"
              >
                Approve all
              </button>
            </div>
            <ul class="rows" role="list">
              @for (entry of group.entries; track entry.id) {
                <li>
                  @if (editing() === entry.id) {
                    <mt-time-entry-form
                      layout="row"
                      submitLabel="Save"
                      formLabel="Edit time"
                      [initial]="entry"
                      [unitMinutes]="screen.unitMinutes()"
                      [saving]="busy() === entry.id"
                      (saved)="save(entry, $event)"
                      (cancelled)="editing.set(null)"
                    />
                  } @else {
                    <mt-time-entry [entry]="row(entry)" [attr.data-entry-id]="entry.id">
                      <button
                        mtIconButton
                        icon="check"
                        size="sm"
                        [label]="'Approve ' + (entry.narrative || 'this entry')"
                        [disabled]="!!busy()"
                        (click)="approve([entry], entry.id)"
                      ></button>
                      <button
                        mtIconButton
                        icon="more"
                        size="sm"
                        [label]="'More actions for ' + (entry.narrative || 'this entry')"
                        [mtMenuTrigger]="menu"
                      ></button>
                      <ng-template #menu>
                        <mt-menu aria-label="Review actions">
                          <button mtMenuItem icon="compose" (click)="editing.set(entry.id)">Edit</button>
                          <button mtMenuItem icon="minus" (click)="writeDown([entry])">Write down or off…</button>
                          <button mtMenuItem icon="send" (click)="sendBack([entry])">Send back…</button>
                          <a mtMenuItem icon="arrow-right" [routerLink]="['/matters', entry.matterId, 'time']">
                            Open matter time
                          </a>
                        </mt-menu>
                      </ng-template>
                    </mt-time-entry>
                  }
                </li>
              }
            </ul>
          </section>
        } @empty {
          <mt-empty-state
            icon="check-circle"
            title="Nothing to approve"
            [description]="emptyText()"
            [headingLevel]="3"
          />
        }
      }
    }
    <p class="mt-sr" role="status" aria-live="polite">{{ announcement() }}</p>
  `,
  styles: `
    .mt-approvals-tab {
      gap: var(--space-16);
    }
    .mt-approvals-tab h3 {
      margin: 0;
    }
    .mt-approvals-tab .person {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .mt-approvals-tab .person-head {
      align-items: center;
      gap: var(--space-8);
      flex-wrap: wrap;
      padding: 0 var(--space-4);
    }
    .mt-approvals-tab .rows {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .mt-approvals-tab .rows > li > .mt-time-entry-form {
      padding: var(--space-8) var(--space-12);
      border: 1px solid var(--border-focus);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }
  `,
})
export class ApprovalsTab {
  protected readonly screen = inject(BillingScreen);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly injector = inject(Injector);

  protected readonly editing = signal<string | null>(null);
  /** The entry or person being reviewed. */
  protected readonly busy = signal<string | null>(null);
  protected readonly announcement = signal('');
  protected readonly scopes: MtOption<'team' | 'everyone'>[] = [
    { value: 'team', label: 'My team' },
    { value: 'everyone', label: 'Everyone' },
  ];

  protected readonly loadError = computed(() => errorCopy(this.screen.drafts.error()));
  protected readonly groups = computed((): PersonGroup[] => {
    const byPerson = new Map<string, Entry[]>();
    for (const entry of this.screen.awaiting()) byPerson.set(entry.uid, [...(byPerson.get(entry.uid) ?? []), entry]);
    return [...byPerson]
      .map(([uid, entries]) => {
        const totals = timeTotals(entries);
        return {
          uid,
          name: this.screen.memberName(uid),
          entries,
          units: totals.units,
          amountCents: totals.amountCents,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  protected readonly emptyText = computed(() =>
    this.screen.supervisees().length || this.screen.isFirmApprover()
      ? 'Drafts from the people you supervise show here once they record time.'
      : 'Set yourself as someone’s supervisor in Settings → Team to approve their time here.',
  );

  protected amount(cents: number): string {
    return formatAud(cents);
  }

  protected row(entry: Entry): TimeEntryVm {
    const matter = this.screen.matter(entry.matterId ?? '');
    const day = dayHeading(entry.date, this.screen.today());
    return {
      id: entry.id,
      description: entry.narrative.trim() || 'No narrative',
      meta: [matter.number, matter.title, day].filter(Boolean).join(' · '),
      minutes: entry.minutes,
      units: entry.units,
      amountCents: entry.amountCents,
      source: 'manual',
      unit: this.screen.unitMinutes(),
      ...(entry.billable ? {} : { valueLabel: 'Non-billable' }),
    };
  }

  protected approve(entries: Entry[], key: string): Promise<void> {
    return this.review(
      key,
      'Approved',
      (matterId, group) =>
        this.screen.api.setStatus({
          matterId,
          entryIds: group.map((entry) => entry.id),
          status: 'final',
          expectedUpdatedAt: expectedUpdatedAt(group),
        }),
      entries,
    );
  }

  protected async writeDown(entries: Entry[]): Promise<void> {
    const change = await this.dialogs.open<WriteDownDialogData, WriteDownDialogResult | undefined>(WriteDownDialog, {
      data: { entries, unitMinutes: this.screen.unitMinutes() },
    }).result;
    if (!change) return;
    const writeOff = 'writeOff' in change;
    await this.review(
      entries[0]?.id ?? 'write-down',
      writeOff ? 'Wrote off' : 'Wrote down',
      (matterId, group) =>
        this.screen.api.writeDown({
          matterId,
          entryIds: group.map((entry) => entry.id),
          reason: change.reason,
          expectedUpdatedAt: expectedUpdatedAt(group),
          ...('writeOff' in change
            ? { writeOff: true as const }
            : 'percent' in change
              ? { percent: change.percent }
              : { newUnits: change.newUnits }),
        }),
      entries,
    );
  }

  protected async sendBack(entries: Entry[]): Promise<void> {
    const author = this.screen.memberName(entries[0]?.uid ?? '');
    const note = await this.dialogs.open<SendBackDialogData, string | undefined>(SendBackDialog, {
      data: { count: entries.length, author },
    }).result;
    if (!note) return;
    await this.review(
      entries[0]?.id ?? 'send-back',
      'Sent back',
      (matterId, group) =>
        this.screen.api.reject({
          matterId,
          entryIds: group.map((entry) => entry.id),
          note,
          expectedUpdatedAt: expectedUpdatedAt(group),
        }),
      entries,
    );
  }

  /** Edits a draft's date, duration, narrative or billable flag; `time-onWrite` reprices it. */
  protected async save(entry: Entry, value: TimeEntryFormValue): Promise<void> {
    const matterId = entry.matterId;
    if (!matterId) return;
    this.busy.set(entry.id);
    try {
      const repo = runInInjectionContext(this.injector, () => matterTimeRepository(() => matterId));
      await repo.update(entry.id, {
        date: value.date,
        minutes: value.minutes,
        narrative: value.narrative,
        billable: value.billable,
      });
      this.editing.set(null);
      this.announcement.set('Saved.');
    } catch (error) {
      this.toasts.show({ title: 'The change didn’t save', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.busy.set(null);
    }
  }

  /** Runs one review call per matter and reports what happened. */
  private async review(
    key: string,
    verb: string,
    call: (matterId: string, entries: Entry[]) => Promise<SetTimeEntryStatusResult>,
    entries: Entry[],
  ): Promise<void> {
    this.busy.set(key);
    try {
      const results = await Promise.all([...byMatter(entries)].map(([matterId, group]) => call(matterId, group)));
      const result = mergeResults(results);
      const text = reviewSummary(result, verb);
      this.announcement.set(text);
      if (result.conflicts.length || !result.updated.length)
        this.toasts.show({ title: 'Some time wasn’t changed', description: text, tone: 'neutral' });
    } catch (error) {
      this.toasts.show({ title: 'That didn’t work', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.busy.set(null);
    }
  }
}
