import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  Injector,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can } from '@materia/data-access';
import {
  forMatter,
  MATTER_TIME_QUERY,
  matterTimeRepository,
  timeCallables,
  type TimeEntryItem,
  type WithId,
} from '@materia/data-access/repository';
import {
  dayMinutes,
  defaultBillable,
  formatUnits,
  isFixedFee,
  timeByDay,
  timeTotals,
  type DateOnly,
  type TimeEntryValues,
} from '@materia/domain';
import {
  DialogService,
  formatAud,
  MT_MENU,
  MT_TODAY,
  MtEmptyState,
  MtIconButton,
  MtNote,
  MtSelect,
  MtTimeEntry,
  ToastService,
  type MtOption,
} from '@materia/ui';

import { TimeEntryForm, type TimeEntryFormValue } from './time-entry-form';
import { dayTime, timePricing } from './time-pricing';
import { dayHeading, timeEntryRow } from './time-view';
import { onIntent } from '../../core/commands/intents';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { ShortcutService } from '../../core/shortcuts/shortcut.service';
import { writeDownTime } from '../billing/write-down';
import { MatterDisbursements } from '../disbursements/matter-disbursements';
import { MatterBills } from '../invoices/matter-bills';
import { MatterScreen } from '../matter-detail/matter-screen';

type Entry = WithId<TimeEntryItem>;
const EVERYONE = '';

/**
 * A matter's Time tab (BILL-01): its entries grouped by day with day and matter totals (units and
 * billable value), an add row at the top (`t` focuses it; date defaults to today), drafts edited in
 * place or deleted from their row's menu, and Mark final / Back to draft for approvers
 * (`time-setStatus`). Filter by person. Listens to this matter's entries only while it's shown.
 * The matter's disbursements (BILL-04) follow, behind `billing.disbursements`, then its bills
 * (BILL-07), behind `billing.invoicing`.
 */
@Component({
  selector: 'mt-matter-time',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [
    FormsModule,
    MT_MENU,
    MatterBills,
    MatterDisbursements,
    MtEmptyState,
    MtIconButton,
    MtNote,
    MtSelect,
    MtTimeEntry,
    TimeEntryForm,
  ],
  host: { class: 'mt-matter-time' },
  template: `
    <div class="mt-row head">
      <h2 class="title-m">Time</h2>
      @if (entries.status() !== 'loading') {
        <span class="caption t-3 totals" data-testid="time-totals">{{ totalsText() }}</span>
      }
      @if (memberOptions().length > 2) {
        <span class="mt-ml person">
          <mt-select
            name="person"
            label="Person"
            [native]="true"
            [options]="memberOptions()"
            [ngModel]="person()"
            (ngModelChange)="person.set($event ?? EVERYONE)"
          />
        </span>
      }
    </div>
    @if (canRecord()) {
      <mt-time-entry-form
        #addForm
        class="add"
        layout="row"
        formLabel="Record time"
        [initial]="newInitial()"
        [preview]="preview"
        [dayMinutes]="myDayMinutes"
        [unitMinutes]="pricing.unitMinutes()"
        [fixedFee]="fixedFee()"
        (saved)="create($event)"
        (cancelled)="addForm.reset()"
      />
    }
    <p class="mt-sr" role="status" aria-live="polite">{{ announcement() }}</p>
    @switch (entries.status()) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading time…</p>
      }
      @case ('error') {
        <mt-note tone="danger">{{ loadError() }}</mt-note>
      }
      @default {
        @for (day of days(); track day.date) {
          <section class="day" [attr.aria-labelledby]="'time-day-' + day.date">
            <h3 class="mt-row day-head" [id]="'time-day-' + day.date">
              <span class="label">{{ heading(day.date) }}</span>
              <span class="mt-ml caption t-3">{{ unitsText(day.units) }} · {{ amount(day.amountCents) }}</span>
            </h3>
            <ul class="rows" role="list">
              @for (entry of day.entries; track entry.id) {
                <li>
                  @if (editing() === entry.id) {
                    <mt-time-entry-form
                      layout="row"
                      submitLabel="Save"
                      formLabel="Edit time"
                      [initial]="entry"
                      [preview]="entry.uid === screen.me() ? preview : noPreview"
                      [dayMinutes]="dayMinutesFor(entry)"
                      [unitMinutes]="pricing.unitMinutes()"
                      [fixedFee]="fixedFee()"
                      [saving]="busy()"
                      (saved)="update(entry, $event)"
                      (cancelled)="stopEditing(entry.id)"
                    />
                  } @else {
                    <mt-time-entry [entry]="row(entry)" [attr.data-status]="entry.status">
                      @if (actionsFor(entry); as actions) {
                        <button
                          mtIconButton
                          icon="more"
                          size="sm"
                          [label]="'More actions for ' + (entry.narrative || 'this entry')"
                          [attr.data-entry]="entry.id"
                          [mtMenuTrigger]="menu"
                        ></button>
                        <ng-template #menu>
                          <mt-menu aria-label="Time entry actions">
                            @if (actions.edit) {
                              <button mtMenuItem icon="compose" (click)="startEditing(entry.id)">Edit</button>
                            }
                            @if (actions.approve && entry.status === 'draft') {
                              <button mtMenuItem icon="check-circle" (click)="setStatus(entry, 'final')">
                                Mark final
                              </button>
                            }
                            @if (actions.approve && entry.status === 'final') {
                              <button mtMenuItem icon="refresh" (click)="setStatus(entry, 'draft')">
                                Back to draft
                              </button>
                              <button mtMenuItem icon="minus" (click)="writeDown(entry)">Write down or off…</button>
                            }
                            @if (actions.edit) {
                              <button mtMenuItem icon="trash" tone="danger" (click)="remove(entry)">Delete</button>
                            }
                          </mt-menu>
                        </ng-template>
                      }
                    </mt-time-entry>
                  }
                </li>
              }
            </ul>
          </section>
        } @empty {
          <mt-empty-state
            icon="timer"
            [title]="person() ? 'No time from ' + screen.memberName(person()) : 'No time yet'"
            [description]="
              canRecord()
                ? 'Press t to record time: a duration such as 0.3, 18m or 1:12, then what you did.'
                : 'Time recorded on this matter shows here.'
            "
            [headingLevel]="3"
          />
        }
      }
    }
    @if (disbursementsOn()) {
      <mt-matter-disbursements class="disbursements" />
    }
    @if (billsOn()) {
      <mt-matter-bills class="disbursements" />
    }
  `,
  styles: `
    .mt-matter-time .disbursements {
      margin-top: var(--space-16);
    }
    .mt-matter-time {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      max-width: 1080px;
    }
    .mt-matter-time .head {
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-8) var(--space-12);
    }
    .mt-matter-time h2,
    .mt-matter-time h3 {
      margin: 0;
    }
    .mt-matter-time .person .mt-select {
      min-width: 180px;
    }
    .mt-matter-time .add {
      padding: var(--space-12);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }
    .mt-matter-time .day {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .mt-matter-time .day-head {
      align-items: baseline;
      padding: 0 var(--space-4);
      font: inherit;
    }
    .mt-matter-time .rows {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .mt-matter-time .rows > li > .mt-time-entry-form {
      padding: var(--space-8) var(--space-12);
      border: 1px solid var(--border-focus);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }
  `,
})
export class MatterTime {
  protected readonly screen = inject(MatterScreen);
  protected readonly pricing = timePricing();
  protected readonly EVERYONE = EVERYONE;
  private readonly toasts = inject(ToastService);
  private readonly dialogs = inject(DialogService);
  private readonly injector = inject(Injector);
  private readonly today = inject(MT_TODAY);
  private readonly api = timeCallables(inject(CALLABLES));
  private readonly repo = matterTimeRepository(this.screen.id);
  private readonly addForm = viewChild<TimeEntryForm>('addForm');
  private readonly flags = inject(FeatureFlagService);

  private readonly canRecordTime = can('time.record');
  private readonly canApprove = can('time.approve');
  protected readonly canRecord = computed(() => this.canRecordTime() && !this.screen.deleted());
  /** Disbursements (BILL-04) sit under the time while their flag is on. */
  protected readonly disbursementsOn = computed(() => this.flags.isOn('billing.disbursements'));
  /** Its bills (BILL-07) follow, for billing.view roles while `billing.invoicing` is on. */
  private readonly canViewBilling = can('billing.view');
  protected readonly billsOn = computed(() => this.flags.isOn('billing.invoicing') && this.canViewBilling());

  protected readonly entries = this.repo.watchQuery(forMatter(this.screen.id, MATTER_TIME_QUERY));
  protected readonly loadError = computed(() => errorCopy(this.entries.error()));

  protected readonly person = signal<string>(EVERYONE);
  protected readonly editing = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly announcement = signal('');

  protected readonly fixedFee = computed(() => isFixedFee(this.screen.value()));
  protected readonly newInitial = computed(() => ({ billable: defaultBillable(this.screen.value()) }));

  private readonly shown = computed(() => {
    const person = this.person();
    return this.entries.value().filter((entry) => !person || entry.uid === person);
  });
  protected readonly days = computed(() => timeByDay(this.shown()));
  private readonly totals = computed(() => timeTotals(this.shown()));
  protected readonly totalsText = computed(() => {
    const totals = this.totals();
    const parts = [`${this.unitsText(totals.units)}`, this.amount(totals.amountCents)];
    if (totals.nonBillableUnits) parts.push(`${this.unitsText(totals.nonBillableUnits)} not billed`);
    return parts.join(' · ');
  });

  /** Everyone with time on this matter (former members too), then me if I have none yet. */
  protected readonly memberOptions = computed((): MtOption<string>[] => {
    const uids = [...new Set(this.entries.value().map((entry) => entry.uid))];
    const options = uids
      .map((uid) => ({ value: uid, label: this.screen.memberName(uid) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [{ value: EVERYONE, label: 'Everyone' }, ...options];
  });

  protected readonly preview = (minutes: number, date: DateOnly): TimeEntryValues | null =>
    this.pricing.preview({ minutes, date, matter: this.screen.value() });
  protected readonly noPreview = (): TimeEntryValues | null => null;
  private readonly dayTime = dayTime();
  protected readonly myDayMinutes = (date: DateOnly) => this.minutesOn(this.screen.me() ?? '', date);

  constructor() {
    const shortcuts = inject(ShortcutService);
    const cleanup = shortcuts.register({
      combo: 't',
      description: 'Record time on this matter',
      group: 'Time',
      scope: 'route',
      when: () => this.canRecord(),
      handler: () => this.focusAdd(),
    });
    inject(DestroyRef).onDestroy(cleanup);
    // ⌘K's "Log time" on this matter.
    onIntent(
      'log-time',
      () => this.focusAdd(),
      () => this.canRecord(),
    );
  }

  protected heading(date: string): string {
    return dayHeading(date, this.today());
  }

  protected unitsText(units: number): string {
    return `${formatUnits(units, this.pricing.unitMinutes())} h`;
  }

  protected amount(cents: number): string {
    return formatAud(cents);
  }

  protected row(entry: Entry) {
    return timeEntryRow(entry, {
      memberName: (uid) => this.screen.memberName(uid),
      matter: this.screen.value(),
      unitMinutes: this.pricing.unitMinutes(),
    });
  }

  /** What I can do to an entry: edit or delete my drafts (approvers: anyone's), and approve. */
  protected actionsFor(entry: Entry): { edit: boolean; approve: boolean } | null {
    if (this.screen.deleted()) return null;
    const approve = this.canApprove() && (entry.status === 'draft' || entry.status === 'final');
    const edit =
      entry.status === 'draft' && (this.canApprove() || (this.canRecordTime() && entry.uid === this.screen.me()));
    return edit || approve ? { edit, approve } : null;
  }

  protected dayMinutesFor(entry: Entry): (date: DateOnly) => Promise<number> {
    return (date) => this.minutesOn(entry.uid, date, entry.id);
  }

  /** Minutes on a day across every matter; this matter's alone when that can't be read. */
  private async minutesOn(uid: string, date: DateOnly, exceptId?: string): Promise<number> {
    return (await this.dayTime(uid, date, exceptId)) ?? dayMinutes(this.entries.value(), uid, date, exceptId);
  }

  protected focusAdd(): void {
    if (!this.canRecord()) return;
    this.addForm()?.focus();
  }

  /** Records a draft. Not awaited: offline, it's saved when back online. */
  protected create(value: TimeEntryFormValue): void {
    const values = this.pricing.preview({ minutes: value.minutes, date: value.date, matter: this.screen.value() });
    this.repo
      .create({
        date: value.date,
        minutes: value.minutes,
        narrative: value.narrative,
        billable: value.billable,
        units: values.units,
        rateCents: values.rateCents,
        amountCents: values.amountCents,
      })
      .catch((error: unknown) =>
        this.toasts.show({ title: 'The time didn’t save', description: errorCopy(error), tone: 'danger' }),
      );
    this.announcement.set(`Recorded ${this.unitsText(values.units)} on ${this.heading(value.date).toLowerCase()}.`);
    // The row starts again on the same date (several entries for one day are common).
    this.addForm()?.reset(true);
    this.addForm()?.focus();
  }

  protected startEditing(id: string): void {
    this.editing.set(id);
  }

  protected stopEditing(id: string): void {
    this.editing.set(null);
    this.focusRow(id);
  }

  protected async update(entry: Entry, value: TimeEntryFormValue): Promise<void> {
    // My own entries carry the preview; time-onWrite prices everyone's (another person's rate isn't mine).
    const values =
      entry.uid === this.screen.me()
        ? this.pricing.preview({ minutes: value.minutes, date: value.date, matter: this.screen.value() })
        : null;
    this.busy.set(true);
    try {
      await this.repo.update(entry.id, {
        date: value.date,
        minutes: value.minutes,
        narrative: value.narrative,
        billable: value.billable,
        ...(values ? { units: values.units, rateCents: values.rateCents, amountCents: values.amountCents } : {}),
      });
      this.announcement.set('Saved.');
      this.stopEditing(entry.id);
    } catch (error) {
      this.toasts.show({ title: 'The change didn’t save', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(entry: Entry): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: 'Delete this time entry?',
      body: `${this.unitsText(entry.units)} on ${this.heading(entry.date).toLowerCase()}: ${entry.narrative || 'no narrative'}.`,
      confirmLabel: 'Delete entry',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await this.repo.softDelete(entry.id);
      this.announcement.set('Deleted the entry.');
    } catch (error) {
      this.toasts.show({ title: 'The entry wasn’t deleted', description: errorCopy(error), tone: 'danger' });
    }
  }

  protected async setStatus(entry: Entry, status: 'draft' | 'final'): Promise<void> {
    const matterId = this.screen.id();
    if (!matterId) return;
    try {
      const result = await this.api.setStatus({ matterId, entryIds: [entry.id], status });
      if (result.updated.length) this.announcement.set(status === 'final' ? 'Marked final.' : 'Back to draft.');
      else this.toasts.show({ title: 'Nothing changed', description: 'That entry has been billed or written off.' });
    } catch (error) {
      this.toasts.show({ title: 'The status didn’t change', description: errorCopy(error), tone: 'danger' });
    }
  }

  /** Writes approved time down or off here, as on the pre-bill (BILL-07b). */
  protected async writeDown(entry: Entry): Promise<void> {
    const matterId = this.screen.id();
    if (!matterId) return;
    try {
      const ui = { dialogs: this.dialogs, toasts: this.toasts };
      const summary = await writeDownTime(ui, this.api, matterId, [entry], this.pricing.unitMinutes());
      if (summary) this.announcement.set(summary);
    } catch (error) {
      this.toasts.show({ title: 'The time wasn’t written down', description: errorCopy(error), tone: 'danger' });
    }
  }

  private focusRow(id: string): void {
    afterNextRender(
      () => {
        const host = document.querySelector<HTMLElement>(`.mt-matter-time [data-entry="${CSS.escape(id)}"]`);
        host?.focus();
      },
      { injector: this.injector },
    );
  }
}
