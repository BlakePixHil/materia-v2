import { ChangeDetectionStrategy, Component, ViewEncapsulation } from '@angular/core';

import { formatPhone } from '@materia/domain';
import { injectDialogRef, MtBottomSheet, MtIcon } from '@materia/ui';

/** Someone to call or email about the matter: a client, executor or the like. */
export interface MatterPerson {
  contactId: string;
  name: string;
  /** Their role on the matter ("Executor"). */
  role: string;
  /** E.164. */
  phone: string | null;
  email: string | null;
}

export interface MatterActionsData {
  number: string;
  people: readonly MatterPerson[];
  canNote: boolean;
  canTime: boolean;
}

/** What the person picked that the matter screen does: a note or a time entry. Calls and emails leave the app. */
export type MatterAction = 'note' | 'time';

/**
 * A matter's actions on a phone (MOB-02), from the "…" in the top bar: add a note, log time, and call
 * or email the people the matter is for (`tel:` and `mailto:` links from their contact records).
 */
@Component({
  selector: 'mt-matter-actions-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../../../../../libs/ui/src/generated/components/mrow.css',
    '../../../../../../libs/ui/src/generated/components/mgroup.css',
  ],
  imports: [MtBottomSheet, MtIcon],
  host: { class: 'mt-matter-actions' },
  template: `
    <mt-bottom-sheet [title]="data.number">
      <div class="rows">
        @if (data.canNote) {
          <button type="button" class="mt-mrow" data-action="note" (click)="ref.close('note')">
            <mt-icon name="compose" />
            <span class="tt">Add note</span>
          </button>
        }
        @if (data.canTime) {
          <button type="button" class="mt-mrow" data-action="time" (click)="ref.close('time')">
            <mt-icon name="timer" />
            <span class="tt">Log time</span>
          </button>
        }
        <h3 class="mt-mgroup">Contact</h3>
        @for (person of data.people; track person.contactId) {
          @if (person.phone; as phone) {
            <a class="mt-mrow" data-action="call" [href]="'tel:' + phone" (click)="ref.close(null)">
              <mt-icon name="phone" />
              <span class="mt-grow">
                <span class="tt mt-ell">Call {{ person.name }}</span>
                <span class="ts">{{ person.role }} · {{ phoneText(phone) }}</span>
              </span>
            </a>
          }
          @if (person.email; as email) {
            <a class="mt-mrow" data-action="email" [href]="'mailto:' + email" (click)="ref.close(null)">
              <mt-icon name="mail" />
              <span class="mt-grow">
                <span class="tt mt-ell">Email {{ person.name }}</span>
                <span class="ts mt-ell">{{ person.role }} · {{ email }}</span>
              </span>
            </a>
          }
        }
        @if (!reachable) {
          <p class="caption t-3 none">
            No phone number or email for the client on this matter yet. Add them to their contact record.
          </p>
        }
      </div>
    </mt-bottom-sheet>
  `,
  styles: `
    .mt-matter-actions .rows {
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }
    .mt-matter-actions .mt-mrow .mt-grow {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .mt-matter-actions .none {
      margin: var(--space-8) 0 0;
    }
  `,
})
export class MatterActionsSheet {
  protected readonly ref = injectDialogRef<MatterActionsData, MatterAction | null>();
  protected readonly data = this.ref.data;
  protected readonly reachable = this.data.people.some((person) => person.phone || person.email);
  protected readonly phoneText = formatPhone;
}
