import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { parseBoardWipLimit } from '@materia/domain';
import { injectDialogRef, MtButton, MtDialog, MtTextField } from '@materia/ui';

export interface WipLimitDialogData {
  /** The column's title ("Open", "Grant application"). */
  column: string;
  /** Its limit now, if it has one. */
  initial?: number;
}

/**
 * Sets a Matters board column's WIP limit (CORE-04a). Closes with the limit, or `undefined` when
 * cancelled; removing a limit is its own item in the column menu.
 */
@Component({
  selector: 'mt-wip-limit-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtTextField],
  template: `
    <mt-dialog
      size="sm"
      [title]="'WIP limit for ' + data.column"
      description="The board warns when a move takes the column past this many matters. It counts the matters the board shows, so filters change the count."
    >
      <form id="mt-wip-limit-form" (submit)="$event.preventDefault(); save()">
        <mt-text-field
          name="limit"
          label="Most matters in the column"
          inputmode="numeric"
          [required]="true"
          [error]="error() ?? undefined"
          [ngModel]="text()"
          (ngModelChange)="text.set($event ?? ''); error.set(null)"
        />
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="close()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-wip-limit-form">Save limit</button>
      </ng-container>
    </mt-dialog>
  `,
})
export class WipLimitDialog {
  protected readonly ref = injectDialogRef<WipLimitDialogData, number | undefined>();
  protected readonly data = this.ref.data;
  protected readonly text = signal(this.data.initial ? String(this.data.initial) : '');
  protected readonly error = signal<string | null>(null);

  protected close(value?: number): void {
    void this.ref.close(value);
  }

  protected save(): void {
    const parsed = parseBoardWipLimit(this.text());
    if ('error' in parsed) {
      this.error.set(parsed.error);
      return;
    }
    this.close(parsed.limit);
  }
}
