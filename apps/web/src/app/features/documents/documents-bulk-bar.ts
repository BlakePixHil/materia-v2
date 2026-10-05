import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { MT_MENU, MtButton, MtIconButton } from '@materia/ui';

import { DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_LABELS, type DocumentCategory } from './documents-view';

/**
 * The floating bar for the selected documents (CORE-12): move them to a category (document.upload)
 * and remove or restore them (document.delete), through `documents-bulkUpdate`. Zip downloads of a
 * selection aren't built yet (ADR-028), so there is no download here: open a document to download it.
 */
@Component({
  selector: 'mt-documents-bulk-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MT_MENU, MtButton, MtIconButton],
  host: { role: 'region', 'aria-label': 'Bulk actions' },
  template: `
    <span class="label" role="status">{{ count() }} selected</span>
    @if (canMove()) {
      <button mtButton variant="ghost" size="sm" iconStart="list" [mtMenuTrigger]="categoryMenu" [disabled]="busy()">
        Move to category
      </button>
    }
    @if (canDelete()) {
      @if (removedSelected()) {
        <button mtButton variant="ghost" size="sm" iconStart="check" [disabled]="busy()" (click)="restore.emit()">
          Restore
        </button>
      }
      @if (liveSelected()) {
        <button mtButton variant="ghost" size="sm" iconStart="trash" [disabled]="busy()" (click)="remove.emit()">
          Remove
        </button>
      }
    }
    <button mtIconButton icon="x" size="sm" label="Clear selection" tooltipKbd="esc" (click)="clear.emit()"></button>

    <ng-template #categoryMenu>
      <mt-menu aria-label="Move to category">
        @for (category of categories; track category) {
          <button mtMenuItem (click)="move.emit(category)">{{ labels[category] }}</button>
        }
      </mt-menu>
    </ng-template>
  `,
  styles: `
    :host {
      position: fixed;
      left: 50%;
      bottom: var(--space-24);
      transform: translateX(-50%);
      z-index: 2;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-4);
      max-width: calc(100vw - 32px);
      padding: var(--space-6) var(--space-6) var(--space-6) 14px;
      border-radius: 10px;
      background: var(--bg-inverse);
      color: var(--text-inverse);
      box-shadow: var(--shadow-dialog);
    }
    .label {
      margin-right: var(--space-8);
      font: 500 13px/18px var(--font-sans);
    }
    :host ::ng-deep .mt-btn,
    :host ::ng-deep .mt-ibtn {
      color: var(--text-inverse);
    }
  `,
})
export class DocumentsBulkBar {
  readonly count = input.required<number>();
  readonly canMove = input(false);
  readonly canDelete = input(false);
  /** Some selected documents are live (they can be removed). */
  readonly liveSelected = input(false);
  /** Some selected documents are removed (they can be restored). */
  readonly removedSelected = input(false);
  readonly busy = input(false);

  readonly move = output<DocumentCategory>();
  readonly remove = output();
  readonly restore = output();
  readonly clear = output();

  protected readonly categories = DOCUMENT_CATEGORIES;
  protected readonly labels = DOCUMENT_CATEGORY_LABELS;
}
