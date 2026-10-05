import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { injectDialogRef, MtButton, MtDialog, MtTextField } from '@materia/ui';

export interface MatterNameDialogData {
  title: string;
  /** The field's label ("View name", "Label"). */
  label: string;
  /** The confirm button ("Save view"). */
  confirm: string;
  description?: string;
  initial?: string;
  maxLength?: number;
  /** The field may be left empty (closes with ''), to clear a value. */
  optional?: boolean;
  /**
   * Runs on confirm; a message it returns (or throws) shows under the field and keeps the dialog
   * open. The dialog closes with the name when it resolves without one.
   */
  submit?: (name: string) => Promise<string | undefined>;
}

/**
 * Asks for one short name (CORE-03): a saved view's name when saving or renaming it, or a label to
 * add to the selected matters. Closes with the trimmed name, or `undefined` when cancelled.
 */
@Component({
  selector: 'mt-matter-name-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtTextField],
  template: `
    <mt-dialog size="sm" [title]="data.title" [description]="data.description">
      <form id="mt-matter-name-form" (submit)="$event.preventDefault(); save()">
        <mt-text-field
          name="name"
          [label]="data.label"
          [required]="!data.optional"
          [error]="error() ?? undefined"
          [ngModel]="name()"
          (ngModelChange)="name.set($event ?? ''); error.set(null)"
        />
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="close()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-matter-name-form" [loading]="busy()">
          {{ data.confirm }}
        </button>
      </ng-container>
    </mt-dialog>
  `,
})
export class MatterNameDialog {
  protected readonly ref = injectDialogRef<MatterNameDialogData, string | undefined>();
  protected readonly data = this.ref.data;
  protected readonly name = signal(this.data.initial ?? '');
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected close(value?: string): void {
    void this.ref.close(value);
  }

  protected async save(): Promise<void> {
    const name = this.name().trim();
    const max = this.data.maxLength ?? 60;
    if (!name && this.data.optional) {
      this.close('');
      return;
    }
    if (!name) {
      this.error.set(`Enter a ${this.data.label.toLowerCase()}.`);
      return;
    }
    if (name.length > max) {
      this.error.set(`Keep it to ${max} characters or fewer.`);
      return;
    }
    if (this.data.submit) {
      this.busy.set(true);
      try {
        const problem = await this.data.submit(name);
        if (problem) {
          this.error.set(problem);
          return;
        }
      } catch (error) {
        this.error.set(error instanceof Error ? error.message : 'That didn’t save. Try again.');
        return;
      } finally {
        this.busy.set(false);
      }
    }
    this.close(name);
  }
}
