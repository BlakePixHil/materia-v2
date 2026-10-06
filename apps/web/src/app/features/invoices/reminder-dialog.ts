import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { injectDialogRef, MtButton, MtDialog, MtTextarea, MtTextField } from '@materia/ui';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 5;

export interface ReminderDialogData {
  number: string;
  owing: string;
  emails: string[];
  /** The drafted message (`reminderMessage`), to review and edit. */
  message: string;
}

export interface ReminderDialogResult {
  to: string[];
  message: string;
}

/**
 * Reviews a queued payment reminder before it goes (BILL-08): the clients' addresses and a drafted
 * message, both editable. Nothing is sent until Send is pressed; the invoice PDF goes with it.
 */
@Component({
  selector: 'mt-reminder-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtTextarea, MtTextField],
  template: `
    <mt-dialog size="md" [title]="'Payment reminder for ' + data.number" [description]="description">
      <form
        id="mt-reminder-form"
        class="mt-col"
        style="gap: var(--space-12)"
        (submit)="$event.preventDefault(); save()"
      >
        <mt-text-field
          name="to"
          label="To"
          inputmode="email"
          description="Separate addresses with commas."
          [error]="toError() ?? undefined"
          [ngModel]="to()"
          (ngModelChange)="to.set($event ?? ''); touched.set(true)"
        />
        <mt-textarea
          name="message"
          label="Message"
          [rows]="10"
          [maxLength]="4000"
          [error]="messageError() ?? undefined"
          [ngModel]="message()"
          (ngModelChange)="message.set($event ?? '')"
        />
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close(undefined)">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-reminder-form">Send reminder</button>
      </ng-container>
    </mt-dialog>
  `,
})
export class ReminderDialog {
  protected readonly ref = injectDialogRef<ReminderDialogData, ReminderDialogResult | undefined>();
  protected readonly data = this.ref.data;
  protected readonly description = `${this.data.owing} is owing. Edit the message as you need; the invoice PDF goes with it. Nothing is sent until you press Send.`;
  protected readonly to = signal(this.data.emails.join(', '));
  protected readonly message = signal(this.data.message);
  protected readonly touched = signal(false);

  private readonly addresses = computed(() =>
    this.to()
      .split(/[,;\s]+/)
      .map((address) => address.trim())
      .filter(Boolean),
  );
  protected readonly toError = computed(() => {
    const addresses = this.addresses();
    if (!addresses.length) return this.touched() ? 'Add an email address.' : null;
    const bad = addresses.find((address) => !EMAIL.test(address));
    if (bad) return `“${bad}” isn’t an email address.`;
    return addresses.length > MAX_RECIPIENTS ? `Send to up to ${MAX_RECIPIENTS} addresses.` : null;
  });
  protected readonly messageError = computed(() => (this.message().trim() ? null : 'Write the message.'));

  protected save(): void {
    this.touched.set(true);
    if (this.toError() || !this.addresses().length || this.messageError()) return;
    void this.ref.close({ to: this.addresses(), message: this.message().trim() });
  }
}
