import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { MATTER_STATUS_LABELS, type MatterStatus } from '@materia/domain';
import { MT_MENU, MtButton, MtIconButton } from '@materia/ui';

import { STATUS_ORDER } from './matters-view';

/** Someone a matter can be assigned to. */
export interface MatterAssignee {
  uid: string;
  name: string;
}

/**
 * The floating bar for the selected matters (CORE-03), as in the design's Matters list: assign,
 * add a label (`matter.edit`) and change status (`matter.status`).
 */
@Component({
  selector: 'mt-matters-bulk-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MT_MENU, MtButton, MtIconButton],
  host: { role: 'region', 'aria-label': 'Bulk actions' },
  template: `
    <span class="label" role="status">{{ count() === 1 ? '1 selected' : count() + ' selected' }}</span>
    @if (canEdit()) {
      <button mtButton variant="ghost" size="sm" iconStart="user" [mtMenuTrigger]="assignMenu" [disabled]="busy()">
        Assign
      </button>
      <button mtButton variant="ghost" size="sm" iconStart="plus" [disabled]="busy()" (click)="addLabel.emit()">
        Add label
      </button>
    }
    @if (canChangeStatus()) {
      <button
        mtButton
        variant="ghost"
        size="sm"
        iconStart="check-circle"
        [mtMenuTrigger]="statusMenu"
        [disabled]="busy()"
      >
        Change status
      </button>
    }
    <button mtIconButton icon="x" size="sm" label="Clear selection" tooltipKbd="esc" (click)="clear.emit()"></button>

    <ng-template #assignMenu>
      <mt-menu aria-label="Assign to">
        @for (person of assignees(); track person.uid) {
          <button mtMenuItem (click)="assign.emit(person.uid)">{{ person.name }}</button>
        }
      </mt-menu>
    </ng-template>
    <ng-template #statusMenu>
      <mt-menu aria-label="Change status to">
        @for (status of statuses; track status) {
          <button mtMenuItem (click)="changeStatus.emit(status)">{{ statusLabels[status] }}</button>
        }
      </mt-menu>
    </ng-template>
  `,
  styles: `
    :host {
      position: absolute;
      left: 50%;
      bottom: var(--space-24);
      transform: translateX(-50%);
      z-index: 2;
      display: flex;
      align-items: center;
      gap: var(--space-4);
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
export class MattersBulkBar {
  readonly count = input.required<number>();
  readonly assignees = input.required<readonly MatterAssignee[]>();
  readonly canEdit = input(false);
  readonly canChangeStatus = input(false);
  readonly busy = input(false);

  readonly assign = output<string>();
  readonly addLabel = output();
  readonly changeStatus = output<MatterStatus>();
  readonly clear = output();

  protected readonly statuses = STATUS_ORDER;
  protected readonly statusLabels = MATTER_STATUS_LABELS;
}
