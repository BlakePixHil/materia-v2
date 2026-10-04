import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  contactListQuery,
  contactMatchesFilters,
  contactsRepository,
  type ContactListItem,
  type MatterCallables,
  type WithId,
} from '@materia/data-access/repository';
import { contactDisplayName, type PartyResult, type PartyRole } from '@materia/domain';
import {
  DialogService,
  formatDateOnly,
  injectDialogRef,
  MtButton,
  MtDialog,
  MtNote,
  MtSearchField,
  MtSelect,
  MtTextField,
} from '@materia/ui';

import { PARTY_ROLE_OPTIONS } from './matter-view';
import { errorCopy } from '../../core/error-copy';

/** The party being edited. */
export interface EditedParty {
  id: string;
  contactId: string;
  role: PartyRole;
  share?: string | undefined;
  name: string;
}

export interface PartyDialogData {
  matterId: string;
  api: Pick<MatterCallables, 'upsertParty'>;
  /** Edit this party's role or share; absent to add a party. */
  party?: EditedParty;
}

/** Contacts listed for a search. */
const RESULTS = 8;

/**
 * Add a party to a matter, or change a party's role or share (CORE-06). Adding finds an existing
 * contact by name, email or phone, or creates one with the contacts form (CORE-01, with its
 * duplicate check). Saves through `matters-upsertParty`; refusals show in the dialog.
 */
@Component({
  selector: 'mt-party-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtNote, MtSearchField, MtSelect, MtTextField],
  template: `
    <mt-dialog [title]="data.party ? 'Edit ' + data.party.name : 'Add a party'" [closeOnOutsideClick]="false">
      <form id="mt-party-form" class="mt-col" style="gap: var(--space-16)" (submit)="$event.preventDefault(); save()">
        @if (!data.party) {
          @if (contact(); as chosen) {
            <div class="mt-row chosen" style="gap: var(--space-8); align-items: center">
              <span class="label mt-grow">{{ chosen.name }}</span>
              <button mtButton variant="ghost" size="sm" type="button" (click)="contact.set(null)">Change</button>
            </div>
          } @else {
            <div class="mt-col" style="gap: var(--space-8)">
              <mt-search-field
                label="Find a contact"
                placeholder="Name, email or phone"
                [debounce]="200"
                (queryChange)="search($event)"
              />
              @if (searching()) {
                <p class="caption t-3" role="status">Searching…</p>
              } @else if (query().length >= 2) {
                <ul class="results" aria-label="Contacts found">
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
              <button mtButton variant="secondary" size="sm" type="button" iconStart="plus" (click)="createContact()">
                New contact…
              </button>
              @if (contactError()) {
                <p class="caption" style="color: var(--text-danger)">{{ contactError() }}</p>
              }
            </div>
          }
        }
        <mt-select
          name="role"
          label="Role"
          [native]="true"
          [options]="roles"
          [ngModel]="role()"
          (ngModelChange)="role.set($event)"
        />
        @if (role() === 'beneficiary') {
          <mt-text-field
            name="share"
            label="Share"
            [optional]="true"
            description="For example “One half” or “Residue, equally”."
            [ngModel]="share()"
            (ngModelChange)="share.set($event ?? '')"
          />
        }
        @if (error(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-party-form" [loading]="saving()">
          {{ data.party ? 'Save' : 'Add party' }}
        </button>
      </ng-container>
    </mt-dialog>
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
  `,
})
export class PartyDialog {
  protected readonly ref = injectDialogRef<PartyDialogData, PartyResult | undefined>();
  protected readonly data = this.ref.data;
  private readonly contacts = contactsRepository();
  private readonly dialogs = inject(DialogService);

  protected readonly roles = PARTY_ROLE_OPTIONS;
  protected readonly role = signal<PartyRole>(this.data.party?.role ?? 'beneficiary');
  protected readonly share = signal(this.data.party?.share ?? '');
  protected readonly contact = signal<{ id: string; name: string } | null>(null);
  protected readonly query = signal('');
  protected readonly results = signal<WithId<ContactListItem>[]>([]);
  protected readonly searching = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly contactError = signal<string | null>(null);
  protected readonly contactId = computed(() => this.data.party?.contactId ?? this.contact()?.id ?? null);
  private searchRun = 0;

  protected readonly name = (row: ContactListItem) => contactDisplayName(row);

  protected detail(row: ContactListItem): string {
    if (row.dateOfBirth) return `Born ${formatDateOnly(row.dateOfBirth)}`;
    return row.emails[0]?.address ?? row.orgName ?? '';
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
      this.results.set(rows.filter((row) => contactMatchesFilters(row, { query })).slice(0, RESULTS));
    } catch (error) {
      if (run === this.searchRun) this.contactError.set(errorCopy(error));
    } finally {
      if (run === this.searchRun) this.searching.set(false);
    }
  }

  protected choose(row: WithId<ContactListItem>): void {
    this.contact.set({ id: row.id, name: contactDisplayName(row) });
    this.contactError.set(null);
  }

  /** The contacts form (CORE-01): its duplicate check may hand back an existing contact instead. */
  protected async createContact(): Promise<void> {
    const { ContactFormDialog } = await import('../contacts/contact-form-dialog');
    const result = await this.dialogs.open<object, { contactId: string } | undefined>(ContactFormDialog, {
      data: {},
    }).result;
    if (!result) return;
    const created = await this.contacts.get(result.contactId).catch(() => null);
    this.contact.set({ id: result.contactId, name: created ? contactDisplayName(created) : 'New contact' });
    this.contactError.set(null);
  }

  protected async save(): Promise<void> {
    const contactId = this.contactId();
    if (!contactId) {
      this.contactError.set('Choose a contact, or create one.');
      return;
    }
    if (this.saving()) return;
    const share = this.role() === 'beneficiary' ? this.share().trim() : '';
    this.saving.set(true);
    this.error.set(null);
    try {
      const result = await this.data.api.upsertParty({
        matterId: this.data.matterId,
        contactId,
        role: this.role(),
        ...(this.data.party ? { partyId: this.data.party.id } : {}),
        ...(share ? { share } : {}),
      });
      void this.ref.close(result);
    } catch (error) {
      this.error.set(errorCopy(error));
    } finally {
      this.saving.set(false);
    }
  }
}
