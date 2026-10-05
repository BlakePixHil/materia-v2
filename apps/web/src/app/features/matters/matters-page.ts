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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { can, OrgContext } from '@materia/data-access';
import {
  contactsRepository,
  hasMatterFilters,
  MATTER_CALLABLES,
  matterMatchesFilters,
  matterQueryPlan,
  mattersRepository,
  MEMBER_LIST_QUERY,
  membersRepository,
  SAVED_MATTER_VIEWS_QUERY,
  savedViewsRepository,
  type MatterListFilters,
} from '@materia/data-access/repository';
import {
  contactDisplayName,
  isMatterLink,
  MATTER_STATUS_LABELS,
  MatterTypeSchema,
  type ChangeMatterStatusResult,
  type Jurisdiction,
  type MatterGroupBy,
  type MatterStatus,
  type MatterType,
  type MatterViewFilters,
} from '@materia/domain';
import {
  DialogService,
  formatRelativeDate,
  MATTER_TYPE_LABELS,
  MT_MENU,
  MT_TODAY,
  MtAvatar,
  MtButton,
  MtDeadlineChip,
  MtEmptyState,
  MtIcon,
  MtMatterTag,
  MtNote,
  MtPriorityIcon,
  MtSearchField,
  MtTable,
  MtTableCell,
  sortRows,
  ToastService,
  type MtSort,
  type MtTableColumn,
} from '@materia/ui';

import { MatterNameDialog, type MatterNameDialogData } from './matter-name-dialog';
import { MattersBulkBar, type MatterAssignee } from './matters-bulk-bar';
import {
  bulkStatusSummary,
  changeStatusErrorCopy,
  cleanFilters,
  DEFAULT_VIEW_ID,
  DEFAULT_VIEW_OPTIONS,
  formatWip,
  fromTableSort,
  JURISDICTIONS,
  matterGroup,
  orderForGroups,
  readLastView,
  sameView,
  savedViewOption,
  stageLabel,
  STATUS_ORDER,
  toTableSort,
  writeLastView,
  type MatterRow,
  type MatterViewOption,
  type MatterViewState,
} from './matters-view';
import { CommandRegistry, type Command } from '../../core/commands/command-registry';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { ShortcutService } from '../../core/shortcuts/shortcut.service';
import { MtPageActions } from '../../shell/page-header';

const GROUP_LABELS: Record<MatterGroupBy, string> = {
  none: 'No grouping',
  status: 'Status',
  type: 'Type',
  responsible: 'Responsible',
};

/**
 * Matters (`/matters`, CORE-03): every matter in a table, with filters, grouping, saved views and
 * bulk actions, as in the design system's Matters list. The view is in the URL (`?view=<id>`;
 * "My open matters" by default). Keyboard: `j`/`k` move, Enter opens, `x` selects, `/` searches,
 * `c` starts a new matter.
 */
@Component({
  selector: 'mt-matters-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    MT_MENU,
    MtAvatar,
    MtButton,
    MtDeadlineChip,
    MtEmptyState,
    MtIcon,
    MtMatterTag,
    MtNote,
    MtPageActions,
    MtPriorityIcon,
    MtSearchField,
    MtTable,
    MtTableCell,
    MattersBulkBar,
  ],
  template: `
    <ng-template mtPageActions>
      @if (canCreate()) {
        <a mtButton variant="primary" size="sm" iconStart="plus" kbd="c" routerLink="/matters/new">New matter</a>
      }
    </ng-template>
    <h1 class="mt-sr">Matters</h1>

    <div class="mt-matters-bar" role="group" aria-label="View and filters">
      <button type="button" class="mt-chip" data-selected [mtMenuTrigger]="viewMenu" aria-haspopup="menu">
        <mt-icon name="list" />{{ viewName() }}{{ modified() ? ' (edited)' : '' }}<mt-icon name="chevron-down" />
      </button>
      <button type="button" class="mt-chip" [attr.data-selected]="on(f().status)" [mtMenuTrigger]="statusMenu">
        {{ statusText() }}<mt-icon name="chevron-down" />
      </button>
      <button type="button" class="mt-chip" [attr.data-selected]="on(f().type)" [mtMenuTrigger]="typeMenu">
        {{ typeText() }}<mt-icon name="chevron-down" />
      </button>
      <button type="button" class="mt-chip" [attr.data-selected]="on(f().responsible)" [mtMenuTrigger]="ownerMenu">
        <mt-icon name="user" />{{ responsibleText() }}<mt-icon name="chevron-down" />
      </button>
      <button type="button" class="mt-chip" [attr.data-selected]="on(f().label)" [mtMenuTrigger]="labelMenu">
        {{ f().label ? 'Label: ' + f().label : 'Label' }}<mt-icon name="chevron-down" />
      </button>
      <button type="button" class="mt-chip" [attr.data-selected]="on(f().jurisdiction)" [mtMenuTrigger]="placeMenu">
        {{ f().jurisdiction ?? 'Jurisdiction' }}<mt-icon name="chevron-down" />
      </button>
      <button
        type="button"
        class="mt-chip"
        [attr.data-selected]="on(f().hasOverdue)"
        [attr.aria-pressed]="!!f().hasOverdue"
        (click)="setFilters({ hasOverdue: !f().hasOverdue })"
      >
        <mt-icon name="alert" />Has overdue
      </button>
      <button type="button" class="mt-chip" [attr.data-selected]="on(groupBy() !== 'none')" [mtMenuTrigger]="groupMenu">
        Group: {{ groupLabels[groupBy()] }}<mt-icon name="chevron-down" />
      </button>
      @if (filtered()) {
        <button mtButton variant="ghost" size="sm" (click)="clearFilters()">Clear filters</button>
      }
      @if (modified()) {
        <button mtButton variant="secondary" size="sm" iconStart="plus" (click)="saveView()">Save view</button>
      }
      <span class="mt-ml mt-matters-search">
        <mt-search-field
          #search
          label="Filter matters"
          placeholder="Number, title or client"
          shortcut="/"
          [ngModel]="query()"
          (queryChange)="query.set($event)"
        />
      </span>
    </div>

    @if (plan()?.notice; as notice) {
      <p class="mt-matters-notice" role="status"><mt-icon name="info" />{{ notice }}</p>
    }

    <div class="mt-matters-rows">
      @switch (matters.status()) {
        @case ('error') {
          <mt-note tone="danger">
            {{ listError() }}
            <button mtButton size="sm" (click)="matters.refresh()">Try again</button>
          </mt-note>
        }
        @case ('offline') {
          <mt-note role="status"
            >You’re offline. These are the matters as they were when you were last connected.</mt-note
          >
        }
        @case ('loading') {
          <p role="status" class="mt-matters-muted">Loading matters…</p>
        }
      }
      @if (matters.newItems(); as count) {
        <button mtButton size="sm" (click)="matters.refresh()">
          {{ count === 1 ? '1 new matter' : count + ' new matters' }}
        </button>
      }
      @if (ready()) {
        <mt-table
          #table
          label="Matters"
          density="compact"
          sortMode="external"
          maxHeight="none"
          [selectable]="true"
          [rows]="rows()"
          [columns]="columns"
          [rowKey]="rowKey"
          [rowLabel]="rowLabel"
          [groupBy]="groupOf()"
          [sort]="tableSort()"
          (sortChange)="sortBy($event)"
          [(selection)]="selection"
          (open)="openMatter($event)"
          (endReached)="loadMore()"
          (focusin)="onRowFocus($event)"
        >
          <ng-template mtCell="number" let-cell>
            @let row = asRow(cell);
            @if (linkOf(row); as url) {
              <a
                class="mt-matters-link"
                [href]="url"
                target="_blank"
                rel="noopener noreferrer"
                [attr.aria-label]="row.number + '. Open the linked matter in a new tab'"
                (click)="$event.stopPropagation()"
                (keydown.enter)="$event.stopPropagation()"
                >{{ row.number }}<mt-icon name="link" [size]="14"
              /></a>
            } @else {
              {{ row.number }}
            }
          </ng-template>
          <ng-template mtCell="title" let-cell>
            @let row = asRow(cell);
            <span class="mt-matters-title">
              <mt-priority-icon [level]="row.priority" />
              <span class="title mt-ell">{{ row.title }}</span>
            </span>
          </ng-template>
          <ng-template mtCell="type" let-cell>
            @let row = asRow(cell);
            <mt-matter-tag [type]="row.type" />
          </ng-template>
          <ng-template mtCell="responsible" let-cell>
            @let row = asRow(cell);
            <mt-avatar
              size="sm"
              [name]="memberName(row.responsibleUid)"
              [colorKey]="row.responsibleUid"
              [tooltip]="true"
            />
          </ng-template>
          <ng-template mtCell="nextDeadline" let-cell>
            @let row = asRow(cell);
            @if (row.nextDeadline; as next) {
              <mt-deadline-chip [due]="next.dueDate" [critical]="next.critical" [trace]="next.title" />
            } @else {
              <span class="mt-matters-muted">—</span>
            }
          </ng-template>
          <div mtTableEmpty>
            @if (filtered()) {
              <mt-empty-state
                title="No matters match"
                description="Nothing matches these filters. Clear them to see every matter in this view."
                icon="search"
                [headingLevel]="2"
              >
                <button mtButton size="sm" (click)="clearFilters()">Clear filters</button>
              </mt-empty-state>
            } @else {
              <mt-empty-state
                title="No matters yet"
                description="Matters you open, from intake to grant, show here."
                icon="matters"
                [headingLevel]="2"
              >
                @if (canCreate()) {
                  <a mtButton variant="primary" size="sm" iconStart="plus" routerLink="/matters/new">New matter</a>
                }
              </mt-empty-state>
            }
          </div>
        </mt-table>
      }
      @if (plan()?.mode === 'paged' && matters.hasMore()) {
        <button mtButton size="sm" class="mt-matters-more" [loading]="matters.loadingMore()" (click)="loadMore()">
          Show more matters
        </button>
      }
    </div>

    @if (selectedRows().length) {
      <mt-matters-bulk-bar
        [count]="selectedRows().length"
        [assignees]="assignees()"
        [canEdit]="canEdit()"
        [canChangeStatus]="canStatus()"
        [busy]="bulkBusy()"
        [canCheckConflicts]="singleLead() !== null"
        (checkConflicts)="checkConflicts()"
        (assign)="bulkAssign($event)"
        (addLabel)="bulkLabel()"
        (changeStatus)="bulkStatus($event)"
        (clear)="selection.set([])"
      />
    }

    <ng-template #viewMenu>
      <mt-menu aria-label="Views">
        @for (option of defaultViews; track option.id) {
          <button mtMenuItem [icon]="option.id === viewId() ? 'check' : undefined" (click)="selectView(option.id)">
            {{ option.name }}
          </button>
        }
        @if (savedOptions().length) {
          <mt-menu-separator />
          @for (option of savedOptions(); track option.id) {
            <button mtMenuItem [icon]="option.id === viewId() ? 'check' : undefined" (click)="selectView(option.id)">
              {{ option.name }}
            </button>
          }
        }
        <mt-menu-separator />
        <button mtMenuItem icon="plus" (click)="saveView()">Save as new view…</button>
        @if (view()?.saved) {
          @if (modified()) {
            <button mtMenuItem icon="check" (click)="updateView()">Save changes to this view</button>
          }
          <button mtMenuItem icon="compose" (click)="renameView()">Rename view…</button>
          <button mtMenuItem icon="trash" tone="danger" (click)="deleteView()">Delete view</button>
        }
      </mt-menu>
    </ng-template>
    <ng-template #statusMenu>
      <mt-menu aria-label="Status">
        @for (status of statuses; track status) {
          <button
            mtMenuItemCheckbox
            [checked]="!!f().status?.includes(status)"
            (checkedChange)="toggleIn('status', status, $event)"
          >
            {{ statusLabels[status] }}
          </button>
        }
      </mt-menu>
    </ng-template>
    <ng-template #typeMenu>
      <mt-menu aria-label="Type">
        @for (type of types; track type) {
          <button
            mtMenuItemCheckbox
            [checked]="!!f().type?.includes(type)"
            (checkedChange)="toggleIn('type', type, $event)"
          >
            {{ typeLabels[type] }}
          </button>
        }
      </mt-menu>
    </ng-template>
    <ng-template #ownerMenu>
      <mt-menu aria-label="Responsible">
        <button
          mtMenuItem
          [icon]="!f().responsible ? 'check' : undefined"
          (click)="setFilters({ responsible: undefined })"
        >
          Anyone
        </button>
        <button
          mtMenuItem
          [icon]="f().responsible === 'me' ? 'check' : undefined"
          (click)="setFilters({ responsible: 'me' })"
        >
          Mine
        </button>
        <mt-menu-separator />
        @for (person of assignees(); track person.uid) {
          <button
            mtMenuItem
            [icon]="f().responsible === person.uid ? 'check' : undefined"
            (click)="setFilters({ responsible: person.uid })"
          >
            {{ person.name }}
          </button>
        }
      </mt-menu>
    </ng-template>
    <ng-template #labelMenu>
      <mt-menu aria-label="Label">
        <button mtMenuItem [icon]="!f().label ? 'check' : undefined" (click)="setFilters({ label: undefined })">
          Any label
        </button>
        @for (label of labelOptions(); track label) {
          <button mtMenuItem [icon]="f().label === label ? 'check' : undefined" (click)="setFilters({ label })">
            {{ label }}
          </button>
        }
      </mt-menu>
    </ng-template>
    <ng-template #placeMenu>
      <mt-menu aria-label="Jurisdiction">
        <button
          mtMenuItem
          [icon]="!f().jurisdiction ? 'check' : undefined"
          (click)="setFilters({ jurisdiction: undefined })"
        >
          Any jurisdiction
        </button>
        @for (place of jurisdictions; track place) {
          <button mtMenuItem [icon]="f().jurisdiction === place ? 'check' : undefined" (click)="setJurisdiction(place)">
            {{ place }}
          </button>
        }
      </mt-menu>
    </ng-template>
    <ng-template #groupMenu>
      <mt-menu aria-label="Group by">
        @for (option of groupOptions; track option) {
          <button mtMenuItem [icon]="groupBy() === option ? 'check' : undefined" (click)="update({ groupBy: option })">
            {{ groupLabels[option] }}
          </button>
        }
      </mt-menu>
    </ng-template>
  `,
  styles: `
    /* Full-bleed: cancels the shell page's padding and the gap after the router outlet. */
    :host {
      position: relative;
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      margin: calc(-1 * (var(--space-24) + var(--space-20))) calc(-1 * var(--space-32)) calc(-1 * var(--space-32));
    }
    .mt-matters-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-6);
      padding: 10px var(--space-20);
      border-bottom: 1px solid var(--border-default);
    }
    .mt-chip {
      display: inline-flex;
      align-items: center;
      gap: var(--space-6);
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
    .mt-chip mt-icon {
      width: 13px;
      height: 13px;
    }
    .mt-matters-search {
      flex: 1 1 160px;
      min-width: 0;
      max-width: 260px;
    }
    .mt-matters-notice {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      margin: 0;
      padding: var(--space-6) var(--space-20);
      font: 400 12px/16px var(--font-sans);
      color: var(--text-secondary);
      background: var(--bg-canvas);
      border-bottom: 1px solid var(--border-subtle);
    }
    .mt-matters-rows {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      padding: 0 var(--space-8);
    }
    .mt-matters-rows > mt-table {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .mt-matters-rows ::ng-deep .mt-table-scroll {
      flex: 1;
      min-height: 0;
    }
    .mt-matters-link {
      display: inline-flex;
      align-items: center;
      gap: var(--space-4);
      color: inherit;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .mt-matters-link:hover {
      color: var(--text-brand);
    }
    .mt-matters-title {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      min-width: 0;
    }
    .mt-matters-muted {
      margin: 0;
      padding: var(--space-12);
      color: var(--text-tertiary);
    }
    .mt-matters-more {
      align-self: center;
      margin-bottom: var(--space-12);
    }
    @media (max-width: 900px) {
      :host {
        margin: 0;
      }
      .mt-matters-search {
        width: 100%;
      }
    }
  `,
})
export class MattersPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly callables = inject(CALLABLES);
  private readonly context = inject(OrgContext);
  private readonly today = inject(MT_TODAY);

  protected readonly canCreate = can('matter.create');
  protected readonly canEdit = can('matter.edit');
  protected readonly canStatus = can('matter.status');
  private readonly canRunConflicts = can('conflict.run');
  private readonly privilegedVisible = can('privileged.view');

  protected readonly statuses = STATUS_ORDER;
  protected readonly statusLabels = MATTER_STATUS_LABELS;
  protected readonly types = MatterTypeSchema.options;
  protected readonly typeLabels = MATTER_TYPE_LABELS;
  protected readonly jurisdictions = JURISDICTIONS;
  protected readonly groupOptions: MatterGroupBy[] = ['none', 'status', 'type', 'responsible'];
  protected readonly groupLabels = GROUP_LABELS;
  protected readonly defaultViews = DEFAULT_VIEW_OPTIONS;

  // ---------- views ----------

  private readonly viewsRepo = savedViewsRepository();
  private readonly savedViews = this.viewsRepo.watchQuery(() => {
    const orgId = this.context.orgId();
    return orgId ? SAVED_MATTER_VIEWS_QUERY(orgId) : null;
  });
  protected readonly savedOptions = computed(() =>
    this.savedViews
      .value()
      .map(savedViewOption)
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  private readonly params = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  protected readonly viewId = computed(() => this.params().get('view') ?? DEFAULT_VIEW_ID);
  /** The picked view; null while a saved view named in the URL is still loading. */
  protected readonly view = computed<MatterViewOption | null>(() => {
    const id = this.viewId();
    const found = [...this.defaultViews, ...this.savedOptions()].find((option) => option.id === id);
    if (found) return found;
    const pending = this.savedViews.status() === 'loading';
    return pending ? null : (this.defaultViews[0] ?? null);
  });
  /** Changes made since the view was picked (null: none). */
  private readonly draft = signal<MatterViewState | null>(null);
  protected readonly state = computed<MatterViewState | null>(() => this.draft() ?? this.view());
  protected readonly modified = computed(() => {
    const draft = this.draft();
    const view = this.view();
    return !!draft && !!view && !sameView(draft, view);
  });
  protected readonly viewName = computed(() => this.view()?.name ?? 'Matters');
  protected readonly f = computed<MatterViewFilters>(() => this.state()?.filters ?? {});
  protected readonly groupBy = computed<MatterGroupBy>(() => this.state()?.groupBy ?? 'none');
  protected readonly query = signal('');
  private readonly filters = computed<MatterListFilters>(() => ({ ...this.f(), query: this.query() }));
  protected readonly filtered = computed(() => hasMatterFilters(this.filters()));

  // ---------- the list ----------

  protected readonly plan = computed(
    () => {
      const state = this.state();
      if (!state) return null;
      return matterQueryPlan(this.filters(), state.sort, {
        viewerUid: this.context.uid(),
        privilegedVisible: this.privilegedVisible(),
      });
    },
    { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  private readonly mattersRepo = mattersRepository();
  protected readonly matters = this.mattersRepo.watchQuery(() => this.plan()?.spec ?? null);
  protected readonly ready = computed(() => {
    const status = this.matters.status();
    return status === 'ready' || status === 'offline';
  });
  protected readonly listError = computed(() => errorCopy(this.matters.error()));

  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 });
  private readonly memberNames = computed(
    () => new Map(this.members.value().map((member) => [member.id, member.displayName] as const)),
  );
  protected readonly assignees = computed<MatterAssignee[]>(() =>
    this.members
      .value()
      .filter((member) => member.status === 'active' && member.role !== 'readonly')
      .map((member) => ({ uid: member.id, name: member.displayName })),
  );

  private readonly contacts = contactsRepository();
  private readonly clientNames = signal<ReadonlyMap<string, string>>(new Map());
  private readonly requestedClients = new Set<string>();

  protected readonly columns: MtTableColumn<MatterRow>[] = [
    { id: 'number', header: 'Ref', sortable: true, cellClass: 'ref', width: '112px' },
    { id: 'title', header: 'Matter', sortable: true, cellClass: 'title' },
    { id: 'type', header: 'Type', sortable: true, sortValue: (row) => MATTER_TYPE_LABELS[row.type] },
    { id: 'client', header: 'Client', sortable: true, value: (row) => this.clientsOf(row) },
    {
      id: 'responsible',
      header: 'Responsible',
      sortable: true,
      sortValue: (row) => this.memberName(row.responsibleUid),
    },
    { id: 'stage', header: 'Stage', sortable: true, value: (row) => stageLabel(row.stageId) },
    { id: 'nextDeadline', header: 'Next deadline', sortable: true, sortValue: (row) => row.nextDeadline?.dueDate },
    {
      id: 'wip',
      header: 'WIP',
      sortable: true,
      numeric: true,
      value: (row) => formatWip(row.wipCents),
      sortValue: (row) => row.wipCents,
    },
    {
      id: 'lastActivity',
      header: 'Last activity',
      sortable: true,
      value: (row) => formatRelativeDate(row.lastActivityAt, this.today()),
      sortValue: (row) => row.lastActivityAt?.getTime(),
    },
  ];
  protected readonly rowKey = (row: MatterRow) => row.id;
  /** The matter's link (CORE-21a), when it is a safe http(s) URL: its number opens it. */
  protected readonly linkOf = (row: MatterRow) => (isMatterLink(row.externalUrl) ? row.externalUrl : null);
  protected readonly rowLabel = (row: MatterRow) => `${row.number} ${row.title}`;

  /** Loaded rows that pass every filter, sorted here when Firestore couldn't, in group order. */
  protected readonly rows = computed(() => {
    const filters = this.filters();
    const context = { viewerUid: this.context.uid(), today: this.today(), now: new Date() };
    let rows = this.matters.value().filter((row) => matterMatchesFilters(row, filters, context));
    const state = this.state();
    if (state && this.plan()?.clientSort) {
      const column = this.columns.find((c) => c.id === state.sort.field);
      rows = sortRows(rows, column, state.sort.dir);
    }
    return orderForGroups(rows, this.groupBy(), (uid) => this.memberName(uid));
  });
  protected readonly groupOf = computed(() => {
    const groupBy = this.groupBy();
    if (groupBy === 'none') return null;
    return (row: MatterRow) => matterGroup(groupBy, row, (uid) => this.memberName(uid));
  });
  protected readonly tableSort = computed(() => toTableSort(this.state()?.sort ?? fromTableSort(null)));
  protected readonly labelOptions = computed(() => {
    const labels = new Set(this.matters.value().flatMap((row) => row.labels));
    const current = this.f().label;
    if (current) labels.add(current);
    return [...labels].sort((a, b) => a.localeCompare(b));
  });

  // ---------- selection and keyboard ----------

  protected readonly selection = signal<readonly string[]>([]);
  protected readonly selectedRows = computed(() => {
    const selected = new Set(this.selection());
    return this.rows().filter((row) => selected.has(row.id));
  });
  protected readonly bulkBusy = signal(false);
  /** The one selected matter when it's a lead (its conflict check can run, CORE-02). */
  protected readonly singleLead = computed(() => {
    const rows = this.selectedRows();
    const row = rows.length === 1 ? rows[0] : undefined;
    return row && row.status === 'lead' && this.canRunConflicts() ? row : null;
  });
  private readonly focused = signal(-1);
  private readonly search = viewChild<MtSearchField>('search');
  private readonly table = viewChild<MtTable<MatterRow>>('table');
  private readonly dialogOpen = signal(false);

  constructor() {
    const shortcuts = inject(ShortcutService);
    const commands = inject(CommandRegistry);
    const free = () => !this.dialogOpen();
    const shortcut = (combo: string, description: string, handler: () => void, when = free) =>
      shortcuts.register({ combo, description, group: 'Matters', scope: 'route', when, handler });
    const cleanups = [
      shortcut(
        'c',
        'New matter',
        () => this.newMatter(),
        () => free() && this.canCreate(),
      ),
      shortcut('/', 'Filter matters', () => this.search()?.focus()),
      shortcut('j', 'Next matter', () => this.move(1)),
      shortcut('k', 'Previous matter', () => this.move(-1)),
      shortcut('x', 'Select the focused matter', () => this.toggleFocused()),
      shortcut(
        'esc',
        'Clear the selection',
        () => this.selection.set([]),
        () => free() && this.selection().length > 0,
      ),
      commands.register({
        id: 'matters.filter',
        title: 'Filter matters',
        group: 'Matters',
        icon: 'filter',
        shortcut: '/',
        run: () => this.search()?.focus(),
      }),
      // ⌘K's list commands (CORE-15): the filter chips' choices, and saving the edited view.
      commands.register({
        id: 'matters.filter-by',
        title: 'Filter by…',
        group: 'This list',
        icon: 'filter',
        keywords: ['status', 'type', 'mine', 'overdue', 'narrow'],
        when: free,
        children: () => this.filterCommands(),
        run: () => undefined,
      }),
      commands.register({
        id: 'matters.save-view',
        title: 'Save view…',
        group: 'This list',
        icon: 'plus',
        keywords: ['filters', 'remember', 'saved view'],
        when: () => free() && this.modified(),
        run: () => void this.saveView(),
      }),
    ];
    inject(DestroyRef).onDestroy(() => cleanups.forEach((cleanup) => cleanup()));

    // Coming back without a view in the URL reopens the view the list was left on, edits and all.
    let restore = readLastView();
    if (restore && this.route.snapshot.queryParamMap.has('view')) restore = null;
    else if (restore && restore.viewId !== DEFAULT_VIEW_ID) {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { view: restore.viewId },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    }

    // A different view starts clean: no edits carried over, nothing selected.
    effect(() => {
      const id = this.viewId();
      untracked(() => {
        const draft = restore?.viewId === id ? restore.draft : null;
        if (restore?.viewId === id) restore = null;
        this.draft.set(draft);
        this.selection.set([]);
      });
    });

    // Remember the view and its edits for next time (not while the remembered one is reopening).
    effect(() => {
      const viewId = this.viewId();
      const draft = this.draft();
      if (!restore) writeLastView({ viewId, draft });
    });

    // Client names for the rows on screen, read once per contact.
    effect(() => {
      const ids = [...new Set(this.matters.value().flatMap((row) => row.clientContactIds))].filter(
        (id) => !this.requestedClients.has(id),
      );
      if (!ids.length) return;
      ids.forEach((id) => this.requestedClients.add(id));
      untracked(() => void this.loadClients(ids));
    });
  }

  /** The table's cell templates are untyped; its rows are always matters. */
  protected asRow(cell: unknown): MatterRow {
    return cell as MatterRow;
  }

  protected on(value: unknown): '' | null {
    return (Array.isArray(value) ? value.length > 0 : !!value) ? '' : null;
  }

  protected memberName(uid: string): string {
    return this.memberNames().get(uid) ?? (uid === this.context.uid() ? 'You' : 'Former member');
  }

  protected clientsOf(row: MatterRow): string {
    const names = this.clientNames();
    return row.clientContactIds
      .map((id) => names.get(id))
      .filter(Boolean)
      .join(', ');
  }

  protected readonly statusText = computed(() => {
    const status = this.f().status ?? [];
    if (!status.length) return 'Status';
    return status.length === 1 ? MATTER_STATUS_LABELS[status[0] as MatterStatus] : `Status: ${status.length}`;
  });
  protected readonly typeText = computed(() => {
    const type = this.f().type ?? [];
    if (!type.length) return 'Type';
    return type.length === 1 ? MATTER_TYPE_LABELS[type[0] as MatterType] : `Type: ${type.length}`;
  });
  protected readonly responsibleText = computed(() => {
    const responsible = this.f().responsible;
    if (!responsible) return 'Anyone';
    return responsible === 'me' ? 'Mine' : this.memberName(responsible);
  });

  private async loadClients(ids: string[]): Promise<void> {
    const found = await Promise.all(ids.map((id) => this.contacts.get(id).catch(() => null)));
    this.clientNames.update((map) => {
      const next = new Map(map);
      found.forEach((contact, i) => {
        const id = ids[i];
        if (contact && id) next.set(id, contactDisplayName(contact));
      });
      return next;
    });
  }

  /** "Filter by…" in ⌘K (CORE-15): one command per chip choice. */
  private filterCommands(): Command[] {
    const filter = (id: string, title: string, patch: Partial<MatterViewFilters>, group: string): Command => ({
      id: `matters.filter-by.${id}`,
      title,
      group,
      run: () => this.setFilters(patch),
    });
    return [
      filter('mine', 'Responsible: me', { responsible: 'me' }, 'Responsible'),
      filter('overdue', 'Has overdue', { hasOverdue: true }, 'Deadlines'),
      ...this.statuses.map((status) =>
        filter(`status.${status}`, `Status: ${this.statusLabels[status]}`, { status: [status] }, 'Status'),
      ),
      ...this.types.map((type) => filter(`type.${type}`, `Type: ${this.typeLabels[type]}`, { type: [type] }, 'Type')),
      {
        id: 'matters.filter-by.clear',
        title: 'Clear filters',
        group: 'Filters',
        icon: 'x',
        when: () => this.filtered(),
        run: () => this.clearFilters(),
      },
    ];
  }

  // ---------- changing the view ----------

  protected update(patch: Partial<MatterViewState>): void {
    const state = this.state();
    if (state) this.draft.set({ ...state, ...patch });
  }

  protected setFilters(patch: Partial<MatterViewFilters>): void {
    this.update({ filters: cleanFilters({ ...this.f(), ...patch }) });
  }

  protected setJurisdiction(place: Jurisdiction): void {
    this.setFilters({ jurisdiction: place });
  }

  protected toggleIn<K extends 'status' | 'type'>(key: K, value: string, checked: boolean): void {
    const current = (this.f()[key] ?? []) as string[];
    const next = checked ? [...new Set([...current, value])] : current.filter((item) => item !== value);
    this.setFilters({ [key]: next } as Partial<MatterViewFilters>);
  }

  protected clearFilters(): void {
    this.query.set('');
    this.update({ filters: {} });
  }

  protected sortBy(sort: MtSort | null): void {
    this.update({ sort: fromTableSort(sort) });
  }

  protected selectView(id: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { view: id === DEFAULT_VIEW_ID ? null : id },
      queryParamsHandling: 'merge',
    });
    if (id === this.viewId()) this.draft.set(null);
  }

  private async askName(data: MatterNameDialogData): Promise<string | undefined> {
    this.dialogOpen.set(true);
    try {
      return await this.dialogs.open<MatterNameDialogData, string | undefined>(MatterNameDialog, { data }).result;
    } finally {
      this.dialogOpen.set(false);
    }
  }

  protected async saveView(): Promise<void> {
    const state = this.state();
    const orgId = this.context.orgId();
    if (!state || !orgId) return;
    let created: string | null = null;
    await this.askName({
      title: 'Save view',
      label: 'View name',
      confirm: 'Save view',
      description: 'Saved views are yours alone. They keep the filters, sort and grouping.',
      submit: async (name) => {
        try {
          created = await this.viewsRepo.create({
            orgId,
            list: 'matters',
            name,
            filters: cleanFilters(state.filters),
            sort: state.sort,
            groupBy: state.groupBy,
          });
        } catch (error) {
          return errorCopy(error);
        }
        return undefined;
      },
    });
    if (!created) return;
    this.selectView(created);
    this.toasts.show({ title: 'View saved', tone: 'success' });
  }

  protected async updateView(): Promise<void> {
    const view = this.view();
    const state = this.state();
    if (!view?.saved || !state) return;
    try {
      await this.viewsRepo.update(view.id, {
        filters: cleanFilters(state.filters),
        sort: state.sort,
        groupBy: state.groupBy,
      });
      this.draft.set(null);
      this.toasts.show({ title: `Saved changes to ${view.name}`, tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: errorCopy(error), tone: 'danger' });
    }
  }

  protected async renameView(): Promise<void> {
    const view = this.view();
    if (!view?.saved) return;
    await this.askName({
      title: 'Rename view',
      label: 'View name',
      confirm: 'Rename',
      initial: view.name,
      submit: async (name) => {
        try {
          await this.viewsRepo.update(view.id, { name });
        } catch (error) {
          return errorCopy(error);
        }
        return undefined;
      },
    });
  }

  protected async deleteView(): Promise<void> {
    const view = this.view();
    if (!view?.saved) return;
    this.dialogOpen.set(true);
    const confirmed = await this.dialogs
      .confirm({ title: `Delete “${view.name}”?`, confirmLabel: 'Delete view', tone: 'danger' })
      .finally(() => this.dialogOpen.set(false));
    if (!confirmed) return;
    try {
      await this.viewsRepo.hardDelete(view.id);
      this.selectView(DEFAULT_VIEW_ID);
      this.toasts.show({ title: `Deleted ${view.name}`, tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: errorCopy(error), tone: 'danger' });
    }
  }

  // ---------- rows ----------

  protected openMatter(row: MatterRow): void {
    void this.router.navigate(['/matters', row.id]);
  }

  protected checkConflicts(): void {
    const row = this.singleLead();
    if (row) void this.router.navigate(['/matters', row.id, 'conflicts']);
  }

  private newMatter(): void {
    void this.router.navigateByUrl('/matters/new');
  }

  protected loadMore(): void {
    if (this.plan()?.mode !== 'paged' || !this.matters.hasMore() || this.matters.loadingMore()) return;
    void this.matters.loadMore();
  }

  /** `j`/`k` from outside the table: focus the next or previous row (the table handles them inside). */
  private move(delta: number): void {
    const rows = this.rows();
    if (!rows.length) return;
    const current = this.focused();
    const next = current < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, current + delta));
    this.focused.set(next);
    this.table()?.focusRow(next);
    if (next >= rows.length - 1) this.loadMore();
  }

  private toggleFocused(): void {
    const row = this.rows()[this.focused()];
    if (!row) return;
    const selected = this.selection();
    this.selection.set(selected.includes(row.id) ? selected.filter((id) => id !== row.id) : [...selected, row.id]);
  }

  protected onRowFocus(event: FocusEvent): void {
    const row = (event.target as HTMLElement | null)?.closest?.('tr[data-index]');
    const index = Number(row?.getAttribute('data-index'));
    if (Number.isInteger(index)) {
      this.focused.set(index);
      if (index >= this.rows().length - 1) this.loadMore();
    }
  }

  // ---------- bulk actions ----------

  private async eachSelected(
    work: (row: MatterRow) => Promise<unknown>,
  ): Promise<{ done: MatterRow[]; failed: { row: MatterRow; error: unknown }[] }> {
    const rows = this.selectedRows();
    this.bulkBusy.set(true);
    try {
      const results = await Promise.allSettled(rows.map((row) => work(row)));
      const done: MatterRow[] = [];
      const failed: { row: MatterRow; error: unknown }[] = [];
      results.forEach((result, i) => {
        const row = rows[i] as MatterRow;
        if (result.status === 'fulfilled') done.push(row);
        else failed.push({ row, error: result.reason });
      });
      return { done, failed };
    } finally {
      this.bulkBusy.set(false);
    }
  }

  private plural(n: number): string {
    return n === 1 ? '1 matter' : `${n} matters`;
  }

  protected async bulkAssign(uid: string): Promise<void> {
    if (!this.canEdit()) return;
    const repo = this.mattersRepo;
    const { done, failed } = await this.eachSelected((row) =>
      row.responsibleUid === uid ? Promise.resolve() : repo.update(row.id, { responsibleUid: uid }),
    );
    const name = this.memberName(uid);
    this.toasts.show(
      failed.length
        ? {
            title: `Assigned ${this.plural(done.length)} to ${name}; ${failed.length} didn’t change`,
            description: errorCopy(failed[0]?.error),
            tone: done.length ? 'neutral' : 'danger',
          }
        : { title: `Assigned ${this.plural(done.length)} to ${name}`, tone: 'success' },
    );
    this.selection.set(failed.map((f) => f.row.id));
  }

  protected async bulkLabel(): Promise<void> {
    if (!this.canEdit()) return;
    const label = await this.askName({ title: 'Add a label', label: 'Label', confirm: 'Add label', maxLength: 40 });
    if (!label) return;
    const repo = this.mattersRepo;
    const { done, failed } = await this.eachSelected((row) =>
      row.labels.includes(label) ? Promise.resolve() : repo.update(row.id, { labels: [...row.labels, label] }),
    );
    this.toasts.show(
      failed.length
        ? {
            title: `Labelled ${this.plural(done.length)}; ${failed.length} didn’t change`,
            description: errorCopy(failed[0]?.error),
            tone: done.length ? 'neutral' : 'danger',
          }
        : { title: `Added “${label}” to ${this.plural(done.length)}`, tone: 'success' },
    );
    this.selection.set(failed.map((f) => f.row.id));
  }

  protected async bulkStatus(to: MatterStatus): Promise<void> {
    if (!this.canStatus()) return;
    const { done, failed } = await this.eachSelected((row) =>
      this.callables.call<{ matterId: string; to: MatterStatus }, ChangeMatterStatusResult>(
        MATTER_CALLABLES.changeStatus,
        { matterId: row.id, to },
        { idempotent: true },
      ),
    );
    this.toasts.show(
      bulkStatusSummary(
        to,
        done.length,
        failed.map((f) => ({ number: f.row.number, message: changeStatusErrorCopy(f.error) })),
      ),
    );
    this.selection.set(failed.map((f) => f.row.id));
  }
}
