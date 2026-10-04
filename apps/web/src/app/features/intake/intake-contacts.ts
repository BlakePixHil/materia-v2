import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { MtIconButton } from '@materia/ui';

/** The contacts chosen for a field (clients, the other side, trustees), each with a remove button. */
@Component({
  selector: 'mt-intake-contacts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtIconButton],
  template: `
    @if (people().length) {
      <ul class="chosen" [attr.aria-label]="label()">
        @for (person of people(); track person.id) {
          <li>
            <span class="label mt-grow">{{ person.name }}</span>
            @if (person.note; as note) {
              <span class="caption t-3">{{ note }}</span>
            }
            <button
              mtIconButton
              icon="x"
              size="sm"
              type="button"
              [label]="'Remove ' + person.name"
              (click)="removed.emit(person.id)"
            ></button>
          </li>
        }
      </ul>
    } @else if (empty(); as text) {
      <p class="caption t-3 none">{{ text }}</p>
    }
  `,
  styles: `
    .chosen {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
    }
    .chosen li {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      padding: var(--space-6) var(--space-8) var(--space-6) var(--space-12);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }
    .none {
      margin: 0;
    }
  `,
})
export class IntakeContacts {
  readonly people = input.required<readonly { id: string; name: string; note?: string | undefined }[]>();
  readonly label = input.required<string>();
  readonly empty = input<string>();
  readonly removed = output<string>();
}
