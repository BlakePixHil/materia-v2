import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';

import { injectDialogRef, MtBottomSheet, MtButton, MtDialog, MtIcon } from '@materia/ui';

export interface InstallInstructionsData {
  /** A bottom sheet on a phone, a dialog on an iPad. */
  sheet: boolean;
}

/**
 * Add to Home Screen, step by step (MOB-01): iOS has no install prompt, so "Install Materia"
 * explains Safari's Share menu instead. Loaded the first time it opens.
 */
@Component({
  selector: 'mt-install-instructions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, MtBottomSheet, MtButton, MtDialog, MtIcon],
  template: `
    <ng-template #steps>
      <ol class="steps">
        <li>
          <mt-icon name="share" />
          <span>Tap <b>Share</b> in Safari’s toolbar.</span>
        </li>
        <li>
          <mt-icon name="square-plus" />
          <span>Scroll down and tap <b>Add to Home Screen</b>.</span>
        </li>
        <li>
          <mt-icon name="check" />
          <span>Tap <b>Add</b>. Materia opens from your Home Screen like any other app.</span>
        </li>
      </ol>
    </ng-template>
    @if (data.sheet) {
      <mt-bottom-sheet [title]="title">
        <ng-container [ngTemplateOutlet]="steps" />
        <button mtButton variant="primary" (click)="ref.close()">Done</button>
      </mt-bottom-sheet>
    } @else {
      <mt-dialog size="sm" [title]="title">
        <ng-container [ngTemplateOutlet]="steps" />
        <ng-container mtDialogFooter>
          <button mtButton variant="primary" (click)="ref.close()">Done</button>
        </ng-container>
      </mt-dialog>
    }
  `,
  styles: `
    .steps {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 14px;
      font: 400 15px/22px var(--font-sans);
      color: var(--text-primary);
    }
    .steps li {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .steps mt-icon {
      flex: none;
      margin-top: 2px;
      color: var(--icon-brand);
    }
  `,
})
export class InstallInstructions {
  protected readonly ref = injectDialogRef<InstallInstructionsData>();
  protected readonly data = this.ref.data;
  protected readonly title = 'Install Materia on this device';
}
