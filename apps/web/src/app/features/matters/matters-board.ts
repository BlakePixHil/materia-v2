import { CdkDrag, CdkDropList, CdkDropListGroup, type CdkDragDrop } from '@angular/cdk/drag-drop';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
} from '@angular/core';

import { OrgContext } from '@materia/data-access';
import {
  MATTER_CALLABLES,
  mattersRepository,
  orgBoardSettingsRepository,
  withBoardWipLimitSetting,
} from '@materia/data-access/repository';
import {
  boardWipState,
  MATTER_BOARD_COLUMN_PAGE,
  MATTER_STATUS_LABELS,
  planBoardMove,
  rebalanceBoardOrders,
  transitionRequirements,
  type BoardWipState,
  type ChangeMatterStageResult,
  type ChangeMatterStatusResult,
  type MatterStatus,
  type RebalanceBoardResult,
} from '@materia/domain';
import {
  DialogService,
  MT_MENU,
  MtAvatar,
  MtButton,
  MtIconButton,
  MtMatterCard,
  MtStatusIcon,
  MtTooltip,
  ToastService,
  type MatterCardVm,
} from '@materia/ui';

import { MatterNameDialog, type MatterNameDialogData } from './matter-name-dialog';
import {
  buildLanes,
  cardSpots,
  cellLabel,
  columnIndex,
  moveAnnouncement,
  movedCards,
  placeCards,
  sortCards,
  STATUS_KIND,
  wipWarning,
  type BoardCard,
  type BoardCell,
  type BoardColumn,
  type BoardLane,
  type CardSpot,
  type PendingPlacement,
} from './matters-board-view';
import { changeStatusErrorCopy, type MatterRow } from './matters-view';
import { WipLimitDialog, type WipLimitDialogData } from './wip-limit-dialog';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { isEditable } from '../../core/shortcuts/shortcut.service';
import { eventKindLabel, keyFactLabel, matterErrorCopy, stageRequirementsOf } from '../matter-detail/matter-view';

/** A drop list's data: the lane and column it is in. */
interface CellRef {
  lane: string;
  column: BoardColumn;
}

/** How long a card someone else moved flashes. */
const FLASH_MS = 1600;
/** How long a card moved here keeps focus while the board re-renders around it. */
const FOLLOW_MS = 1500;
/** A move still unconfirmed by the server after this long stops overriding it. */
const SETTLE_MS = 15_000;

/**
 * The Matters board (CORE-04): the view's matters as MatterCards in columns, by status or (one type
 * filtered) by stage, optionally in swimlanes by responsible lawyer. Cards move by drag and drop
 * (CDK; long-press on touch) or the keyboard: `m` on a focused card opens "Move to…" (which also has
 * Move up and Move down, so nothing needs a drag, WCAG 2.5.7), Alt+↑/↓
 * reorders, arrows move focus. A move across columns is optimistic and goes through
 * `matters-changeStatus` or `matters-changeStage`, which validate it; a refusal puts the card back
 * with a toast saying why. The order within a column is the matter's `boardOrder` (a midpoint of
 * its neighbours; `matters-rebalanceBoard` when precision runs out). Moves are announced.
 *
 * WIP limits (CORE-04a): owners and admins set a column's limit from its menu (kept on the org).
 * A column with one counts its matters against it ("7 / 5", in a warning tone once over); a move
 * past the limit still goes ahead, with one warning per column while the board is open.
 */
@Component({
  selector: 'mt-matters-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CdkDrag,
    CdkDropList,
    CdkDropListGroup,
    MT_MENU,
    MtAvatar,
    MtButton,
    MtIconButton,
    MtMatterCard,
    MtStatusIcon,
    MtTooltip,
  ],
  host: { class: 'mt-board', '(keydown)': 'onKey($event)', '[attr.data-swimlanes]': 'swimlanes() ? "" : null' },
  template: `
    <div class="mt-sr" aria-live="polite" aria-atomic="true">{{ announcement() }}</div>
    <div class="scroll">
      @for (lane of lanes(); track lane.key) {
        <section class="lane" cdkDropListGroup [attr.aria-label]="swimlanes() ? lane.label : null">
          @if (swimlanes()) {
            <h2 class="lane-head">
              @if (lane.key !== 'all') {
                <mt-avatar size="xs" [name]="lane.label" [colorKey]="lane.key" />
              }
              <span>{{ lane.label }}</span>
              <span class="mt-count">{{ lane.count }}</span>
            </h2>
          }
          <div class="cells">
            @for (cell of lane.cells; track cell.column.id) {
              <div class="column" [attr.data-column]="cell.column.id">
                <div class="col-head">
                  <mt-status-icon [status]="headIcon(cell.column)" [label]="cell.column.title" />
                  <!-- Level 2: the columns sit straight under the page's h1 (SEC-06). -->
                  <h2 class="col-title" [mtTooltip]="cell.column.description ?? ''">{{ cell.column.title }}</h2>
                  @let limit = limitOf(cell.column);
                  @if (!limit || swimlanes()) {
                    <span class="mt-count">{{ cell.cards.length }}</span>
                  }
                  @if (limit) {
                    <span
                      class="mt-count wip"
                      [attr.data-wip]="wipOf(cell.column)"
                      [mtTooltip]="wipTip(cell.column, limit)"
                      >{{ totalOf(cell.column) }} / {{ limit }}</span
                    >
                  }
                  @if (canSetLimits() && cell.column.wipKey && orgLoaded()) {
                    <button
                      mtIconButton
                      class="col-menu"
                      icon="more"
                      size="sm"
                      [label]="cell.column.title + ' column options'"
                      [mtMenuTrigger]="columnMenu"
                    ></button>
                    <ng-template #columnMenu>
                      <mt-menu [attr.aria-label]="cell.column.title + ' column options'">
                        <button mtMenuItem (click)="editLimit(cell.column)">
                          {{ limit ? 'Change WIP limit…' : 'Set WIP limit…' }}
                        </button>
                        @if (limit) {
                          <button mtMenuItem (click)="saveLimit(cell.column, null)">Remove WIP limit</button>
                        }
                      </mt-menu>
                    </ng-template>
                  }
                </div>
                <div
                  class="cards mt-stagger"
                  role="list"
                  [attr.aria-label]="listLabel(lane, cell)"
                  cdkDropList
                  [cdkDropListData]="cellRef(lane, cell)"
                  [cdkDropListEnterPredicate]="canEnter"
                  [cdkDropListDisabled]="!canEdit()"
                  (cdkDropListDropped)="dropped($event)"
                >
                  @for (card of cell.cards.slice(0, shown(lane, cell)); track card.row.id) {
                    <div
                      class="card"
                      role="listitem"
                      cdkDrag
                      [cdkDragData]="card"
                      [cdkDragDisabled]="!movable(card)"
                      [cdkDragStartDelay]="touchDelay"
                      [attr.data-id]="card.row.id"
                      [attr.data-flash]="flashed().has(card.row.id) ? '' : null"
                      [attr.aria-busy]="moving().has(card.row.id) ? 'true' : null"
                    >
                      <mt-matter-card [matter]="vm(card, cell.column)" (open)="openMatter()(card.row)">
                        @if (movable(card)) {
                          <button
                            mtMatterCardAction
                            mtIconButton
                            class="move"
                            icon="more"
                            size="sm"
                            tabindex="-1"
                            [label]="'Move ' + card.row.number + ' to… (M)'"
                            [mtMenuTrigger]="moveMenu"
                          ></button>
                        }
                      </mt-matter-card>
                      <ng-template #moveMenu>
                        <mt-menu [attr.aria-label]="'Move ' + card.row.number + ' to'">
                          @for (column of targets(); track column.id) {
                            <button
                              mtMenuItem
                              [icon]="column.id === card.column ? 'check' : undefined"
                              [disabled]="column.id === card.column || !canMoveAcross()"
                              (click)="moveVia(card, column)"
                            >
                              {{ column.title }}
                            </button>
                          }
                          @if (cell.cards.length > 1) {
                            <!-- Reordering without dragging (WCAG 2.5.7, SEC-06): Alt+↑/↓'s moves. -->
                            <mt-menu-separator />
                            <button
                              mtMenuItem
                              [disabled]="cell.cards.indexOf(card) === 0"
                              (click)="nudge(card, cell, -1)"
                            >
                              Move up
                            </button>
                            <button
                              mtMenuItem
                              [disabled]="cell.cards.indexOf(card) === cell.cards.length - 1"
                              (click)="nudge(card, cell, 1)"
                            >
                              Move down
                            </button>
                          }
                        </mt-menu>
                      </ng-template>
                    </div>
                  } @empty {
                    <p class="empty" role="listitem">No matters</p>
                  }
                </div>
                @if (cell.cards.length > shown(lane, cell)) {
                  <button mtButton variant="ghost" size="sm" class="more" (click)="showMore(lane, cell)">
                    Show {{ moreCount(lane, cell) }} more
                  </button>
                }
              </div>
            }
          </div>
        </section>
      }
    </div>
  `,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/count.css'],
  styles: `
    :host {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: var(--bg-canvas);
    }
    .scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: var(--space-16) var(--space-20);
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
    }
    .lane {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    :host:not([data-swimlanes]) .lane {
      flex: 1;
      min-height: 0;
    }
    .lane-head {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      margin: 0;
      font: 600 13px/18px var(--font-sans);
      color: var(--text-primary);
    }
    .cells {
      display: flex;
      gap: var(--space-12);
      align-items: stretch;
      min-height: 0;
      flex: 1;
    }
    /* Four status columns fit a 13-inch laptop; longer stage boards scroll sideways. */
    .column {
      flex: 1 0 224px;
      max-width: 320px;
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      min-height: 0;
    }
    .col-head {
      display: flex;
      align-items: center;
      gap: var(--space-6);
      height: 32px;
      padding: 0 var(--space-4);
    }
    .col-title {
      margin: 0;
      font: 500 13px/18px var(--font-sans);
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .col-head .mt-count {
      flex: none;
      white-space: nowrap;
    }
    /* Over its WIP limit (CORE-04a). */
    .mt-count[data-wip='over'] {
      background: var(--bg-warning-subtle);
      color: var(--text-warning);
    }
    .col-menu {
      margin-left: auto;
      flex: none;
    }
    .cards {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      min-height: 64px;
      padding: 2px;
      border-radius: var(--radius-md);
    }
    :host:not([data-swimlanes]) .cards {
      flex: 1;
      overflow-y: auto;
    }
    .cards.cdk-drop-list-dragging,
    .cards.cdk-drop-list-receiving {
      background: var(--bg-hover);
    }
    .card {
      position: relative;
      border-radius: var(--radius-md);
    }
    .card mt-matter-card {
      display: flex;
    }
    .card[aria-busy] {
      opacity: 0.7;
    }
    .card .move {
      opacity: 0;
    }
    .card:hover .move,
    .card:focus-within .move,
    .card .move[aria-expanded='true'] {
      opacity: 1;
    }
    .card[data-flash] mt-matter-card {
      animation: mt-board-flash ${FLASH_MS}ms ease-out;
    }
    @keyframes mt-board-flash {
      from {
        background: var(--bg-selected);
        border-color: var(--border-focus);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .card[data-flash] mt-matter-card {
        animation: none;
        border-color: var(--border-focus);
      }
    }
    .cdk-drag-preview {
      box-shadow: var(--shadow-dialog);
      border-radius: var(--radius-md);
    }
    .cdk-drag-placeholder {
      opacity: 0.35;
    }
    .cdk-drag-animating,
    .cards.cdk-drop-list-dragging .card:not(.cdk-drag-placeholder) {
      transition: transform 200ms cubic-bezier(0, 0, 0.2, 1);
    }
    @media (prefers-reduced-motion: reduce) {
      .cdk-drag-animating,
      .cards.cdk-drop-list-dragging .card:not(.cdk-drag-placeholder) {
        transition: none;
      }
    }
    .empty {
      margin: 0;
      padding: var(--space-12) var(--space-8);
      text-align: center;
      border: 1px dashed var(--border-default);
      border-radius: var(--radius-md);
      font: 400 12px/16px var(--font-sans);
      color: var(--text-tertiary);
    }
    .more {
      align-self: center;
    }
    @media (max-width: 900px) {
      .scroll {
        padding: var(--space-12);
      }
      .column {
        flex-basis: 236px;
      }
    }
  `,
})
export class MattersBoard {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly callables = inject(CALLABLES);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly context = inject(OrgContext);
  private readonly mattersRepo = mattersRepository();
  private readonly orgRepo = orgBoardSettingsRepository();

  /** The view's matters on the board (already filtered). */
  readonly rows = input.required<readonly MatterRow[]>();
  readonly columns = input.required<readonly BoardColumn[]>();
  readonly swimlanes = input(false);
  readonly memberName = input.required<(uid: string) => string>();
  readonly clientsOf = input.required<(row: MatterRow) => string>();
  /** `matter.edit`: reorder, and move between stages. */
  readonly canEdit = input(false);
  /** `matter.status`: move between statuses, and back a stage when templates are on. */
  readonly canStatus = input(false);
  /** Matter templates (CORE-07): moving back a stage needs a lawyer and a reason. */
  readonly templatesOn = input(false);
  /** Opens a card's matter (an input: the board is created through NgComponentOutlet). */
  readonly openMatter = input<(row: MatterRow) => void>(() => undefined);
  /** `org.settings` (owners and admins): set the columns' WIP limits. */
  readonly canSetLimits = input(false);

  /** Long-press to drag on touch, so a finger still scrolls the board. */
  protected readonly touchDelay = { touch: 400, mouse: 0 };

  private readonly pending = signal<ReadonlyMap<string, PendingPlacement>>(new Map());
  protected readonly moving = signal<ReadonlySet<string>>(new Set());
  protected readonly flashed = signal<ReadonlySet<string>>(new Set());
  protected readonly announcement = signal('');
  private readonly limits = signal<Readonly<Record<string, number>>>({});
  /** Cards moved here lately: the server catching up with them isn't someone else's move. */
  private readonly recent = new Map<string, number>();
  /** Columns already warned about going over their WIP limit while the board is open. */
  private readonly warned = new Set<string>();
  private follow: { id: string; until: number } | null = null;

  private readonly cards = computed(() => placeCards(this.rows(), this.columns(), this.pending()));
  protected readonly lanes = computed<BoardLane[]>(() => {
    const name = this.memberName();
    return buildLanes(
      this.cards(),
      this.columns(),
      this.swimlanes() ? (row) => ({ key: row.responsibleUid, label: name(row.responsibleUid) }) : null,
    );
  });
  /** Columns a card can be moved to. */
  protected readonly targets = computed(() => this.columns().filter((column) => column.droppable));
  private readonly kind = computed(() => this.columns()[0]?.kind ?? 'status');
  /** Moving between columns: statuses need `matter.status`; stages need `matter.edit`. */
  protected readonly canMoveAcross = computed(() => (this.kind() === 'status' ? this.canStatus() : this.canEdit()));

  /** The org's WIP limits (CORE-04a); none while the org loads or when it can't be read. */
  private readonly org = this.orgRepo.watch(() => this.context.orgId());
  private readonly wipLimits = computed(() => this.org.value()?.settings?.board?.wipLimits ?? {});
  /** A limit is saved with the rest of the org's settings, so only once they've loaded. */
  protected readonly orgLoaded = computed(() => !!this.org.value());
  /** Every column's matters on the board, across lanes (what a WIP limit counts). */
  private readonly totals = computed(() => {
    const totals = new Map<string, number>();
    for (const card of this.cards()) totals.set(card.column, (totals.get(card.column) ?? 0) + 1);
    return totals;
  });

  constructor() {
    // Moves the server has confirmed stop overriding it.
    effect(() => {
      const rows = new Map(this.rows().map((row) => [row.id, row] as const));
      const columns = this.columns();
      const pending = untracked(this.pending);
      const busy = untracked(this.moving);
      let changed = false;
      const next = new Map(pending);
      for (const [id, placement] of pending) {
        const row = rows.get(id);
        if (busy.has(id) || !row) continue;
        const column = placeCards([row], columns, new Map())[0]?.column;
        const columnDone = placement.column === undefined || placement.column === column;
        const orderDone = placement.boardOrder === undefined || placement.boardOrder === row.boardOrder;
        if (columnDone && orderDone) {
          next.delete(id);
          changed = true;
        }
      }
      if (changed) untracked(() => this.pending.set(next));
    });

    // Someone else moved a card: it jumps, with a short flash.
    let spots: Map<string, CardSpot> | null = null;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    effect(() => {
      const next = cardSpots(this.rows(), this.columns());
      const previous = spots;
      spots = next;
      if (!previous) return;
      const now = Date.now();
      const local = untracked(this.pending);
      const moved = movedCards(previous, next).filter((id) => !local.has(id) && !((this.recent.get(id) ?? 0) > now));
      if (!moved.length) return;
      untracked(() => this.flashed.update((set) => new Set([...set, ...moved])));
      const timer = setTimeout(() => {
        timers.delete(timer);
        this.flashed.update((set) => new Set([...set].filter((id) => !moved.includes(id))));
      }, FLASH_MS);
      timers.add(timer);
    });
    inject(DestroyRef).onDestroy(() => timers.forEach((timer) => clearTimeout(timer)));

    // A card moved from the keyboard keeps focus while the board re-renders around it.
    effect(() => {
      this.lanes();
      untracked(() => afterNextRender(() => this.keepFocus(), { injector: this.injector }));
    });
  }

  // ---------- drawing ----------

  protected vm(card: BoardCard, column: BoardColumn): MatterCardVm {
    const row = card.row;
    const name = this.memberName();
    const people = [...new Set([row.responsibleUid, ...row.teamUids])].map((uid) => ({ id: uid, name: name(uid) }));
    const client = this.clientsOf()(row);
    return {
      id: row.id,
      ref: row.number,
      title: row.title,
      client: client || undefined,
      type: row.type,
      status: STATUS_KIND[row.status],
      stage: column.kind === 'stage' ? column.title : MATTER_STATUS_LABELS[row.status],
      priority: row.priority,
      nextDeadline: row.nextDeadline
        ? { due: row.nextDeadline.dueDate, critical: row.nextDeadline.critical, trace: row.nextDeadline.title }
        : null,
      people,
      openTasks: row.openTaskCount,
    };
  }

  protected headIcon(column: BoardColumn) {
    return column.status ? STATUS_KIND[column.status] : column.droppable ? 'active' : 'draft';
  }

  protected listLabel(lane: BoardLane, cell: BoardCell): string {
    return cellLabel({
      column: cell.column.title,
      ...(this.swimlanes() ? { lane: lane.label } : {}),
      count: cell.cards.length,
      total: this.totalOf(cell.column),
      limit: this.limitOf(cell.column),
    });
  }

  // ---------- WIP limits (CORE-04a) ----------

  protected limitOf(column: BoardColumn): number | undefined {
    return column.wipKey ? this.wipLimits()[column.wipKey] : undefined;
  }

  protected totalOf(column: BoardColumn): number {
    return this.totals().get(column.id) ?? 0;
  }

  protected wipOf(column: BoardColumn): BoardWipState {
    return boardWipState(this.totalOf(column), this.limitOf(column));
  }

  protected wipTip(column: BoardColumn, limit: number): string {
    const total = this.totalOf(column);
    return `${total} ${total === 1 ? 'matter' : 'matters'} in the column; WIP limit ${limit}`;
  }

  protected async editLimit(column: BoardColumn): Promise<void> {
    const initial = this.limitOf(column);
    const data: WipLimitDialogData = { column: column.title, ...(initial ? { initial } : {}) };
    const limit = await this.dialogs.open<WipLimitDialogData, number | undefined>(WipLimitDialog, { data }).result;
    if (limit !== undefined && limit !== initial) await this.saveLimit(column, limit);
  }

  /** Saves a column's limit on the org (`null` removes it), keeping the org's other settings. */
  protected async saveLimit(column: BoardColumn, limit: number | null): Promise<void> {
    const orgId = this.context.orgId();
    if (!orgId || !column.wipKey || !this.orgLoaded()) return;
    try {
      await this.orgRepo.update(orgId, {
        settings: withBoardWipLimitSetting(this.org.value()?.settings, column.wipKey, limit),
      });
      // A new limit gets its own warning.
      this.warned.delete(column.id);
      const title = limit === null ? `${column.title} has no WIP limit` : `${column.title}’s WIP limit is ${limit}`;
      this.toasts.show({ title, tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'The WIP limit didn’t save', description: errorCopy(error), tone: 'danger' });
    }
  }

  /** The first move that takes a column past its limit warns; later ones don't, while the board is open. */
  private warnIfOver(column: BoardColumn, total: number): void {
    const limit = this.limitOf(column);
    if (!limit || total <= limit || this.warned.has(column.id)) return;
    this.warned.add(column.id);
    this.toasts.show(wipWarning(column.title, total, limit));
  }

  /** The drop list's data, kept stable between renders so CDK doesn't see a new container. */
  private readonly refs = new Map<string, CellRef>();
  protected cellRef(lane: BoardLane, cell: BoardCell): CellRef {
    const key = `${lane.key}|${cell.column.id}`;
    const ref = this.refs.get(key);
    if (ref && ref.column === cell.column) return ref;
    const next = { lane: lane.key, column: cell.column };
    this.refs.set(key, next);
    return next;
  }

  private limitKey(lane: BoardLane, cell: BoardCell): string {
    return `${lane.key}|${cell.column.id}`;
  }

  protected shown(lane: BoardLane, cell: BoardCell): number {
    return this.limits()[this.limitKey(lane, cell)] ?? MATTER_BOARD_COLUMN_PAGE;
  }

  protected moreCount(lane: BoardLane, cell: BoardCell): number {
    return Math.min(MATTER_BOARD_COLUMN_PAGE, cell.cards.length - this.shown(lane, cell));
  }

  protected showMore(lane: BoardLane, cell: BoardCell): void {
    const key = this.limitKey(lane, cell);
    this.limits.update((limits) => ({ ...limits, [key]: this.shown(lane, cell) + MATTER_BOARD_COLUMN_PAGE }));
  }

  protected movable(card: BoardCard): boolean {
    if (!this.canEdit() || this.moving().has(card.row.id)) return false;
    // Closed and archived matters keep their stage.
    return this.kind() === 'status' || (card.row.status !== 'closed' && card.row.status !== 'archived');
  }

  /** Drops land in the card's own column, or (with the right role) another droppable one in its lane. */
  protected readonly canEnter = (drag: CdkDrag<BoardCard>, drop: CdkDropList<CellRef>): boolean => {
    const from = drag.dropContainer.data as CellRef;
    const to = drop.data;
    if (from.lane !== to.lane) return false;
    if (from.column.id === to.column.id) return true;
    return to.column.droppable && this.canMoveAcross();
  };

  // ---------- moving ----------

  protected dropped(event: CdkDragDrop<CellRef, CellRef, BoardCard>): void {
    const card = event.item.data;
    const from = event.previousContainer.data;
    const to = event.container.data;
    if (from === to && event.previousIndex === event.currentIndex) return;
    const lane = this.lanes().find((l) => l.key === to.lane);
    const laneCards = lane?.cells.find((cell) => cell.column.id === to.column.id)?.cards ?? [];
    const column = this.columnCards(to.column.id);
    void this.moveTo(card, to.column, columnIndex(column, laneCards, card.row.id, event.currentIndex));
  }

  /** From the "Move to…" menu: to the top of the column. */
  protected moveVia(card: BoardCard, column: BoardColumn): void {
    this.follow = { id: card.row.id, until: Date.now() + FOLLOW_MS };
    void this.moveTo(card, column, 0);
  }

  /** Alt+↑/↓ on a card, or Move up and Move down in its menu: one place up or down its column. */
  protected nudge(card: BoardCard, cell: BoardCell, delta: -1 | 1): void {
    if (!this.movable(card)) return;
    const to = cell.cards.indexOf(card) + delta;
    if (to < 0 || to >= cell.cards.length) {
      this.say(`${card.row.number} is already ${to < 0 ? 'first' : 'last'} in ${cell.column.title}.`);
      return;
    }
    // In the lane's cell without the card, the slot it moves to is `to`.
    const column = this.columnCards(cell.column.id);
    this.follow = { id: card.row.id, until: Date.now() + FOLLOW_MS };
    void this.moveTo(card, cell.column, columnIndex(column, cell.cards, card.row.id, to));
  }

  /** Every card in a column, across lanes, in board order. */
  private columnCards(columnId: string): BoardCard[] {
    return sortCards(this.cards().filter((card) => card.column === columnId));
  }

  private columnOf(id: string): BoardColumn | undefined {
    return this.columns().find((column) => column.id === id);
  }

  /**
   * Moves a card to `index` of `column` (in the whole column, without the card). Across columns:
   * asks for a reason when the move needs one, shows the move at once, calls the server, and puts
   * the card back with a toast when it refuses. Then saves the order (or rebalances the column).
   */
  private async moveTo(card: BoardCard, column: BoardColumn, index: number): Promise<void> {
    const row = card.row;
    if (this.moving().has(row.id) || !column.droppable) return;
    const from = this.columnOf(card.column);
    const across = card.column !== column.id;
    if (across && !this.canMoveAcross()) return;

    let reason: string | undefined;
    if (across && from) {
      const needs = this.reasonPrompt(from, column);
      if (needs === 'locked') {
        this.fail(row.number, column.title, 'Only a lawyer can move a matter back a stage.');
        return;
      }
      if (needs) {
        reason = await this.askReason(needs, column.title);
        if (!reason) return;
      }
    }

    const target = this.columnCards(column.id);
    const plan = planBoardMove(
      target.map((c) => ({ id: c.row.id, boardOrder: c.boardOrder, lastActivity: c.row.lastActivityAt?.getTime() })),
      row.id,
      index,
    );
    const orders =
      plan.kind === 'order'
        ? [{ id: plan.id, boardOrder: plan.order }]
        : rebalanceBoardOrders(plan.ids).map(({ id, boardOrder }) => ({ id, boardOrder }));
    const position = (plan.kind === 'order' ? Math.min(index, target.length) : plan.ids.indexOf(row.id)) + 1;
    const total = target.filter((c) => c.row.id !== row.id).length + 1;

    this.recent.set(row.id, Date.now() + SETTLE_MS);
    this.moving.update((set) => new Set([...set, row.id]));
    this.pending.update((map) => {
      const next = new Map(map);
      for (const { id, boardOrder } of orders) next.set(id, { ...next.get(id), boardOrder });
      next.set(row.id, { ...next.get(row.id), column: column.id });
      return next;
    });

    try {
      if (across) {
        try {
          await this.changeColumn(row, column, reason);
        } catch (error) {
          this.rollback(orders.map((o) => o.id));
          this.refused(row, column, error);
          return;
        }
        this.warnIfOver(column, total);
      }
      try {
        if (plan.kind === 'order') await this.mattersRepo.update(row.id, { boardOrder: plan.order });
        else {
          await this.callables.call<{ matterIds: string[] }, RebalanceBoardResult>(
            MATTER_CALLABLES.rebalanceBoard,
            { matterIds: plan.ids },
            { idempotent: true },
          );
        }
      } catch (error) {
        // The status or stage moved; only the place in the column didn't stick.
        this.rollback(
          orders.map((o) => o.id),
          !across,
        );
        this.toasts.show({ title: `Couldn’t keep ${row.number} in that place`, description: errorCopy(error) });
        return;
      }
      this.say(moveAnnouncement(row.number, column.title, position, total));
      // Unconfirmed moves stop overriding the server after a while.
      setTimeout(() => this.rollback(orders.map((o) => o.id)), SETTLE_MS);
    } finally {
      this.moving.update((set) => new Set([...set].filter((id) => id !== row.id)));
    }
  }

  private changeColumn(row: MatterRow, column: BoardColumn, reason: string | undefined): Promise<unknown> {
    const extra = reason ? { reason } : {};
    if (column.kind === 'status' && column.status) {
      return this.callables.call<{ matterId: string; to: MatterStatus; reason?: string }, ChangeMatterStatusResult>(
        MATTER_CALLABLES.changeStatus,
        { matterId: row.id, to: column.status, ...extra },
        { idempotent: true },
      );
    }
    return this.callables.call<{ matterId: string; stageId: string; reason?: string }, ChangeMatterStageResult>(
      MATTER_CALLABLES.changeStage,
      { matterId: row.id, stageId: column.stageId ?? '', ...extra },
      { idempotent: true },
    );
  }

  /** Whether the move needs a reason first: reopening, or (templates on) moving back a stage. */
  private reasonPrompt(from: BoardColumn, to: BoardColumn): 'reopen' | 'back' | 'locked' | null {
    if (to.kind === 'status') {
      return from.status && to.status && transitionRequirements(from.status, to.status).includes('reason')
        ? 'reopen'
        : null;
    }
    if (!this.templatesOn()) return null;
    const stages = this.columns();
    const back = stages.indexOf(to) < stages.indexOf(from) && from.droppable;
    if (!back) return null;
    return this.canStatus() ? 'back' : 'locked';
  }

  private async askReason(kind: 'reopen' | 'back', column: string): Promise<string | undefined> {
    const data: MatterNameDialogData =
      kind === 'reopen'
        ? {
            title: 'Reopen matter',
            label: 'Reason',
            confirm: 'Reopen',
            description: 'Say why the matter is reopening. The reason is kept in the matter’s activity.',
            maxLength: 500,
          }
        : {
            title: `Move back to ${column}`,
            label: 'Reason',
            confirm: 'Move back',
            description: 'Say why the matter is going back a stage. The reason is kept in the matter’s activity.',
            maxLength: 500,
          };
    return this.dialogs.open<MatterNameDialogData, string | undefined>(MatterNameDialog, { data }).result;
  }

  /** Puts cards back where the server has them (or, `orderOnly`, only their place in the column). */
  private rollback(ids: readonly string[], orderOnly = false): void {
    this.pending.update((map) => {
      const next = new Map(map);
      for (const id of ids) {
        const placement = next.get(id);
        if (!placement) continue;
        if (orderOnly && placement.column !== undefined) next.set(id, { column: placement.column });
        else next.delete(id);
      }
      return next;
    });
  }

  /** A refused move: the card is back; say why, and offer the matter when something needs recording. */
  private refused(row: MatterRow, column: BoardColumn, error: unknown): void {
    const needs = stageRequirementsOf(error);
    if (needs) {
      const items = [
        ...needs.facts.map(keyFactLabel),
        ...needs.events.map(eventKindLabel),
        ...needs.tasks.map((key) => key.replace(/_/g, ' ')),
      ];
      const description = items.length ? `Record first: ${items.join(', ')}.` : 'Complete what this stage needs first.';
      this.fail(row.number, column.title, description, {
        label: 'Open matter',
        run: () => this.openMatter()(row),
      });
      return;
    }
    const why = column.kind === 'status' ? changeStatusErrorCopy(error) : matterErrorCopy(error);
    // Closing goes through the matter's closing checklist (CORE-19).
    const closing =
      (error as { details?: { reason?: unknown } } | null)?.details?.reason === 'closing_checklist_required';
    this.fail(
      row.number,
      column.title,
      why,
      closing ? { label: 'Open matter', run: () => this.openMatter()(row) } : undefined,
    );
  }

  private fail(number: string, column: string, description: string, action?: { label: string; run: () => void }): void {
    this.toasts.show({
      title: `Couldn’t move ${number} to ${column}`,
      description,
      tone: 'danger',
      ...(action ? { action } : {}),
    });
    this.say(`Couldn’t move ${number} to ${column}. ${description}`);
  }

  private say(message: string): void {
    this.announcement.set('');
    queueMicrotask(() => this.announcement.set(message));
  }

  // ---------- keyboard ----------

  /** Keys pressed on a card (they bubble up from its title). */
  protected onKey(event: KeyboardEvent): void {
    if (event.isComposing || isEditable(event.target)) return;
    const element = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('.card[data-id]');
    const id = element?.dataset['id'];
    if (!id || event.ctrlKey || event.metaKey) return;
    const found = this.find(id);
    if (!found) return;
    const { lane, cellIndex, cardIndex } = found;
    const cell = lane.cells[cellIndex] as BoardCell;
    const card = cell.cards[cardIndex] as BoardCard;
    const key = event.key;

    if (key === 'm' && !event.altKey && !event.shiftKey) {
      const trigger = element.querySelector<HTMLElement>('.move');
      if (!trigger) return;
      event.preventDefault();
      trigger.click();
      return;
    }
    if (event.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      event.preventDefault();
      this.nudge(card, cell, key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (event.altKey || event.shiftKey) return;
    if (key.startsWith('Arrow')) this.follow = null;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault();
      const next = cell.cards[cardIndex + (key === 'ArrowUp' ? -1 : 1)];
      if (next) this.focusCard(next.row.id);
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      const step = key === 'ArrowLeft' ? -1 : 1;
      for (let i = cellIndex + step; i >= 0 && i < lane.cells.length; i += step) {
        const cards = (lane.cells[i] as BoardCell).cards;
        const next = cards[Math.min(cardIndex, cards.length - 1)];
        if (next) {
          this.focusCard(next.row.id);
          return;
        }
      }
    }
  }

  private find(id: string): { lane: BoardLane; cellIndex: number; cardIndex: number } | null {
    for (const lane of this.lanes()) {
      for (const [cellIndex, cell] of lane.cells.entries()) {
        const cardIndex = cell.cards.findIndex((card) => card.row.id === id);
        if (cardIndex >= 0) return { lane, cellIndex, cardIndex };
      }
    }
    return null;
  }

  private titleOf(id: string): HTMLElement | null {
    const card = [...this.host.nativeElement.querySelectorAll<HTMLElement>('.card[data-id]')].find(
      (element) => element.dataset['id'] === id,
    );
    return card?.querySelector<HTMLElement>('.name') ?? null;
  }

  /** Focuses a card's title (its button). */
  focusCard(id: string): void {
    this.titleOf(id)?.focus();
  }

  private keepFocus(): void {
    if (!this.follow) return;
    if (Date.now() > this.follow.until) {
      this.follow = null;
      return;
    }
    const active = document.activeElement;
    // Someone who has moved on (an open menu, a dialog, elsewhere on the page) keeps their focus.
    if (active && active !== document.body && !this.host.nativeElement.contains(active)) return;
    const title = this.titleOf(this.follow.id);
    if (title && active !== title) title.focus();
  }
}
