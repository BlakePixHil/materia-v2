import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { costsCallables } from '@materia/data-access/repository';
import {
  compareDates,
  DISCLOSURE_SENT_METHOD_LABELS,
  DISCLOSURE_WAIVER_REASON_LABELS,
  type DisclosureResult,
  type DisclosureSentMethod,
  type DisclosureWaiverReason,
} from '@materia/domain';
import {
  injectDialogRef,
  MT_TODAY,
  MtButton,
  MtDialog,
  MtNote,
  MtSelect,
  MtTextarea,
  MtTextField,
  type MtOption,
} from '@materia/ui';

import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { formatEntryDate, parseEntryDate } from '../time/time-view';

export interface DisclosureSentData {
  matterId: string;
  number: string;
  /** The disclosure generated last, recorded as the one sent. */
  documentId?: string | undefined;
  /** One was given before: this is the updated disclosure. */
  updated: boolean;
}

export interface DisclosureWaiverData {
  matterId: string;
  number: string;
}

const METHOD_OPTIONS: MtOption<DisclosureSentMethod>[] = (
  Object.entries(DISCLOSURE_SENT_METHOD_LABELS) as [DisclosureSentMethod, string][]
).map(([value, label]) => ({ value, label }));

const REASON_OPTIONS: MtOption<DisclosureWaiverReason>[] = (
  Object.entries(DISCLOSURE_WAIVER_REASON_LABELS) as [DisclosureWaiverReason, string][]
).map(([value, label]) => ({ value, label }));

/**
 * "Record as sent" (BILL-06; billing roles): the day the disclosure went to the client (today or
 * earlier) and how. Nothing is sent from Materia; this records that it was. Saves through
 * `costs-markDisclosureSent`, so problems show in place.
 */
@Component({
  selector: 'mt-disclosure-sent-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtNote, MtSelect, MtTextField],
  template: `
    <mt-dialog
      size="sm"
      [title]="(data.updated ? 'Updated costs disclosure for ' : 'Costs disclosure for ') + data.number"
      description="Record when the client was given it. Materia doesn’t send it for you."
    >
      <form
        id="mt-disclosure-sent-form"
        class="mt-col"
        style="gap: var(--space-12)"
        (submit)="$event.preventDefault(); save()"
      >
        <mt-text-field
          name="sentOn"
          label="Date sent"
          placeholder="DD/MM/YYYY"
          [error]="dateError() ?? undefined"
          [ngModel]="dateText()"
          (ngModelChange)="dateText.set($event ?? ''); submitted.set(false)"
        />
        <mt-select
          name="method"
          label="Sent by"
          [native]="true"
          [options]="methods"
          [ngModel]="method()"
          (ngModelChange)="method.set($event ?? 'email')"
        />
        @if (!data.documentId) {
          <mt-note tone="info"
            >No disclosure was generated in Materia. Keep a copy of the one you sent on the matter.</mt-note
          >
        }
        @if (failure(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" type="button" (click)="ref.close(undefined)">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-disclosure-sent-form" [loading]="saving()">
          Record as sent
        </button>
      </ng-container>
    </mt-dialog>
  `,
})
export class DisclosureSentDialog {
  protected readonly ref = injectDialogRef<DisclosureSentData, DisclosureResult | undefined>();
  private readonly api = costsCallables(inject(CALLABLES));
  private readonly today = inject(MT_TODAY);
  protected readonly data = this.ref.data;
  protected readonly methods = METHOD_OPTIONS;

  protected readonly dateText = signal(formatEntryDate(this.today()));
  protected readonly method = signal<DisclosureSentMethod>('email');
  protected readonly submitted = signal(false);
  protected readonly saving = signal(false);
  protected readonly failure = signal<string | null>(null);
  private readonly date = computed(() => parseEntryDate(this.dateText(), this.today()));
  protected readonly dateError = computed(() => {
    if (!this.submitted()) return null;
    const date = this.date();
    if (!date) return 'Enter a date like 4/10/2026.';
    return compareDates(date, this.today()) > 0 ? 'The date it was sent can’t be after today.' : null;
  });

  protected async save(): Promise<void> {
    this.submitted.set(true);
    const sentOn = this.date();
    if (!sentOn || this.dateError() || this.saving()) return;
    this.saving.set(true);
    this.failure.set(null);
    try {
      const result = await this.api.markDisclosureSent({
        matterId: this.data.matterId,
        sentOn,
        method: this.method(),
        ...(this.data.documentId ? { documentId: this.data.documentId } : {}),
      });
      void this.ref.close(result);
    } catch (error) {
      this.failure.set(errorCopy(error));
    } finally {
      this.saving.set(false);
    }
  }
}

/**
 * "No disclosure needed" (BILL-06; lawyers and above): one of the exceptions the Uniform Law allows,
 * with a note for "Other reason". Stops the reminders. Saves through `costs-setDisclosureWaiver`.
 */
@Component({
  selector: 'mt-disclosure-waiver-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtNote, MtSelect, MtTextarea],
  template: `
    <mt-dialog
      size="sm"
      [title]="'No costs disclosure for ' + data.number"
      description="Only where an exception applies. It’s kept in the matter’s disclosure history."
    >
      <form
        id="mt-disclosure-waiver-form"
        class="mt-col"
        style="gap: var(--space-12)"
        (submit)="$event.preventDefault(); save()"
      >
        <mt-select
          name="reason"
          label="Why no disclosure is needed"
          [native]="true"
          [options]="reasons"
          [ngModel]="reason()"
          (ngModelChange)="reason.set($event ?? 'commercial_or_government')"
        />
        <mt-textarea
          name="note"
          label="Note"
          [optional]="reason() !== 'other'"
          [rows]="2"
          [error]="noteError() ?? undefined"
          [ngModel]="note()"
          (ngModelChange)="note.set($event ?? ''); submitted.set(false)"
        />
        @if (failure(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" type="button" (click)="ref.close(undefined)">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-disclosure-waiver-form" [loading]="saving()">
          Record as not needed
        </button>
      </ng-container>
    </mt-dialog>
  `,
})
export class DisclosureWaiverDialog {
  protected readonly ref = injectDialogRef<DisclosureWaiverData, DisclosureResult | undefined>();
  private readonly api = costsCallables(inject(CALLABLES));
  protected readonly data = this.ref.data;
  protected readonly reasons = REASON_OPTIONS;

  protected readonly reason = signal<DisclosureWaiverReason>('commercial_or_government');
  protected readonly note = signal('');
  protected readonly submitted = signal(false);
  protected readonly saving = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly noteError = computed(() =>
    this.submitted() && this.reason() === 'other' && !this.note().trim() ? 'Say why no disclosure is needed.' : null,
  );

  protected async save(): Promise<void> {
    this.submitted.set(true);
    if (this.noteError() || this.saving()) return;
    this.saving.set(true);
    this.failure.set(null);
    const note = this.note().trim();
    try {
      const result = await this.api.setDisclosureWaiver({
        matterId: this.data.matterId,
        waiver: { reason: this.reason(), ...(note ? { note } : {}) },
      });
      void this.ref.close(result);
    } catch (error) {
      this.failure.set(errorCopy(error));
    } finally {
      this.saving.set(false);
    }
  }
}
