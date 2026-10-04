import { ChangeDetectionStrategy, Component, input, output, ViewEncapsulation } from '@angular/core';

import type { MatterType, Priority } from '@materia/domain';

import type { MtStatusKind } from '../../generated/icons';
import { type DeadlineVm, MtDeadlineChip } from '../deadline-chip/deadline-chip';
import { MtIcon } from '../icon/icon';
import { MtAvatarGroup, type MtAvatarPerson, MtMatterTag, MtPriorityIcon, MtStatusIcon } from '../markers/markers';
import { MtTooltip } from '../tooltip/tooltip';

/** What a MatterCard shows. Feature code maps a matter to this. */
export interface MatterCardVm {
  id: string;
  /** Matter number, such as "WE-142". */
  ref: string;
  title: string;
  client?: string | undefined;
  type: MatterType;
  status: MtStatusKind;
  /** The current stage, for the status icon's label ("Notice period"). */
  stage?: string | undefined;
  priority?: Priority | undefined;
  nextDeadline?: DeadlineVm | null | undefined;
  people?: readonly MtAvatarPerson[] | undefined;
  /** A Clerk suggestion shown under the card ("Notice can be published today"). */
  clerkHint?: string | undefined;
}

/**
 * MatterCard (`mt-matter-card`): a matter on the board. The title is the card's button (it emits
 * `open`); long titles and client names truncate with a tooltip. Drag handles and drop behaviour are
 * added by the board (CORE-04).
 */
@Component({
  selector: 'mt-matter-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/matter.css', '../../generated/components/layout.css'],
  imports: [MtIcon, MtDeadlineChip, MtAvatarGroup, MtMatterTag, MtPriorityIcon, MtStatusIcon, MtTooltip],
  host: { class: 'mt-matter-card', '[attr.data-id]': 'matter().id', '(click)': 'onCardClick($event)' },
  template: `
    <div class="top">
      <mt-status-icon [status]="matter().status" [label]="matter().stage ?? matter().status" />
      <span>{{ matter().ref }}</span>
      @if (matter().priority; as level) {
        @if (level !== 'none') {
          <span class="mt-ml"><mt-priority-icon [level]="level" /></span>
        }
      }
    </div>
    <div class="titles">
      <button type="button" class="name mt-ell" [mtTooltip]="matter().title" (click)="open.emit()">
        {{ matter().title }}
      </button>
      @if (matter().client; as client) {
        <span class="client mt-ell" [mtTooltip]="client">{{ client }}</span>
      }
    </div>
    <div class="meta">
      <mt-matter-tag [type]="matter().type" />
      @if (matter().nextDeadline; as deadline) {
        <mt-deadline-chip
          [due]="deadline.due"
          [completed]="!!deadline.completed"
          [critical]="!!deadline.critical"
          [trace]="deadline.trace"
        />
      }
      @if (matter().people?.length) {
        <span class="mt-ml"><mt-avatar-group [people]="matter().people ?? []" size="xs" /></span>
      }
    </div>
    @if (matter().clerkHint; as hint) {
      <div class="hint">
        <mt-icon name="sparkle" /><span><span class="mt-sr">Clerk: </span>{{ hint }}</span>
      </div>
    }
  `,
})
export class MtMatterCard {
  readonly matter = input.required<MatterCardVm>();
  /** The card (or its title) was activated. */
  readonly open = output();

  /** A click anywhere on the card opens it, except on its own controls. */
  protected onCardClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, [tabindex]:not([tabindex="-1"])')) return;
    this.open.emit();
  }
}
