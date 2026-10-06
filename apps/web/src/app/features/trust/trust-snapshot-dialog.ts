import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { trustCallables } from '@materia/data-access/repository';
import { asAtProblem, TRUST_NOTE_MAX, type Cents, type DateOnly } from '@materia/domain';
import { injectDialogRef, MT_TODAY, MtButton, MtDialog, MtTextField } from '@materia/ui';

import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { dollarsText, parseDollars } from '../settings/money';
import { formatEntryDate, parseEntryDate } from '../time/time-view';

export interface TrustSnapshotDialogData {
  matterId: string;
  /** "M-2026-0142 · Estate of Margaret Doyle", under the title. */
  matterLabel: string;
  /** The records the balance is copied from ("Smokeball"). */
  recordsName: string;
  /** The current snapshot, to start from. */
  amountCents?: number | undefined;
}

/**
 * Update trust balance (BILL-11, ADR-035): the amount, the as-at date (today by default, never in
 * the future) and an optional note, copied from the firm's trust records, saved through
 * `trust-recordSnapshot`. Closes with `true` once saved. There is no deposit, withdrawal or
 * transfer: the amount replaces the last copy.
 */
@Component({
  selector: 'mt-trust-snapshot-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtTextField],
  template: `
    <mt-dialog size="sm" title="Update trust balance" [description]="data.matterLabel">
      <form
        id="mt-trust-form"
        class="mt-col"
        style="gap: var(--space-12)"
        aria-label="Trust balance"
        (submit)="$event.preventDefault(); save()"
      >
        <div class="pair">
          <mt-text-field
            name="amount"
            label="Amount"
            inputmode="decimal"
            iconStart="billing"
            autocomplete="off"
            [error]="amountError() ?? undefined"
            [ngModel]="amount()"
            (ngModelChange)="amount.set($event ?? ''); amountError.set(null)"
          />
          <mt-text-field
            name="asAt"
            label="As at"
            placeholder="DD/MM/YYYY"
            autocomplete="off"
            [error]="asAtError() ?? undefined"
            [ngModel]="asAt()"
            (ngModelChange)="asAt.set($event ?? ''); asAtError.set(null)"
          />
        </div>
        <mt-text-field
          name="note"
          label="Note"
          optional
          autocomplete="off"
          placeholder="Where you read it, e.g. trust ledger report 5 Oct"
          [error]="noteError() ?? undefined"
          [ngModel]="note()"
          (ngModelChange)="note.set($event ?? '')"
        />
        <p class="caption t-3" style="margin: 0">
          Copy the balance from {{ data.recordsName }}. The change is recorded in the audit log.
        </p>
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close(false)">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-trust-form" [loading]="saving()">Save balance</button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .pair {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: var(--space-12);
      align-items: start;
    }
  `,
})
export class TrustSnapshotDialog {
  protected readonly ref = injectDialogRef<TrustSnapshotDialogData, boolean>();
  protected readonly data = this.ref.data;
  private readonly today = inject(MT_TODAY);
  private readonly api = trustCallables(inject(CALLABLES));

  protected readonly amount = signal(dollarsText(this.data.amountCents));
  protected readonly asAt = signal(formatEntryDate(this.today()));
  protected readonly note = signal('');
  protected readonly amountError = signal<string | null>(null);
  protected readonly asAtError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly noteError = computed(() =>
    this.note().trim().length > TRUST_NOTE_MAX ? `Up to ${TRUST_NOTE_MAX} characters` : null,
  );

  protected async save(): Promise<void> {
    if (this.saving()) return;
    const amountCents = parseDollars(this.amount());
    const today = this.today();
    const asAt = parseEntryDate(this.asAt(), today);
    const amountProblem =
      amountCents === null || amountCents === undefined ? 'Enter the balance in dollars, e.g. 84,210.00' : null;
    const dateProblem = asAt ? asAtProblem(asAt, today) : 'Enter a date as DD/MM/YYYY';
    this.amountError.set(amountProblem);
    this.asAtError.set(dateProblem);
    if (amountProblem || dateProblem || this.noteError()) return;
    this.saving.set(true);
    try {
      const note = this.note().trim();
      await this.api.recordSnapshot({
        matterId: this.data.matterId,
        amountCents: amountCents as Cents,
        asAt: asAt as DateOnly,
        ...(note ? { note } : {}),
      });
      this.ref.close(true);
    } catch (error) {
      this.amountError.set(errorCopy(error));
    } finally {
      this.saving.set(false);
    }
  }
}
