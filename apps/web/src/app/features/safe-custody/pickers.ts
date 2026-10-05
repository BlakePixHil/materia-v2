import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  type Signal,
} from '@angular/core';

import {
  contactListQuery,
  contactMatchesFilters,
  contactPartiesQuery,
  contactPartiesRepository,
  contactsRepository,
  matterDocumentRepository,
  matterDocumentsQuery,
  matterSummariesRepository,
  type ContactListItem,
  type WithId,
} from '@materia/data-access/repository';
import { contactDisplayName } from '@materia/domain';
import { DialogService, formatDateOnly, MtButton, MtSearchField, type MtOption } from '@materia/ui';

import { errorCopy } from '../../core/error-copy';

/** A contact chosen in a picker. */
export interface ChosenContact {
  id: string;
  name: string;
  /** Whether a person (testators must be). */
  person: boolean;
}

const RESULTS = 6;

/**
 * Finds a contact by name, email or phone, or creates one with the contacts form (CORE-01, which
 * checks for duplicates). Shows the chosen contact with a Change button.
 */
@Component({
  selector: 'mt-sc-contact-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtSearchField],
  template: `
    @if (chosen(); as contact) {
      <div class="mt-row" style="gap: var(--space-8); align-items: center">
        <span class="caption t-3">{{ label() }}</span>
        <span class="label mt-grow" data-testid="chosen-contact">{{ contact.name }}</span>
        <button mtButton variant="ghost" size="sm" type="button" (click)="picked.emit(null)">Change</button>
      </div>
    } @else {
      <div class="mt-col" style="gap: var(--space-8)">
        <mt-search-field
          [label]="label()"
          placeholder="Name, email or phone"
          [debounce]="debounce()"
          (queryChange)="search($event)"
        />
        @if (searching()) {
          <p class="caption t-3" role="status">Searching…</p>
        } @else if (query().length >= 2) {
          <ul class="results" [attr.aria-label]="label() + ': contacts found'">
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
        <button mtButton variant="secondary" size="sm" type="button" iconStart="plus" (click)="create()">
          New contact…
        </button>
        @if (error() || problem(); as message) {
          <p class="caption" style="color: var(--text-danger)">{{ message }}</p>
        }
      </div>
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
  `,
})
export class SafeCustodyContactPicker {
  readonly label = input.required<string>();
  readonly chosen = input<ChosenContact | null>(null);
  /** A field error from the form ("Choose the testator"). */
  readonly error = input<string | null>(null);
  readonly debounce = input(200);
  readonly picked = output<ChosenContact | null>();

  private readonly contacts = contactsRepository();
  private readonly dialogs = inject(DialogService);
  protected readonly query = signal('');
  protected readonly results = signal<WithId<ContactListItem>[]>([]);
  protected readonly searching = signal(false);
  protected readonly problem = signal<string | null>(null);
  private run = 0;

  protected readonly name = (row: ContactListItem) => contactDisplayName(row);

  protected detail(row: ContactListItem): string {
    if (row.dateOfDeath) return `Died ${formatDateOnly(row.dateOfDeath)}`;
    if (row.dateOfBirth) return `Born ${formatDateOnly(row.dateOfBirth)}`;
    return row.emails[0]?.address ?? row.orgName ?? '';
  }

  protected async search(text: string): Promise<void> {
    const query = text.trim();
    this.query.set(query);
    const run = ++this.run;
    if (query.length < 2) {
      this.results.set([]);
      return;
    }
    this.searching.set(true);
    try {
      const rows = await this.contacts.query(contactListQuery({ query }, 50));
      if (run !== this.run) return;
      this.results.set(rows.filter((row) => contactMatchesFilters(row, { query })).slice(0, RESULTS));
    } catch (error) {
      if (run === this.run) this.problem.set(errorCopy(error));
    } finally {
      if (run === this.run) this.searching.set(false);
    }
  }

  protected choose(row: WithId<ContactListItem>): void {
    this.problem.set(null);
    this.picked.emit({ id: row.id, name: contactDisplayName(row), person: row.kind === 'person' });
  }

  protected async create(): Promise<void> {
    const { ContactFormDialog } = await import('../contacts/contact-form-dialog');
    const result = await this.dialogs.open<object, { contactId: string } | undefined>(ContactFormDialog, { data: {} })
      .result;
    if (!result) return;
    const created = await this.contacts.get(result.contactId).catch(() => null);
    this.picked.emit({
      id: result.contactId,
      name: created ? contactDisplayName(created) : 'New contact',
      person: created ? created.kind === 'person' : true,
    });
  }
}

/**
 * The matters a contact is on (from their `parties` rows), as select options "M-2026-0142 · Will of
 * …", plus `extra` (the packet's will matter). Matters the reader can't open are left out. Call in
 * an injection context.
 */
export function contactMatterOptions(
  contactId: Signal<string | null>,
  extra: Signal<string | null | undefined> = signal(null),
): Signal<MtOption<string>[]> {
  const parties = contactPartiesRepository().watchQuery(() => {
    const id = contactId();
    return id ? contactPartiesQuery(id) : null;
  });
  const matters = matterSummariesRepository();
  const titles = signal<ReadonlyMap<string, string | null>>(new Map());
  const requested = new Set<string>();
  const ids = computed(() => {
    const set = new Set(parties.value().map((party) => party.matterId));
    const more = extra();
    if (more) set.add(more);
    return [...set];
  });
  effect(() => {
    const wanted = ids();
    untracked(() => {
      for (const id of wanted) {
        if (requested.has(id)) continue;
        requested.add(id);
        void matters
          .get(id)
          .then((matter) => (matter && !matter.deletedAt ? `${matter.number} · ${matter.title}` : null))
          .catch(() => null)
          .then((label) => titles.update((map) => new Map(map).set(id, label)));
      }
    });
  });
  return computed(() =>
    ids().flatMap((id) => {
      const label = titles().get(id);
      return label ? [{ value: id, label }] : [];
    }),
  );
}

/**
 * A matter's live documents as select options (scanned clean ones only: the server refuses others
 * as an authority). Privileged documents only when the reader may see them. Call in an injection
 * context.
 */
export function matterDocumentOptions(
  matterId: Signal<string | null>,
  privilegedVisible: Signal<boolean>,
): { options: Signal<MtOption<string>[]>; loading: Signal<boolean> } {
  const documents = matterDocumentRepository(() => matterId()).watchQuery(() =>
    matterId() ? matterDocumentsQuery({ privilegedVisible: privilegedVisible() }) : null,
  );
  return {
    options: computed(() =>
      documents
        .value()
        .filter((doc) => !doc.deletedAt && doc.scan.status === 'clean')
        .map((doc) => ({ value: doc.id, label: doc.name })),
    ),
    loading: computed(() => !!matterId() && documents.status() === 'loading'),
  };
}
