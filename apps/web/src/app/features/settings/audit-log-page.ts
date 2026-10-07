import { JsonPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal, type WritableSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MEMBER_LIST_QUERY, membersRepository } from '@materia/data-access/repository';
import {
  DialogService,
  injectDialogRef,
  MtButton,
  MtDialog,
  MtNote,
  type MtOption,
  MtSelect,
  MtSkeleton,
  MtTable,
  type MtTableColumn,
  MtTextField,
  ToastService,
} from '@materia/ui';

import { SettingsApi, type AuditEntryView, type AuditFilters } from './settings-api';
import { errorCopy } from '../../core/error-copy';
import { OrgService } from '../../core/orgs/org-service';

/** The kinds of record the log can be narrowed to, by collection. */
const ENTITY_OPTIONS: MtOption<string>[] = [
  { value: '', label: 'Everything' },
  { value: 'matters', label: 'Matters' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'parties', label: 'Parties' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'deadlines', label: 'Deadlines' },
  { value: 'events', label: 'Events' },
  { value: 'documents', label: 'Documents' },
  { value: 'notes', label: 'Notes' },
  { value: 'members', label: 'Members and settings' },
  { value: 'invites', label: 'Invites' },
  { value: 'templates', label: 'Templates' },
];

/** Write actions recorded by the trigger, then the most useful named events. */
const ACTION_OPTIONS: MtOption<string>[] = [
  { value: '', label: 'Any action' },
  { value: 'create', label: 'Created' },
  { value: 'update', label: 'Changed' },
  { value: 'soft_delete', label: 'Deleted' },
  { value: 'restore', label: 'Restored' },
  { value: 'delete', label: 'Erased' },
  { value: 'org.settings_updated', label: 'Settings changed' },
  { value: 'member.role_changed', label: 'Role changed' },
  { value: 'member.invited', label: 'Member invited' },
  { value: 'member.removed', label: 'Member removed' },
  { value: 'matter.status_changed', label: 'Matter status changed' },
  { value: 'matter.renumbered', label: 'Matter renumbered' },
  { value: 'audit.exported', label: 'Audit log exported' },
  { value: 'export.created', label: 'Export started' },
  // Data rights (SEC-05).
  { value: 'export.org_completed', label: 'Full export finished' },
  { value: 'member.offboarded', label: 'Member offboarded' },
  { value: 'org.deletion_requested', label: 'Deletion requested' },
  { value: 'org.deletion_cancelled', label: 'Deletion cancelled' },
  { value: 'org.deletion_blocked', label: 'Deletion stopped' },
];

const actionLabel = (action: string) => ACTION_OPTIONS.find((o) => o.value === action)?.label ?? action;

/**
 * A typed day (DD/MM/YYYY, in this browser's time zone) as the instant its day starts or ends;
 * `undefined` when empty, `null` when it isn't a date.
 */
export function dayBoundary(value: string, end: boolean): string | null | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = end ? new Date(year, month - 1, day, 23, 59, 59, 999) : new Date(year, month - 1, day);
  return date.getDate() === day && date.getMonth() === month - 1 ? date.toISOString() : null;
}

interface DetailData {
  entry: AuditEntryView;
  who: string;
}

/** One entry in full: what changed, with values redacted as the log stores them. */
@Component({
  selector: 'mt-audit-entry-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [JsonPipe, MtButton, MtDialog],
  template: `
    @let e = data.entry;
    <mt-dialog size="lg" [title]="label(e.action)" [description]="e.summary">
      <dl class="facts">
        <dt>When</dt>
        <dd>{{ when(e.at) }}</dd>
        <dt>Who</dt>
        <dd>{{ data.who }}</dd>
        <dt>Record</dt>
        <dd class="mono">{{ e.entity.path }}</dd>
        <dt>Source</dt>
        <dd>{{ e.source }}</dd>
        @let changed = e.changedFields ?? [];
        @if (changed.length) {
          <dt>Changed</dt>
          <dd>{{ changed.join(', ') }}</dd>
        }
      </dl>
      @if (e.before || e.after) {
        <div class="diff">
          @if (e.before) {
            <section>
              <h3 class="label">Before</h3>
              <pre>{{ e.before | json }}</pre>
            </section>
          }
          @if (e.after) {
            <section>
              <h3 class="label">After</h3>
              <pre>{{ e.after | json }}</pre>
            </section>
          }
        </div>
      }
      @if (e.data) {
        <h3 class="label">Details</h3>
        <pre>{{ e.data | json }}</pre>
      }
      <p class="caption" style="color: var(--text-tertiary)">Personal and privileged values are redacted in the log.</p>
      <ng-container mtDialogFooter>
        <button mtButton variant="primary" (click)="ref.close()">Close</button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .facts {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--space-4, 4px) var(--space-16, 16px);
      margin: 0 0 var(--space-16, 16px);
    }
    .facts dt {
      color: var(--text-secondary);
    }
    .facts dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .diff {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: var(--space-12, 12px);
    }
    pre {
      margin: var(--space-4, 4px) 0 var(--space-12, 12px);
      padding: var(--space-8, 8px);
      background: var(--bg-canvas);
      border-radius: var(--radius-sm, 4px);
      font: 400 12px/1.5 var(--font-mono);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 320px;
      overflow: auto;
    }
    .mono {
      font-family: var(--font-mono);
    }
  `,
})
export class AuditEntryDialog {
  protected readonly ref = injectDialogRef<DetailData, undefined>();
  protected readonly data = this.ref.data;
  protected label = actionLabel;
  protected when(iso: string): string {
    return new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
  }
}

/**
 * Settings → Audit log (`/settings/audit`, CORE-21; owners and admins): the practice's audit trail
 * from `audit-query`, newest first, filtered by person, kind of record, action and dates. A row opens
 * its details with the redacted before and after. Owners export the filtered log to CSV after
 * confirming it's them (`audit-exportCsv`).
 */
@Component({
  selector: 'mt-audit-log-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtNote, MtSelect, MtSkeleton, MtTable, MtTextField],
  host: { class: 'mt-col', style: 'gap: 20px' },
  template: `
    <div class="mt-row" style="gap: 12px; align-items: flex-end; flex-wrap: wrap">
      <div class="mt-col mt-grow" style="gap: 6px">
        <h1 class="title-l" style="margin: 0">Audit log</h1>
        <p style="margin: 0; color: var(--text-secondary)">
          Every change to the practice’s records, who made it and when. Entries can’t be edited or deleted.
        </p>
      </div>
      @if (isOwner()) {
        <button mtButton iconStart="arrow-down" [loading]="exporting()" (click)="exportCsv()">Export CSV</button>
      }
    </div>

    <form class="filters" aria-label="Filter the audit log" (submit)="$event.preventDefault(); search()">
      <mt-select
        name="actor"
        label="Person"
        size="sm"
        [native]="true"
        [options]="people()"
        [ngModel]="filters().actorUid ?? ''"
        (ngModelChange)="setFilter({ actorUid: $event || undefined })"
      />
      <mt-select
        name="collection"
        label="Record"
        size="sm"
        [native]="true"
        [options]="entities"
        [ngModel]="filters().collection ?? ''"
        (ngModelChange)="setFilter({ collection: $event || undefined })"
      />
      <mt-select
        name="action"
        label="Action"
        size="sm"
        [native]="true"
        [options]="actions"
        [ngModel]="filters().action ?? ''"
        (ngModelChange)="setFilter({ action: $event || undefined })"
      />
      <mt-text-field
        name="from"
        label="From"
        placeholder="DD/MM/YYYY"
        size="sm"
        [error]="fromProblem() ?? undefined"
        [ngModel]="fromDay()"
        (ngModelChange)="setDay(fromDay, $event)"
      />
      <mt-text-field
        name="to"
        label="To"
        placeholder="DD/MM/YYYY"
        size="sm"
        [error]="toProblem() ?? undefined"
        [ngModel]="toDay()"
        (ngModelChange)="setDay(toDay, $event)"
      />
    </form>

    @if (error(); as message) {
      <mt-note tone="danger">
        {{ message }}
        <button mtButton size="sm" (click)="search()">Try again</button>
      </mt-note>
    }

    @if (loading() && !entries().length) {
      <mt-skeleton framed label="Loading the audit log…" [count]="6" />
    } @else if (!entries().length && !error()) {
      <p style="margin: 0; color: var(--text-tertiary)">No entries match these filters.</p>
    } @else {
      <mt-table
        label="Audit log"
        density="compact"
        [rows]="entries()"
        [columns]="columns"
        [rowKey]="rowKey"
        (open)="open($event)"
      />
      @if (nextCursor()) {
        <button mtButton size="sm" style="align-self: flex-start" [loading]="loading()" (click)="more()">
          Show older entries
        </button>
      }
    }
  `,
  styles: `
    .filters {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: var(--space-8, 8px);
    }
  `,
})
export class AuditLogPage {
  private readonly api = inject(SettingsApi);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly orgs = inject(OrgService);
  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 100 });

  protected readonly entities = ENTITY_OPTIONS;
  protected readonly actions = ACTION_OPTIONS;
  protected readonly isOwner = computed(() => this.orgs.role() === 'owner');
  private readonly names = computed(() => new Map(this.members.value().map((m) => [m.id, m.displayName])));
  protected readonly people = computed<MtOption<string>[]>(() => [
    { value: '', label: 'Anyone' },
    ...this.members.value().map((m) => ({ value: m.id, label: m.displayName })),
  ]);

  protected readonly filters = signal<AuditFilters>({});
  protected readonly fromDay = signal('');
  protected readonly toDay = signal('');
  protected readonly fromProblem = computed(() =>
    dayBoundary(this.fromDay(), false) === null ? 'Enter a date like 14/10/2026.' : null,
  );
  protected readonly toProblem = computed(() =>
    dayBoundary(this.toDay(), true) === null ? 'Enter a date like 14/10/2026.' : null,
  );
  protected readonly entries = signal<AuditEntryView[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly exporting = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Responses to an older search are dropped. */
  private generation = 0;

  protected readonly columns: MtTableColumn<AuditEntryView>[] = [
    {
      id: 'at',
      header: 'When',
      width: '150px',
      value: (e) => new Date(e.at).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }),
    },
    { id: 'who', header: 'Who', width: '160px', value: (e) => this.who(e) },
    { id: 'action', header: 'Action', width: '160px', value: (e) => actionLabel(e.action) },
    { id: 'record', header: 'Record', value: (e) => `${e.entity.collection ?? ''} ${e.entity.id ?? ''}`.trim() },
    {
      id: 'summary',
      header: 'Details',
      value: (e) => e.summary ?? (e.changedFields?.length ? `Changed ${e.changedFields.join(', ')}` : ''),
    },
  ];
  protected readonly rowKey = (e: AuditEntryView) => e.id;

  constructor() {
    void this.search();
  }

  private who(entry: AuditEntryView): string {
    if (entry.actor === 'system') return 'Materia';
    if (entry.actor === 'clerk') return 'Clerk';
    return this.names().get(entry.actor.uid) ?? 'Former member';
  }

  private query(): AuditFilters {
    return {
      ...this.filters(),
      from: dayBoundary(this.fromDay(), false) ?? undefined,
      to: dayBoundary(this.toDay(), true) ?? undefined,
    };
  }

  /** A date filter applies once it is empty or a whole date. */
  protected setDay(day: WritableSignal<string>, value: string | null): void {
    day.set(value ?? '');
    if (dayBoundary(day(), false) !== null) void this.search();
  }

  protected setFilter(patch: Partial<AuditFilters>): void {
    this.filters.update((filters) => ({ ...filters, ...patch }));
    void this.search();
  }

  async search(): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await this.api.auditQuery(this.query());
      if (generation !== this.generation) return;
      this.entries.set(page.entries);
      this.nextCursor.set(page.nextCursor);
    } catch (error) {
      if (generation === this.generation) this.error.set(errorCopy(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }

  protected async more(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor) return;
    const generation = this.generation;
    this.loading.set(true);
    try {
      const page = await this.api.auditQuery(this.query(), cursor);
      if (generation !== this.generation) return;
      this.entries.update((entries) => [...entries, ...page.entries]);
      this.nextCursor.set(page.nextCursor);
    } catch (error) {
      this.error.set(errorCopy(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected open(entry: AuditEntryView): void {
    this.dialogs.open<DetailData, undefined>(AuditEntryDialog, { data: { entry, who: this.who(entry) } });
  }

  protected async exportCsv(): Promise<void> {
    this.exporting.set(true);
    try {
      // A stale sign-in gets "Confirm it's you" and a retry from the callable client (SEC-04).
      const result = await this.exportOnce();
      download(`audit-log-${new Date().toISOString().slice(0, 10)}.csv`, result.csv);
      this.toasts.show({
        title: `Exported ${result.rows} ${result.rows === 1 ? 'entry' : 'entries'}`,
        ...(result.truncated ? { description: 'Only the newest entries fit. Narrow the dates for the rest.' } : {}),
        tone: 'success',
      });
    } catch (error) {
      this.toasts.show({ title: 'The export didn’t work', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.exporting.set(false);
    }
  }

  private exportOnce() {
    return this.api.auditExport(this.query());
  }
}

/** Saves text as a file through a temporary link. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
