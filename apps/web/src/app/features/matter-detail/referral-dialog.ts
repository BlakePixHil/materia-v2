import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { REFERRAL_SOURCE_LABELS, ReferralSourceSchema, type ReferralSource } from '@materia/domain';
import { injectDialogRef, MtButton, MtDialog, MtSelect, type MtOption } from '@materia/ui';

import { IntakeContactPicker, type PickedContact } from '../intake/contact-picker';

export interface ReferralDialogData {
  /** The matter's number, for the title. */
  number: string;
  /** Whether the matter records a referral now (offers "Clear"). */
  hasReferral: boolean;
  source?: ReferralSource | undefined;
  /** Contacts the referrer can't be (the matter's clients). */
  exclude: readonly string[];
}

/** A referrer contact, a source, or `null` to clear the referral. */
export type ReferralChoice = { contactId: string; name: string } | { source: ReferralSource } | null;

const SOURCE_OPTIONS: MtOption<ReferralSource | ''>[] = [
  { value: '', label: 'Choose a source' },
  ...ReferralSourceSchema.options.map((source) => ({ value: source, label: REFERRAL_SOURCE_LABELS[source] })),
];

/**
 * Changes how a matter came in (CORE-18): pick the referrer (referrers listed first), or a source
 * when no contact referred it, or clear it. Closes with the choice, or `undefined` when cancelled.
 */
@Component({
  selector: 'mt-referral-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, IntakeContactPicker, MtButton, MtDialog, MtSelect],
  template: `
    <mt-dialog
      size="sm"
      [title]="'Referral for ' + data.number"
      description="Who referred the matter, or where it came from."
    >
      <div class="mt-col" style="gap: var(--space-16)">
        <mt-intake-contact-picker
          label="Referred by"
          createLabel="New referrer…"
          [referrersFirst]="true"
          [exclude]="data.exclude"
          (picked)="pick($event)"
        />
        <form
          id="mt-referral-form"
          class="mt-col"
          style="gap: var(--space-8)"
          (submit)="$event.preventDefault(); save()"
        >
          <mt-select
            label="Or the source"
            name="source"
            [native]="true"
            [options]="sources"
            [ngModel]="source()"
            (ngModelChange)="source.set($event ?? '')"
          />
        </form>
      </div>
      <ng-container mtDialogFooter>
        @if (data.hasReferral) {
          <button mtButton variant="ghost" (click)="close(null)">Clear referral</button>
        }
        <button mtButton variant="ghost" (click)="close(undefined)">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-referral-form" [disabled]="!source()">
          Save source
        </button>
      </ng-container>
    </mt-dialog>
  `,
})
export class ReferralDialog {
  protected readonly ref = injectDialogRef<ReferralDialogData, ReferralChoice | undefined>();
  protected readonly data = this.ref.data;
  protected readonly sources = SOURCE_OPTIONS;
  protected readonly source = signal<string>(this.data.source ?? '');

  protected close(choice: ReferralChoice | undefined): void {
    void this.ref.close(choice);
  }

  protected pick(picked: PickedContact): void {
    this.close({ contactId: picked.id, name: picked.contact.name });
  }

  protected save(): void {
    const parsed = ReferralSourceSchema.safeParse(this.source());
    if (parsed.success) this.close({ source: parsed.data });
  }
}
