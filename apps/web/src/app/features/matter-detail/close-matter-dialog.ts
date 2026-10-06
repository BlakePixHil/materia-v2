import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { MatterCallables } from '@materia/data-access/repository';
import {
  closingItemsFor,
  evaluateClosing,
  ORIGINALS_LABELS,
  RETENTION_HOLD_LABELS,
  type ClosingChecklistResult,
  type ClosingItem,
  type ClosingOverrides,
  type CloseMatterResult,
  type MatterType,
  type OriginalsOutcome,
} from '@materia/domain';
import {
  formatDateOnly,
  injectDialogRef,
  MtButton,
  MtCheckbox,
  MtDialog,
  MtIcon,
  MtNote,
  MtRadioGroup,
  MtTextarea,
  MtTextField,
  type MtOption,
} from '@materia/ui';

import { matterErrorCopy } from './matter-view';

export interface CloseMatterDialogData {
  matter: { id: string; number: string; type: MatterType };
  api: Pick<MatterCallables, 'closingChecklist' | 'close'>;
}

const ORIGINALS: MtOption<OriginalsOutcome>[] = (Object.keys(ORIGINALS_LABELS) as OriginalsOutcome[]).map((value) => ({
  value,
  label: ORIGINALS_LABELS[value],
}));

const ITEM_ICONS = { done: 'check-circle', overridden: 'minus', todo: 'clock' } as const;

/** "Kept until at least 5 Oct 2033 (7 years)" or why it's kept with no date. */
export function retentionText(
  result: Pick<ClosingChecklistResult, 'destroyAfter' | 'holds' | 'retentionYears'>,
): string {
  if (result.destroyAfter) {
    return `Kept until at least ${formatDateOnly(result.destroyAfter)} (${result.retentionYears} years), then offered for destruction.`;
  }
  const why = result.holds.map((hold) => RETENTION_HOLD_LABELS[hold]).join(' and ');
  return `Kept with no destruction date because of ${why || 'a hold'}.`;
}

/**
 * Closes a matter through its closing checklist (CORE-19): the server's counts (deadlines, open
 * tasks), the questions it asks (originals, the closing letter, estates' final distribution), a
 * reason, and the retention date closing sets. Closes with the result, or `undefined`.
 */
@Component({
  selector: 'mt-close-matter-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtCheckbox, MtDialog, MtIcon, MtNote, MtRadioGroup, MtTextarea, MtTextField],
  template: `
    <mt-dialog
      size="md"
      [title]="'Close ' + data.matter.number"
      description="Closed matters stay readable and can be reopened. They’re archived 90 days after closing."
    >
      @if (loadError(); as message) {
        <mt-note tone="danger">{{ message }}</mt-note>
      } @else if (!checklist()) {
        <p class="body-m t-3" role="status">Checking the matter…</p>
      } @else {
        <form id="mt-close-matter-form" class="mt-stack form" (submit)="$event.preventDefault(); close()">
          @for (warning of checklist()!.warnings; track warning.matterId) {
            <mt-note tone="warning">Related matter {{ warning.number }} is still open.</mt-note>
          }
          <ul class="items" aria-label="Closing checklist">
            @for (item of evaluation().items; track item.id) {
              <li class="mt-row item" [attr.data-state]="item.state">
                <mt-icon [name]="icon(item)" [size]="16" />
                <span class="mt-grow">
                  <span class="body-m">{{ item.label }}</span>
                  <span class="mt-sr">. {{ stateText(item) }}</span>
                  @if (item.detail) {
                    <span class="caption t-3 detail">{{ item.detail }}</span>
                  }
                </span>
              </li>
            }
          </ul>

          @if (checklist()!.counts.openTasks > 0) {
            <mt-checkbox
              name="cancelTasks"
              [label]="'Cancel the ' + taskCount() + ' when closing'"
              [ngModel]="cancelTasks()"
              (ngModelChange)="cancelTasks.set(!!$event)"
            />
            @if (cancelTasks()) {
              <mt-text-field
                name="cancelReason"
                label="Why cancel them"
                [required]="true"
                [ngModel]="cancelReason()"
                (ngModelChange)="cancelReason.set($event ?? '')"
              />
            }
          }

          <mt-radio-group
            name="originals"
            label="Original documents"
            [options]="originalsOptions"
            [ngModel]="originals()"
            (ngModelChange)="setOriginals($event)"
          />

          <mt-checkbox
            name="closingLetter"
            label="Closing letter sent"
            [ngModel]="closingLetterSent()"
            (ngModelChange)="closingLetterSent.set(!!$event)"
          />
          @if (!closingLetterSent()) {
            <mt-text-field
              name="closingLetterWhy"
              label="Or say why there’s no closing letter"
              [ngModel]="closingLetterWhy()"
              (ngModelChange)="closingLetterWhy.set($event ?? '')"
            />
          }
          @if (estate()) {
            <mt-checkbox
              name="finalDistribution"
              label="Final distribution recorded"
              [ngModel]="finalDistributionRecorded()"
              (ngModelChange)="finalDistributionRecorded.set(!!$event)"
            />
            @if (!finalDistributionRecorded()) {
              <mt-text-field
                name="finalDistributionWhy"
                label="Or say why there’s no final distribution"
                [ngModel]="finalDistributionWhy()"
                (ngModelChange)="finalDistributionWhy.set($event ?? '')"
              />
            }
          }

          <mt-textarea
            name="reason"
            label="Reason for closing"
            [rows]="2"
            [maxLength]="500"
            [required]="true"
            [ngModel]="reason()"
            (ngModelChange)="reason.set($event ?? '')"
          />
          <p class="caption t-3 retention">{{ retention() }}</p>
          @if (error(); as message) {
            <mt-note tone="danger">{{ message }}</mt-note>
          }
        </form>
      }
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="cancel()">Cancel</button>
        <button
          mtButton
          variant="primary"
          type="submit"
          form="mt-close-matter-form"
          [disabled]="!canSubmit()"
          [loading]="busy()"
        >
          Close matter
        </button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .form {
      gap: var(--space-12);
    }
    .items {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .item {
      gap: var(--space-8);
      align-items: flex-start;
    }
    .item[data-state='done'] mt-icon {
      color: var(--text-success);
    }
    .item[data-state='todo'] mt-icon {
      color: var(--text-tertiary);
    }
    .detail {
      display: block;
    }
    .retention {
      margin: 0;
    }
  `,
})
export class CloseMatterDialog {
  protected readonly ref = injectDialogRef<CloseMatterDialogData, CloseMatterResult | undefined>();
  protected readonly data = this.ref.data;
  protected readonly originalsOptions = ORIGINALS;

  protected readonly checklist = signal<ClosingChecklistResult | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly originals = signal<OriginalsOutcome | null>(null);
  protected readonly closingLetterSent = signal(false);
  protected readonly closingLetterWhy = signal('');
  protected readonly finalDistributionRecorded = signal(false);
  protected readonly finalDistributionWhy = signal('');
  protected readonly cancelTasks = signal(false);
  protected readonly cancelReason = signal('');
  protected readonly reason = signal('');

  protected readonly estate = computed(() => closingItemsFor(this.data.matter.type).includes('final_distribution'));
  protected readonly taskCount = computed(() => {
    const n = this.checklist()?.counts.openTasks ?? 0;
    return n === 1 ? '1 open task' : `${n} open tasks`;
  });

  private readonly overrides = computed<ClosingOverrides>(() => {
    const overrides: ClosingOverrides = {};
    if (!this.closingLetterSent() && this.closingLetterWhy().trim())
      overrides.closing_letter = this.closingLetterWhy().trim();
    if (this.estate() && !this.finalDistributionRecorded() && this.finalDistributionWhy().trim()) {
      overrides.final_distribution = this.finalDistributionWhy().trim();
    }
    return overrides;
  });

  /** The checklist as answered so far, evaluated here against the server's counts. */
  protected readonly evaluation = computed(() =>
    evaluateClosing(
      this.data.matter.type,
      this.checklist()?.counts ?? { upcomingDeadlines: 0, openTasks: 0 },
      {
        originals: this.originals() ?? undefined,
        closingLetterSent: this.closingLetterSent(),
        finalDistributionRecorded: this.finalDistributionRecorded(),
      },
      { cancelOpenTasks: this.cancelTasks() && !!this.cancelReason().trim(), overrides: this.overrides() },
    ),
  );
  protected readonly retention = computed(() => {
    const checklist = this.checklist();
    return checklist ? retentionText(checklist) : '';
  });
  protected readonly canSubmit = computed(
    () => !!this.checklist() && this.evaluation().ready && !!this.reason().trim() && !this.busy(),
  );

  constructor() {
    void this.load();
  }

  protected icon(item: ClosingItem) {
    return ITEM_ICONS[item.state];
  }

  protected stateText(item: ClosingItem): string {
    return item.state === 'done' ? 'Done' : item.state === 'overridden' ? 'Skipped with a reason' : 'Still to do';
  }

  protected setOriginals(value: OriginalsOutcome | null): void {
    this.originals.set(value);
    // Originals in safe custody keep a will or power of attorney with no destruction date.
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const originals = this.originals();
      this.checklist.set(
        await this.data.api.closingChecklist({
          matterId: this.data.matter.id,
          ...(originals ? { checklist: { originals } } : {}),
        }),
      );
      this.loadError.set(null);
    } catch (error) {
      this.loadError.set(matterErrorCopy(error));
    }
  }

  protected cancel(): void {
    void this.ref.close(undefined);
  }

  protected async close(): Promise<void> {
    if (!this.canSubmit()) return;
    const originals = this.originals();
    this.busy.set(true);
    this.error.set(null);
    try {
      const overrides = this.overrides();
      const result = await this.data.api.close({
        matterId: this.data.matter.id,
        reason: this.reason().trim(),
        checklist: {
          ...(originals ? { originals } : {}),
          closingLetterSent: this.closingLetterSent(),
          finalDistributionRecorded: this.finalDistributionRecorded(),
        },
        ...(this.cancelTasks() && (this.checklist()?.counts.openTasks ?? 0) > 0
          ? { cancelOpenTasks: { reason: this.cancelReason().trim() } }
          : {}),
        ...(Object.keys(overrides).length ? { checklistOverrides: overrides } : {}),
      });
      void this.ref.close(result);
    } catch (error) {
      this.error.set(matterErrorCopy(error));
      // The server's counts may have moved (a task was added meanwhile).
      void this.load();
    } finally {
      this.busy.set(false);
    }
  }
}
