import { ChangeDetectionStrategy, Component, inject, InjectionToken, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  contactListQuery,
  contactMatchesFilters,
  contactsRepository,
  type ContactListItem,
  type WithId,
} from '@materia/data-access/repository';
import { contactDisplayName } from '@materia/domain';
import { DialogService, formatDateOnly, MtButton, MtSearchField } from '@materia/ui';

import { intakeContact, type IntakeContact } from './intake-state';
import { errorCopy } from '../../core/error-copy';

/** A contact chosen in the picker. */
export interface PickedContact {
  id: string;
  contact: IntakeContact;
}

/** How long the search waits after typing stops (tests shorten it). */
export const CONTACT_SEARCH_DEBOUNCE_MS = new InjectionToken<number>('CONTACT_SEARCH_DEBOUNCE_MS', {
  providedIn: 'root',
  factory: () => 200,
});

/** Contacts listed for a search. */
const RESULTS = 6;

/**
 * Finds an existing contact by name, email or phone, or creates one with the contacts form
 * (CORE-01, which checks for duplicates first and may hand back an existing contact). Enter in the
 * search box doesn't move the intake on (`data-intake-enter="off"`).
 */
@Component({
  selector: 'mt-intake-contact-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtSearchField],
  host: { class: 'mt-col', style: 'gap: var(--space-8)', 'data-intake-enter': 'off' },
  template: `
    <mt-search-field
      [label]="label()"
      placeholder="Name, email or phone"
      [debounce]="debounce"
      [ngModel]="text()"
      (ngModelChange)="text.set($event ?? '')"
      (queryChange)="search($event)"
    />
    @if (searching()) {
      <p class="caption t-3" role="status">Searching…</p>
    } @else if (query().length >= 2) {
      <ul class="results" [attr.aria-label]="'Contacts matching ' + query()">
        @for (row of results(); track row.id) {
          <li>
            <button mtButton variant="ghost" size="sm" type="button" class="result" (click)="choose(row)">
              {{ name(row) }}
              @if (detail(row); as text) {
                <span class="caption t-3">{{ text }}</span>
              }
            </button>
          </li>
        } @empty {
          <li class="caption t-3">No contacts match “{{ query() }}”.</li>
        }
      </ul>
    }
    <div>
      <button mtButton variant="secondary" size="sm" type="button" iconStart="plus" (click)="create()">
        {{ createLabel() }}
      </button>
    </div>
    @if (error(); as message) {
      <p class="caption t-danger" role="alert">{{ message }}</p>
    }
  `,
  styles: `
    .results {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .result {
      width: 100%;
      justify-content: flex-start;
      gap: var(--space-8);
    }
    .t-danger {
      color: var(--text-danger);
      margin: 0;
    }
  `,
})
export class IntakeContactPicker {
  private readonly contacts = contactsRepository();
  private readonly dialogs = inject(DialogService);
  protected readonly debounce = inject(CONTACT_SEARCH_DEBOUNCE_MS);

  readonly label = input('Find a contact');
  readonly createLabel = input('New contact…');
  /** Contacts already chosen here (left out of the results). */
  readonly exclude = input<readonly string[]>([]);
  readonly picked = output<PickedContact>();

  protected readonly text = signal('');
  protected readonly query = signal('');
  protected readonly results = signal<WithId<ContactListItem>[]>([]);
  protected readonly searching = signal(false);
  protected readonly error = signal<string | null>(null);
  private searchRun = 0;

  protected readonly name = (row: ContactListItem) => contactDisplayName(row);

  protected detail(row: ContactListItem): string {
    if (row.dateOfDeath) return `Died ${formatDateOnly(row.dateOfDeath)}`;
    if (row.dateOfBirth) return `Born ${formatDateOnly(row.dateOfBirth)}`;
    return row.emails[0]?.address ?? '';
  }

  protected async search(text: string): Promise<void> {
    const query = text.trim();
    this.query.set(query);
    const run = ++this.searchRun;
    if (query.length < 2) {
      this.results.set([]);
      return;
    }
    this.searching.set(true);
    try {
      const rows = await this.contacts.query(contactListQuery({ query }, 50));
      if (run !== this.searchRun) return;
      const excluded = new Set(this.exclude());
      this.results.set(
        rows.filter((row) => !excluded.has(row.id) && contactMatchesFilters(row, { query })).slice(0, RESULTS),
      );
      this.error.set(null);
    } catch (error) {
      if (run === this.searchRun) this.error.set(errorCopy(error));
    } finally {
      if (run === this.searchRun) this.searching.set(false);
    }
  }

  protected choose(row: WithId<ContactListItem>): void {
    this.emit({ id: row.id, contact: intakeContact(row) });
  }

  private emit(picked: PickedContact): void {
    this.searchRun++;
    this.text.set('');
    this.query.set('');
    this.results.set([]);
    this.searching.set(false);
    this.picked.emit(picked);
  }

  /** The contacts form (CORE-01): its duplicate check may hand back an existing contact instead. */
  protected async create(): Promise<void> {
    const { ContactFormDialog } = await import('../contacts/contact-form-dialog');
    const result = await this.dialogs.open<object, { contactId: string } | undefined>(ContactFormDialog, {
      data: {},
    }).result;
    if (!result) return;
    const created = await this.contacts.get(result.contactId).catch(() => null);
    this.emit({
      id: result.contactId,
      contact: created ? intakeContact(created) : { kind: 'person', name: 'New contact' },
    });
  }
}
