import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { can } from '@materia/data-access';
import {
  contactListQuery,
  contactMatchesFilters,
  contactsRepository,
  type ContactFilters,
  type ContactListItem,
  type WithId,
} from '@materia/data-access/repository';
import {
  contactDisplayName,
  formatPhone,
  PARTY_ROLE_ORDER,
  REFERRER_INDUSTRIES,
  REFERRER_INDUSTRY_LABELS,
  type PartyRole,
  type ReferrerIndustry,
} from '@materia/domain';
import {
  DialogService,
  MtAvatar,
  MtButton,
  MtEmptyState,
  MtNote,
  MtSearchField,
  MtSelect,
  MtTable,
  MtTableCell,
  ToastService,
  type MtOption,
  type MtTableColumn,
} from '@materia/ui';

import { ContactDeleteDialog, type ContactDeleteDialogData } from './contact-delete-dialog';
import { ContactDetail } from './contact-detail';
import { PARTY_ROLE_LABELS } from './contact-form';
import { ContactFormDialog, type ContactFormDialogData, type ContactFormDialogResult } from './contact-form-dialog';
import { ContactMergeDialog, type ContactMergeDialogData, type ContactMergeDialogResult } from './contact-merge-dialog';
import { ReferralSettings } from './referral-settings';
import { CommandRegistry } from '../../core/commands/command-registry';
import { onIntent } from '../../core/commands/intents';
import { recentRecorder } from '../../core/commands/recents';
import { errorCopy } from '../../core/error-copy';
import { MtExportButton } from '../../core/exports/export-button';
import { MtPageOfflineNote } from '../../core/pwa/offline-banner';
import { ShortcutService } from '../../core/shortcuts/shortcut.service';
import { MtPageActions } from '../../shell/page-header';

type Row = WithId<ContactListItem>;

/** The Referrers filter's industry facet (CORE-18). */
const INDUSTRY_FILTERS: MtOption<string>[] = [
  { value: '', label: 'Any industry' },
  ...REFERRER_INDUSTRIES.map((industry) => ({ value: industry, label: REFERRER_INDUSTRY_LABELS[industry] })),
];

/** The "Role in matters" filter (CORE-01a): a role the contact holds on a live, unprivileged matter. */
const ROLE_FILTERS: MtOption<string>[] = [
  { value: '', label: 'Any role' },
  ...PARTY_ROLE_ORDER.map((role) => ({ value: role, label: PARTY_ROLE_LABELS[role] })),
];

const KIND_FILTERS: MtOption<string>[] = [
  { value: '', label: 'All' },
  { value: 'person', label: 'People' },
  { value: 'organisation', label: 'Organisations' },
];

/**
 * Contacts (`/contacts`, CORE-01): a searchable, filterable list beside the selected contact's
 * detail pane, as in the design system's Contacts screen. Keyboard: `c` creates, `/` searches,
 * `j`/`k` move the selection (and Enter opens a focused row). The selection is in the URL
 * (`?contact=<id>`), so a contact can be linked to.
 */
@Component({
  selector: 'mt-contacts-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MtPageOfflineNote,
    FormsModule,
    MtAvatar,
    MtButton,
    MtEmptyState,
    MtExportButton,
    MtNote,
    MtPageActions,
    MtSearchField,
    MtSelect,
    MtTable,
    MtTableCell,
    ContactDetail,
    ReferralSettings,
  ],
  host: { class: 'mt-contacts' },
  template: `
    <ng-template mtPageActions>
      <mt-export-button kind="contacts" [filters]="exportFilters()" />
      @if (canEdit()) {
        <button mtButton variant="primary" size="sm" iconStart="plus" kbd="c" (click)="create()">New contact</button>
      }
    </ng-template>
    <h1 class="mt-sr">Contacts</h1>

    <section class="mt-contacts-list" aria-label="Contact list">
      <div class="mt-contacts-filters">
        <mt-search-field
          #search
          label="Search contacts"
          placeholder="Search contacts"
          shortcut="/"
          (queryChange)="query.set($event)"
        />
        <div class="mt-contacts-chips" role="group" aria-label="Show">
          @for (option of kindFilters; track option.value) {
            <button
              type="button"
              class="mt-chip"
              [attr.data-selected]="kind() === option.value && !referrersOnly() ? '' : null"
              [attr.aria-pressed]="kind() === option.value && !referrersOnly()"
              (click)="kind.set(option.value); referrersOnly.set(false)"
            >
              {{ option.label }}
            </button>
          }
          <button
            type="button"
            class="mt-chip"
            [attr.data-selected]="referrersOnly() ? '' : null"
            [attr.aria-pressed]="referrersOnly()"
            (click)="referrersOnly.set(!referrersOnly()); industry.set('')"
          >
            Referrers
          </button>
        </div>
        @if (referrersOnly()) {
          <mt-select
            label="Industry"
            [native]="true"
            [options]="industryFilters"
            [ngModel]="industry()"
            (ngModelChange)="industry.set($event ?? '')"
          />
          <mt-referral-settings />
        }
        <div class="mt-contacts-selects">
          <mt-select
            label="Role in matters"
            [native]="true"
            [options]="roleFilters"
            [ngModel]="role()"
            (ngModelChange)="role.set($event ?? '')"
          />
          @if (tagOptions().length > 1) {
            <mt-select
              label="Tag"
              [native]="true"
              [options]="tagOptions()"
              [ngModel]="tag()"
              (ngModelChange)="tag.set($event ?? '')"
            />
          }
        </div>
      </div>

      <div class="mt-contacts-rows">
        @switch (listState()) {
          @case ('error') {
            <mt-note tone="danger">
              {{ listError() }}
              <button mtButton size="sm" (click)="contacts.refresh()">Try again</button>
            </mt-note>
          }
          @case ('offline') {
            <mt-note role="status" mtPageOfflineNote>
              {{
                rows().length
                  ? 'You’re offline. These are your contacts as they were when you were last connected.'
                  : 'You’re offline. Contacts will load when you reconnect.'
              }}
            </mt-note>
          }
          @case ('loading') {
            <p role="status" class="mt-contacts-muted">Loading contacts…</p>
          }
        }
        @if (contacts.newItems(); as count) {
          <button mtButton size="sm" (click)="contacts.refresh()">
            {{ count === 1 ? '1 new contact' : count + ' new contacts' }}
          </button>
        }
        @if (listState() !== 'loading' && listState() !== 'error') {
          <mt-table
            #table
            label="Contacts"
            density="compact"
            [rows]="rows()"
            [columns]="columns"
            [rowKey]="rowKey"
            [rowLabel]="rowLabel"
            [selection]="selection()"
            (open)="select($event.id)"
            (focusin)="onRowFocus($event)"
          >
            <ng-template mtCell="name" let-cell>
              @let row = asRow(cell);
              <span class="mt-contacts-cell">
                <mt-avatar
                  size="sm"
                  [name]="label(row)"
                  [colorKey]="row.id"
                  [kind]="row.kind === 'organisation' ? 'org' : 'person'"
                />
                <span class="mt-col" style="min-width: 0">
                  <span class="mt-contacts-name mt-ell">{{ label(row) }}{{ row.dateOfDeath ? ' (dec.)' : '' }}</span>
                  @if (caption(row); as text) {
                    <span class="mt-contacts-caption mt-ell">{{ text }}</span>
                  }
                </span>
              </span>
            </ng-template>
            <div mtTableEmpty>
              @if (filtered()) {
                <mt-empty-state
                  title="No contacts match"
                  description="Try another name, or clear the filters."
                  icon="search"
                  [headingLevel]="2"
                />
              } @else {
                <mt-empty-state
                  title="No contacts yet"
                  description="Clients, executors, beneficiaries and referrers you add show here."
                  icon="contacts"
                  [headingLevel]="2"
                >
                  @if (canEdit()) {
                    <button mtButton variant="primary" size="sm" iconStart="plus" (click)="create()">
                      New contact
                    </button>
                  }
                </mt-empty-state>
              }
            </div>
          </mt-table>
        }
        @if (contacts.hasMore()) {
          <button mtButton size="sm" [loading]="contacts.loadingMore()" (click)="contacts.loadMore()">
            Show more contacts
          </button>
        }
      </div>
    </section>

    <section class="mt-contacts-detail" aria-label="Contact details">
      @if (selectedId(); as id) {
        <mt-contact-detail
          [contactId]="id"
          (openContact)="select($event)"
          (edit)="edit($event)"
          (merge)="mergeInto($event)"
          (remove)="remove($event)"
        />
      } @else if (listState() === 'list') {
        <mt-empty-state
          title="Pick a contact"
          description="Choose someone from the list, or press j and k to move through it."
          icon="user"
          [headingLevel]="2"
        />
      }
    </section>
  `,
  styles: `
    /* Full-bleed two panes, as the design's Contacts screen: the list beside the detail. */
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
      /* Full-bleed: cancels the shell page's padding. */
      margin: calc(-1 * var(--space-24)) calc(-1 * var(--space-32)) calc(-1 * var(--space-32));
    }
    .mt-contacts-list {
      flex: none;
      width: 380px;
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-right: 1px solid var(--border-default);
    }
    .mt-contacts-filters {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: var(--space-12);
      border-bottom: 1px solid var(--border-default);
    }
    .mt-contacts-selects {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: var(--space-8);
    }
    .mt-contacts-chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-6);
    }
    .mt-chip {
      display: inline-flex;
      align-items: center;
      height: 28px;
      padding: 0 10px;
      border-radius: var(--radius-full);
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      font: 500 12px/16px var(--font-sans);
      color: var(--text-secondary);
      cursor: pointer;
      white-space: nowrap;
    }
    .mt-chip:hover {
      border-color: var(--border-strong);
      color: var(--text-primary);
    }
    .mt-chip[data-selected] {
      background: var(--bg-selected);
      border-color: var(--border-focus);
      color: var(--text-brand);
    }
    .mt-chip:focus-visible {
      box-shadow: var(--focus-ring);
      outline: none;
    }
    .mt-contacts-rows {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: var(--space-8);
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-contacts-name {
      font: 500 13px/18px var(--font-sans);
      color: var(--text-primary);
    }
    .mt-contacts-caption {
      font: 400 12px/16px var(--font-sans);
      color: var(--text-tertiary);
    }
    /* The list reads as rows of people, as in the design: no header line or cell borders. */
    .mt-contacts-rows ::ng-deep thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    .mt-contacts-rows ::ng-deep .mt-table td {
      height: auto;
      padding: var(--space-8) var(--space-12);
      border-bottom: 0;
    }
    .mt-contacts-rows ::ng-deep .mt-table td:first-child {
      border-radius: 6px 0 0 6px;
    }
    .mt-contacts-rows ::ng-deep .mt-table td:last-child {
      border-radius: 0 6px 6px 0;
    }
    .mt-contacts-detail {
      flex: 1;
      min-width: 0;
      overflow-y: auto;
      padding: var(--space-24) var(--space-32) var(--space-32);
    }
    .mt-contacts-cell {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      padding: 2px 0;
    }
    .mt-contacts-muted {
      margin: 0;
      color: var(--text-tertiary);
    }
    @media (max-width: 900px) {
      :host {
        flex-direction: column;
        margin: 0;
      }
      .mt-contacts-list {
        width: auto;
        border-right: 0;
      }
      .mt-contacts-detail {
        padding: var(--space-16) 0 0;
      }
    }
  `,
})
export class ContactsPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);

  protected readonly canEdit = can('contact.edit');
  protected readonly kindFilters = KIND_FILTERS;
  protected readonly query = signal('');
  protected readonly kind = signal('');
  protected readonly tag = signal('');
  protected readonly referrersOnly = signal(false);
  protected readonly industryFilters = INDUSTRY_FILTERS;
  protected readonly industry = signal('');
  protected readonly roleFilters = ROLE_FILTERS;
  protected readonly role = signal('');
  private readonly filters = computed<ContactFilters>(() => ({
    query: this.query(),
    kind: (this.kind() || null) as 'person' | 'organisation' | null,
    tag: this.tag() || null,
    referrersOnly: this.referrersOnly(),
    industry: this.referrersOnly() ? ((this.industry() || null) as ReferrerIndustry | null) : null,
    role: (this.role() || null) as PartyRole | null,
  }));
  /** What Export writes: the contacts the list's filters match (INS-03). */
  protected readonly exportFilters = computed(() => ({ ...this.filters(), query: this.query().trim() || null }));
  protected readonly filtered = computed(() => {
    const f = this.filters();
    return !!(f.query?.trim() || f.kind || f.tag || f.referrersOnly || f.role);
  });

  /** The live list: one Firestore filter (see `contactListQuery`), the rest applied here. */
  protected readonly contacts = contactsRepository().watchQuery(() => contactListQuery(this.filters()));
  protected readonly rows = computed(() =>
    this.contacts.value().filter((row) => contactMatchesFilters(row, this.filters())),
  );
  protected readonly listState = computed(() => {
    const status = this.contacts.status();
    if (status !== 'ready') return status;
    return this.rows().length ? 'list' : 'empty';
  });
  protected readonly listError = computed(() => errorCopy(this.contacts.error()));
  /** Tags seen on the loaded contacts (and the one filtered by), for the Tag filter. */
  protected readonly tagOptions = computed<MtOption<string>[]>(() => {
    const tags = new Set(this.contacts.value().flatMap((row) => row.tags));
    if (this.tag()) tags.add(this.tag());
    return [{ value: '', label: 'Any tag' }, ...[...tags].sort().map((tag) => ({ value: tag, label: tag }))];
  });

  private readonly params = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  protected readonly selectedId = computed(() => this.params().get('contact'));
  protected readonly selection = computed(() => {
    const id = this.selectedId();
    return id ? [id] : [];
  });

  protected readonly columns: MtTableColumn<Row>[] = [{ id: 'name', header: 'Name', headerHidden: true }];
  protected readonly rowKey = (row: Row) => row.id;
  protected readonly rowLabel = (row: Row) => contactDisplayName(row);

  private readonly search = viewChild<MtSearchField>('search');
  private readonly table = viewChild<MtTable<Row>>('table');
  private readonly dialogOpen = signal(false);

  constructor() {
    const shortcuts = inject(ShortcutService);
    const commands = inject(CommandRegistry);
    const free = () => !this.dialogOpen();
    const cleanups = [
      shortcuts.register({
        combo: 'c',
        description: 'New contact',
        group: 'Contacts',
        scope: 'route',
        when: () => free() && this.canEdit(),
        handler: () => void this.create(),
      }),
      shortcuts.register({
        combo: '/',
        description: 'Search contacts',
        group: 'Contacts',
        scope: 'route',
        when: free,
        handler: () => this.search()?.focus(),
      }),
      shortcuts.register({
        combo: 'j',
        description: 'Next contact',
        group: 'Contacts',
        scope: 'route',
        when: free,
        handler: () => this.move(1),
      }),
      shortcuts.register({
        combo: 'k',
        description: 'Previous contact',
        group: 'Contacts',
        scope: 'route',
        when: free,
        handler: () => this.move(-1),
      }),
      commands.register({
        id: 'contacts.new',
        title: 'New contact',
        group: 'Contacts',
        icon: 'user-plus',
        keywords: ['person', 'organisation', 'client', 'add'],
        shortcut: 'c',
        when: () => this.canEdit(),
        run: () => void this.create(),
      }),
      commands.register({
        id: 'contacts.search',
        title: 'Search contacts',
        group: 'Contacts',
        icon: 'search',
        shortcut: '/',
        run: () => this.search()?.focus(),
      }),
    ];
    inject(DestroyRef).onDestroy(() => cleanups.forEach((cleanup) => cleanup()));

    // Open the first contact when none is chosen, as the design shows. Not while a dialog is open:
    // selecting navigates, and navigating closes the dialog (a new contact can reach the list
    // before contacts-create returns).
    let autoSelected: string | null = null;
    effect(() => {
      const first = this.rows()[0];
      if (first && !this.selectedId() && !this.dialogOpen()) {
        autoSelected = first.id;
        untracked(() => this.select(first.id));
      }
    });
    // ⌘K's Recent (CORE-15): each contact opened is recorded once (not the one chosen for me above).
    const record = recentRecorder();
    effect(() => {
      const id = this.selectedId();
      if (id && id !== autoSelected) untracked(() => record({ kind: 'contact', entityId: id }));
    });

    // ⌘K's "New contact" from anywhere (CORE-15), once the list has settled on a contact: choosing
    // one navigates, which would close the dialog.
    onIntent(
      'new-contact',
      () => void this.create(),
      () => this.contacts.status() !== 'loading' && (!!this.selectedId() || !this.rows().length),
    );
  }

  /** The table's cell templates are untyped; its rows are always contacts. */
  protected asRow(cell: unknown): Row {
    return cell as Row;
  }

  protected label(row: ContactListItem): string {
    return contactDisplayName(row);
  }

  /** The row's second line: its roles while filtering by role, else the first email or phone, or tags. */
  protected caption(row: ContactListItem): string {
    if (this.role() && row.matterRoles.length) return row.matterRoles.map((role) => PARTY_ROLE_LABELS[role]).join(', ');
    if (this.referrersOnly() && row.referrerMeta) {
      const { industry, company } = row.referrerMeta;
      const meta = [industry ? REFERRER_INDUSTRY_LABELS[industry] : null, company].filter(Boolean).join(' · ');
      if (meta) return meta;
    }
    const email = row.emails[0]?.address;
    if (email) return email;
    const phone = row.phones[0]?.number;
    if (phone) return formatPhone(phone);
    return row.tags.join(', ');
  }

  protected select(id: string | null): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { contact: id },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** `j`/`k`: the next or previous contact, focusing its row. */
  private move(delta: number): void {
    const rows = this.rows();
    if (!rows.length) return;
    const current = rows.findIndex((row) => row.id === this.selectedId());
    const next = current < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, current + delta));
    const row = rows[next];
    if (!row) return;
    this.select(row.id);
    this.table()?.focusRow(next);
  }

  /** The selection follows keyboard focus in the table (its own j/k and arrow keys). */
  protected onRowFocus(event: FocusEvent): void {
    const row = (event.target as HTMLElement | null)?.closest?.('tr[data-index]');
    const index = Number(row?.getAttribute('data-index'));
    const contact = Number.isInteger(index) ? this.rows()[index] : undefined;
    if (contact && contact.id !== this.selectedId()) this.select(contact.id);
  }

  private async openDialog<D, R>(component: unknown, data: D): Promise<R | undefined> {
    this.dialogOpen.set(true);
    try {
      return await this.dialogs.open<D, R>(component as never, { data }).result;
    } finally {
      this.dialogOpen.set(false);
    }
  }

  async create(): Promise<void> {
    if (!this.canEdit() || this.dialogOpen()) return;
    const result = await this.openDialog<ContactFormDialogData, ContactFormDialogResult>(ContactFormDialog, {});
    if (!result) return;
    this.select(result.contactId);
    if (result.outcome === 'saved') this.toasts.show({ title: 'Contact created', tone: 'success' });
  }

  protected async edit(contact: Row): Promise<void> {
    const result = await this.openDialog<ContactFormDialogData, ContactFormDialogResult>(ContactFormDialog, {
      contact,
    });
    if (result) this.toasts.show({ title: 'Changes saved', tone: 'success' });
  }

  protected async remove(contact: Row): Promise<void> {
    const deleted = await this.openDialog<ContactDeleteDialogData, boolean>(ContactDeleteDialog, {
      contactId: contact.id,
      name: contactDisplayName(contact),
    });
    if (!deleted) return;
    this.select(null);
    this.toasts.show({ title: `${contactDisplayName(contact)} deleted`, tone: 'success' });
  }

  protected async mergeInto(contact: Row): Promise<void> {
    const result = await this.openDialog<ContactMergeDialogData, ContactMergeDialogResult>(ContactMergeDialog, {
      mergeId: contact.id,
      name: contactDisplayName(contact),
      kind: contact.kind,
    });
    if (!result) return;
    this.select(result.keepId);
    this.toasts.show(
      result.queued
        ? {
            title: 'Contacts merged',
            description: 'Some matters and documents are still moving across. That finishes in the background.',
            tone: 'success',
          }
        : { title: 'Contacts merged', tone: 'success' },
    );
  }
}
