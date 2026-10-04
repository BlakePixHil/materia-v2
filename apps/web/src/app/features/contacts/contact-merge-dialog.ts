import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import {
  contactListQuery,
  contactMatchesFilters,
  contactsRepository,
  type ContactListItem,
  type WithId,
} from '@materia/data-access/repository';
import { contactDisplayName, DomainError, type MergeContactsResult } from '@materia/domain';
import { injectDialogRef, MtButton, MtDialog, MtNote, MtSearchField } from '@materia/ui';

import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';

export interface ContactMergeDialogData {
  /** The contact that goes away (becomes a tombstone pointing at the one kept). */
  mergeId: string;
  name: string;
  /** Only contacts of the same kind can be merged (person into person). */
  kind: 'person' | 'organisation';
}

/** `contacts-merge` refusals, in words: `NOT_FOUND`, or `FAILED_PRECONDITION` with a `reason`. */
export function mergeErrorCopy(error: unknown): string {
  if (error instanceof DomainError) {
    const reason = error.details?.['reason'];
    if (error.code === 'NOT_FOUND') return 'That contact was deleted or merged in the meantime. Pick another.';
    if (reason === 'already_merged') return 'One of these contacts has already been merged. Reload and try again.';
    if (reason === 'kind_mismatch') {
      return 'A person can only be merged into a person, and an organisation into an organisation.';
    }
  }
  return errorCopy(error);
}

export interface ContactMergeDialogResult {
  keepId: string;
  queued: boolean;
}

/**
 * "Merge into…" (admins and owners, CORE-01): pick the contact to keep, then `contacts-merge`
 * re-points every reference and leaves this contact as a tombstone.
 */
@Component({
  selector: 'mt-contact-merge-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtDialog, MtNote, MtSearchField],
  template: `
    <mt-dialog
      [title]="'Merge ' + data.name + ' into…'"
      [description]="
        'Pick the contact to keep. ' +
        data.name +
        '’s matters, documents and history move to it, and ' +
        data.name +
        ' is removed from your contacts.'
      "
    >
      <div class="mt-col" style="gap: 12px">
        <mt-search-field
          label="Find the contact to keep"
          placeholder="Search contacts"
          (queryChange)="query.set($event)"
        />
        @if (candidates.status() === 'loading' && query()) {
          <p role="status" class="caption">Searching…</p>
        }
        <div class="mt-merge-list" role="radiogroup" aria-label="Contact to keep">
          @for (contact of results(); track contact.id) {
            <button
              type="button"
              role="radio"
              class="mt-merge-option"
              [attr.aria-checked]="keep()?.id === contact.id"
              [attr.data-selected]="keep()?.id === contact.id ? '' : null"
              (click)="keep.set(contact)"
            >
              <span class="label">{{ name(contact) }}</span>
              <span class="caption">{{ describe(contact) }}</span>
            </button>
          } @empty {
            @if (query()) {
              <p class="caption">No other contact matches “{{ query() }}”.</p>
            } @else {
              <p class="caption">Type a name, email or phone number.</p>
            }
          }
        </div>
        @if (merge.error(); as error) {
          <mt-note tone="danger">{{ copy(error) }}</mt-note>
        }
      </div>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button mtButton variant="danger" [disabled]="!keep()" [loading]="merge.pending()" (click)="confirm()">
          {{ keep() ? 'Merge into ' + name(keep()!) : 'Merge' }}
        </button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .mt-merge-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      max-height: 280px;
      overflow: auto;
    }
    .mt-merge-option {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      padding: var(--space-8) var(--space-12);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md, 8px);
      background: var(--bg-surface);
      color: var(--text-primary);
      text-align: left;
      cursor: pointer;
    }
    .mt-merge-option[data-selected] {
      border-color: var(--border-brand, var(--bg-brand));
      background: var(--bg-selected);
    }
    .mt-merge-option .caption,
    .mt-merge-list > .caption {
      color: var(--text-secondary);
    }
  `,
})
export class ContactMergeDialog {
  protected readonly ref = injectDialogRef<ContactMergeDialogData, ContactMergeDialogResult>();
  protected readonly data = this.ref.data;
  protected readonly merge = inject(CALLABLES).action<{ keepId: string; mergeId: string }, MergeContactsResult>(
    'contacts-merge',
  );
  protected readonly query = signal('');
  protected readonly keep = signal<WithId<ContactListItem> | null>(null);
  protected readonly candidates = contactsRepository().watchQuery(
    () => (this.query().trim() ? contactListQuery({ query: this.query() }, 20) : null),
    { live: false },
  );
  protected readonly results = computed(() =>
    this.query().trim()
      ? this.candidates
          .value()
          .filter(
            (contact) =>
              contact.id !== this.data.mergeId &&
              contactMatchesFilters(contact, { query: this.query(), kind: this.data.kind }),
          )
      : [],
  );

  protected name(contact: ContactListItem): string {
    return contactDisplayName(contact);
  }

  protected describe(contact: ContactListItem): string {
    const email = contact.emails[0]?.address;
    const born = contact.dateOfBirth ? `born ${contact.dateOfBirth.split('-').reverse().join('/')}` : null;
    return [contact.kind === 'organisation' ? 'Organisation' : 'Person', born, email].filter(Boolean).join(' · ');
  }

  protected copy(error: unknown): string {
    return mergeErrorCopy(error);
  }

  protected async confirm(): Promise<void> {
    const keep = this.keep();
    if (!keep) return;
    try {
      const result = await this.merge.run({ keepId: keep.id, mergeId: this.data.mergeId });
      void this.ref.close({ keepId: keep.id, queued: result.queued });
    } catch {
      // Shown from merge.error(); a retry re-uses the request id.
    }
  }
}
