import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { matterDetailRepository, type MatterDetail, type WithId } from '@materia/data-access/repository';
import {
  defaultBillable,
  describeTimerElapsed,
  formatTimerElapsed,
  formatUnits,
  TIMER_MATTER_UNAVAILABLE,
  TIMER_SPLIT_MS,
  timerEntries,
  timerMinutes,
  timeUnits,
  toDisplay,
  type DateOnly,
} from '@materia/domain';
import {
  DialogService,
  formatAud,
  injectDialogRef,
  MtButton,
  MtCheckbox,
  MtDialog,
  MtNote,
  ToastService,
} from '@materia/ui';

import { clockTime } from './clock-label';
import { TimerStore } from './timer-store';
import { NarrativeField } from '../../features/time/narrative-field';
import { timePricing } from '../../features/time/time-pricing';
import type { TimeQuickEntryData, TimeQuickEntryResult } from '../../features/time/time-quick-entry';
import { errorCodeOf, errorCopy } from '../error-copy';

/*
 * The global timer's dialogs (BILL-02), loaded on first use: the stop-and-save dialog, the
 * "another timer is running" and idle-time questions, and the matter picker for switching.
 */

// ---------- a question with several answers ----------

export interface TimerChoice<T extends string> {
  id: T;
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}

export interface TimerChoiceData<T extends string> {
  title: string;
  body: string;
  choices: readonly TimerChoice<T>[];
}

/** A question with two or three answers besides Cancel (Escape cancels too). */
@Component({
  selector: 'mt-timer-choice-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtDialog],
  template: `
    <mt-dialog size="sm" [title]="data.title" [description]="data.body">
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close(undefined)">Cancel</button>
        @for (choice of data.choices; track choice.id) {
          <button mtButton [variant]="choice.variant ?? 'secondary'" (click)="ref.close(choice.id)">
            {{ choice.label }}
          </button>
        }
      </ng-container>
    </mt-dialog>
  `,
})
export class TimerChoiceDialog {
  protected readonly ref = injectDialogRef<TimerChoiceData<string>, string | undefined>();
  protected readonly data = this.ref.data;
}

function choose<T extends string>(dialogs: DialogService, data: TimerChoiceData<T>): Promise<T | undefined> {
  return dialogs.open<TimerChoiceData<T>, T>(TimerChoiceDialog, { data }).result;
}

/** Units for a duration at the default 6-minute unit, rounded up, as "0.4". */
function unitsLabel(ms: number): string {
  return formatUnits(timeUnits(timerMinutes(ms), { rounding: 'up' }));
}

/** Another timer is running: save it, or throw it away, before starting on `to`. */
export function askSwitch(
  dialogs: DialogService,
  input: { from: string; to: string; elapsedMs: number },
): Promise<'save' | 'discard' | undefined> {
  return choose(dialogs, {
    title: `Stop and save ${input.from} (${unitsLabel(input.elapsedMs)})?`,
    body: `A timer is running on ${input.from}. Save its time as a draft entry, or discard it, then start on ${input.to}.`,
    choices: [
      { id: 'discard', label: 'Discard', variant: 'danger' },
      { id: 'save', label: 'Stop and save', variant: 'primary' },
    ],
  });
}

/** No input for a while: keep the idle time, discard it, or stop at the time it began. */
export function askIdle(dialogs: DialogService, since: Date): Promise<'keep' | 'discard' | 'stop' | undefined> {
  const time = clockTime(since);
  return choose(dialogs, {
    title: `You were idle from ${time}`,
    body: `Keep the idle time, discard it, or stop the timer at ${time}?`,
    choices: [
      { id: 'keep', label: 'Keep' },
      { id: 'discard', label: 'Discard idle time' },
      { id: 'stop', label: `Stop at ${time}`, variant: 'primary' },
    ],
  });
}

/** The matter picker (quick entry's, in pick mode). */
export async function pickMatter(
  dialogs: DialogService,
  title = 'Switch the timer',
  description = 'Choose the matter to time.',
): Promise<{ matterId: string; matterNumber: string } | null> {
  const { TimeQuickEntry } = await import('../../features/time/time-quick-entry');
  const picked = await dialogs.open<TimeQuickEntryData, TimeQuickEntryResult | undefined>(TimeQuickEntry, {
    data: { pick: { title, description } },
  }).result;
  return picked ? { matterId: picked.matterId, matterNumber: picked.number } : null;
}

// ---------- stop and save ----------

type PickedMatter = WithId<MatterDetail>;

/**
 * Stop (BILL-02): the timer is paused behind it. Shows the time and its rounded units, the
 * narrative and billable; Save creates the draft entry (`time-stopTimer`, `source: 'timer'`).
 * Over 24 hours it offers one entry per day. If the matter was deleted or the person lost access,
 * the time stays on the timer until they choose another matter to save it to. Cancel leaves the
 * timer paused, keeping the narrative typed.
 */
@Component({
  selector: 'mt-stop-timer-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtCheckbox, MtDialog, MtNote, NarrativeField],
  template: `
    <mt-dialog size="md" title="Save timer" [description]="description()">
      <div class="mt-col" style="gap: var(--space-12)">
        <div class="mt-row summary" data-testid="timer-summary">
          <span class="label">{{ number() }}</span>
          <span class="t-2">{{ elapsedText() }}</span>
          <span class="mt-ml label" data-testid="timer-units">{{ unitsText() }} h</span>
          @if (amountText(); as amount) {
            <span class="caption t-3">{{ amount }}</span>
          }
        </div>
        @if (unavailable()) {
          <mt-note tone="warning" role="alert">
            {{ unavailableNumber() }} can’t take this time: it was deleted, or you can no longer open it. Choose another
            matter to save it to; the timer keeps it until then.
          </mt-note>
        }
        @if (needsReview()) {
          <mt-note tone="warning">
            This timer was started offline, and this device’s clock was more than 2 minutes out. Check the time before
            saving.
          </mt-note>
        }
        <mt-narrative-field [(value)]="narrative" (submitted)="save()" />
        <mt-checkbox name="billable" label="Billable" [ngModel]="billable()" (ngModelChange)="billable.set(!!$event)" />
        @if (long()) {
          <mt-checkbox
            name="split"
            label="Split into one entry per day"
            [ngModel]="split()"
            (ngModelChange)="split.set(!!$event)"
          />
          @if (split()) {
            <ul class="caption t-3 days" aria-label="Entries per day">
              @for (day of days(); track day.date) {
                <li>{{ dayLabel(day.date) }}: {{ dayUnits(day.minutes) }} h</li>
              }
            </ul>
          }
        }
      </div>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="cancel()">Cancel</button>
        <button mtButton variant="danger" (click)="discard()">Discard</button>
        @if (unavailable()) {
          <button mtButton variant="secondary" (click)="chooseMatter()">Choose matter</button>
        }
        <button
          mtButton
          variant="primary"
          [loading]="saving()"
          [disabled]="unavailable() && !target()"
          (click)="save()"
        >
          Save
        </button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .summary {
      align-items: baseline;
      gap: var(--space-8);
      padding: var(--space-8) var(--space-12);
      border-radius: var(--radius-md);
      background: var(--bg-sunken);
    }
    .days {
      margin: 0;
      padding-left: var(--space-16);
    }
  `,
})
export class StopTimerDialog {
  protected readonly ref = injectDialogRef<unknown, boolean>();
  private readonly store = inject(TimerStore);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly pricing = timePricing();
  private readonly matters = matterDetailRepository();

  private readonly timer = this.store.timer;
  /** Frozen when the dialog opens (the timer is paused behind it). */
  private readonly elapsedMs = this.store.elapsedMs();
  private readonly endMs = this.store.serverNow();
  private readonly matter = signal<PickedMatter | null>(null);
  /** Another matter chosen to save to (the timer's own is unavailable). */
  protected readonly target = signal<{ matterId: string; matterNumber: string } | null>(null);
  protected readonly unavailable = signal(false);
  protected readonly unavailableNumber = signal('');
  protected readonly narrative = signal(this.timer()?.narrativeDraft ?? '');
  protected readonly billable = signal(true);
  protected readonly long = computed(() => this.elapsedMs > TIMER_SPLIT_MS);
  protected readonly split = signal(this.elapsedMs > TIMER_SPLIT_MS);
  protected readonly saving = signal(false);
  protected readonly needsReview = computed(() => this.timer()?.needsReview === true);

  protected readonly number = computed(() => this.target()?.matterNumber ?? this.timer()?.matterNumber ?? '');
  protected readonly description = computed(() => `Save the time as a draft entry on ${this.number()}.`);
  protected readonly elapsedText = computed(
    () => `${formatTimerElapsed(this.elapsedMs)} (${describeTimerElapsed(this.elapsedMs)})`,
  );
  protected readonly days = computed(() =>
    timerEntries(this.endMs, this.elapsedMs, this.pricing.timeZone(), this.split() && this.long()),
  );
  private readonly priced = computed(() =>
    this.days().map((day) => this.pricing.preview({ minutes: day.minutes, date: day.date, matter: this.matter() })),
  );
  protected readonly unitsText = computed(() =>
    formatUnits(
      this.priced().reduce((sum, values) => sum + values.units, 0),
      this.pricing.unitMinutes(),
    ),
  );
  protected readonly amountText = computed(() => {
    if (!this.billable()) return 'Not billable';
    const cents = this.priced().reduce((sum, values) => sum + values.amountCents, 0);
    return cents ? formatAud(cents) : null;
  });

  constructor() {
    // The matter's fee sets the billable default; a deleted or unreadable one can't take the time.
    effect(() => {
      const id = this.target()?.matterId ?? this.timer()?.matterId;
      if (!id) return;
      untracked(() => void this.loadMatter(id));
    });
  }

  protected dayLabel(date: DateOnly): string {
    return toDisplay(date);
  }

  protected dayUnits(minutes: number): string {
    return formatUnits(
      timeUnits(minutes, { rounding: 'up', unitMinutes: this.pricing.unitMinutes() }),
      this.pricing.unitMinutes(),
    );
  }

  protected cancel(): void {
    this.store.saveNarrative(this.narrative());
    this.ref.close(false);
  }

  protected async discard(): Promise<void> {
    const sure = await this.dialogs.confirm({
      title: `Discard the timer on ${this.timer()?.matterNumber ?? 'this matter'}?`,
      body: `${formatTimerElapsed(this.elapsedMs)} of time is thrown away. This can’t be undone.`,
      confirmLabel: 'Discard timer',
      tone: 'danger',
    });
    if (!sure) return;
    await this.store.discard();
    this.ref.close(false);
  }

  protected async chooseMatter(): Promise<void> {
    const picked = await pickMatter(this.dialogs, 'Save the time to');
    if (!picked) return;
    this.target.set(picked);
    this.unavailable.set(false);
  }

  protected async save(): Promise<void> {
    if (this.saving() || (this.unavailable() && !this.target())) return;
    this.saving.set(true);
    const number = this.number();
    try {
      const target = this.target();
      const result = await this.store.save({
        narrative: this.narrative(),
        billable: this.billable(),
        split: this.split() && this.long(),
        ...(target ? { matterId: target.matterId } : {}),
      });
      this.toasts.show({
        title: `Saved ${this.unitsText()} h on ${number}`,
        description:
          result.entryIds.length > 1 ? `${result.entryIds.length} draft entries, one per day.` : 'A draft entry.',
        tone: 'success',
      });
      this.ref.close(true);
    } catch (error) {
      const reason = (error as { details?: { reason?: unknown } } | null)?.details?.reason;
      if (errorCodeOf(error) === 'FAILED_PRECONDITION' && reason === TIMER_MATTER_UNAVAILABLE) {
        this.unavailableNumber.set(number);
        this.unavailable.set(true);
        this.target.set(null);
      } else {
        this.toasts.show({ title: 'The timer didn’t save', description: errorCopy(error), tone: 'danger' });
      }
    } finally {
      this.saving.set(false);
    }
  }

  private async loadMatter(id: string): Promise<void> {
    try {
      const matter = await this.matters.get(id);
      if (!matter || matter.deletedAt) {
        this.matter.set(null);
        if (!this.target()) {
          this.unavailableNumber.set(this.number());
          this.unavailable.set(true);
        }
        return;
      }
      this.matter.set(matter);
      this.billable.set(defaultBillable(matter));
    } catch {
      // Unreadable (access changed, or offline): the server decides on save.
    }
  }
}

/** Opens the stop dialog; resolves true when the timer was saved. */
export async function openStopTimer(dialogs: DialogService): Promise<boolean> {
  return (await dialogs.open<unknown, boolean>(StopTimerDialog).result) === true;
}
