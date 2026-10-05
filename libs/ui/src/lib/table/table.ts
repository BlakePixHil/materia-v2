import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChild,
  contentChildren,
  DestroyRef,
  Directive,
  ElementRef,
  Injector,
  inject,
  input,
  model,
  output,
  signal,
  TemplateRef,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';

import { MtIcon } from '../icon/icon';
import { DensityService } from '../theme/density.service';

export type MtSortDirection = 'asc' | 'desc';

export interface MtSort {
  column: string;
  direction: MtSortDirection;
}

export type MtCellValue = string | number | null | undefined;

/** A column of a Table. */
export interface MtTableColumn<T> {
  id: string;
  header: string;
  /** Hide the header text visually (icon or checkbox columns); it stays the accessible name. */
  headerHidden?: boolean | undefined;
  sortable?: boolean | undefined;
  /** The cell text, when there is no `mtCell` template. Defaults to `row[id]`. */
  value?: ((row: T) => MtCellValue) | undefined;
  /** What to sort by, when it isn't the displayed value (a date, an amount in cents). */
  sortValue?: ((row: T) => MtCellValue) | undefined;
  /** Right-aligned tabular figures (money, units). */
  numeric?: boolean | undefined;
  /** A design-system cell style: `ref` (matter number) or `title`. */
  cellClass?: string | undefined;
  /** CSS width, such as `64px` or `30%`. */
  width?: string | undefined;
}

/** Context for an `mtCell` template. */
export interface MtCellContext<T> {
  $implicit: T;
  index: number;
}

/**
 * A custom cell for one column: `<ng-template mtCell="owner" let-row>…</ng-template>`.
 */
@Directive({ selector: 'ng-template[mtCell]' })
export class MtTableCell<T = unknown> {
  readonly column = input.required<string>({ alias: 'mtCell' });
  readonly template = inject<TemplateRef<MtCellContext<T>>>(TemplateRef);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the parameter only names the type guard
  static ngTemplateContextGuard<T>(_dir: MtTableCell<T>, _ctx: unknown): _ctx is MtCellContext<T> {
    return true;
  }
}

/** A group of rows: consecutive rows with the same key share a header row. */
export interface MtTableGroup {
  key: string;
  label: string;
}

/** Context for an `mtTableGroup` template. */
export interface MtGroupContext {
  $implicit: MtTableGroup & { count: number };
}

/**
 * A custom group header: `<ng-template mtTableGroup let-group>{{ group.label }}</ng-template>`.
 */
@Directive({ selector: 'ng-template[mtTableGroup]' })
export class MtTableGroupHeader {
  readonly template = inject<TemplateRef<MtGroupContext>>(TemplateRef);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the parameter only names the type guard
  static ngTemplateContextGuard(_dir: MtTableGroupHeader, _ctx: unknown): _ctx is MtGroupContext {
    return true;
  }
}

/** A rendered line of the table body: a group header or a row (with its index among the rows). */
export type MtTableItem<T> =
  { kind: 'group'; group: MtTableGroup & { count: number } } | { kind: 'row'; row: T; index: number };

/**
 * The body lines for rows in display order: with `groupOf`, a header before each run of rows that
 * share a group key.
 */
export function tableItems<T>(rows: readonly T[], groupOf: ((row: T) => MtTableGroup) | null): MtTableItem<T>[] {
  if (!groupOf) return rows.map((row, index) => ({ kind: 'row', row, index }));
  const items: MtTableItem<T>[] = [];
  let current: (MtTableGroup & { count: number }) | null = null;
  rows.forEach((row, index) => {
    const group = groupOf(row);
    if (!current || current.key !== group.key) {
      current = { ...group, count: 0 };
      items.push({ kind: 'group', group: current });
    }
    current.count++;
    items.push({ kind: 'row', row, index });
  });
  return items;
}

/** Rows ordered by group (groups in order of first appearance), keeping the order within each. */
export function groupRows<T>(rows: readonly T[], groupOf: (row: T) => MtTableGroup): T[] {
  const order = new Map<string, number>();
  for (const row of rows) {
    const key = groupOf(row).key;
    if (!order.has(key)) order.set(key, order.size);
  }
  return rows
    .map((row, index) => ({ row, index, group: order.get(groupOf(row).key) ?? 0 }))
    .sort((a, b) => a.group - b.group || a.index - b.index)
    .map((entry) => entry.row);
}

export type MtTableDensity = 'comfortable' | 'compact';

/** Row heights per density; virtual scrolling relies on them being fixed. */
export const MT_TABLE_ROW_HEIGHT: Record<MtTableDensity, number> = { comfortable: 40, compact: 32 };
const HEADER_HEIGHT = 32;
const OVERSCAN = 8;
const PAGE_ROWS = 10;
/** `endReached` fires when the scroll position is within this many rows of the end. */
const END_ROWS = 10;

const collator = new Intl.Collator('en-AU', { numeric: true, sensitivity: 'base' });

/** Compares two cell values: numbers numerically, text with en-AU collation; empty values last. */
export function compareCells(a: MtCellValue, b: MtCellValue): number {
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/** The cell value for a column: `value(row)`, else `row[id]`. */
export function cellValue<T>(column: MtTableColumn<T>, row: T): MtCellValue {
  if (column.value) return column.value(row);
  const raw = (row as Record<string, unknown>)[column.id];
  return typeof raw === 'string' || typeof raw === 'number'
    ? raw
    : raw === null || raw === undefined
      ? raw
      : String(raw);
}

/** Rows sorted by a column (stable; empty values last in either direction). */
export function sortRows<T>(rows: readonly T[], column: MtTableColumn<T> | undefined, direction: MtSortDirection): T[] {
  if (!column) return [...rows];
  const read = column.sortValue ?? ((row: T) => cellValue(column, row));
  const sign = direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, key: read(row) }))
    .sort((a, b) => {
      const aEmpty = a.key === null || a.key === undefined || a.key === '';
      const bEmpty = b.key === null || b.key === undefined || b.key === '';
      if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
      return sign * compareCells(a.key, b.key) || a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** The next sort when a header is clicked: ascending, then descending, then unsorted. */
export function nextSort(current: MtSort | null, column: string): MtSort | null {
  if (current?.column !== column) return { column, direction: 'asc' };
  return current.direction === 'asc' ? { column, direction: 'desc' } : null;
}

/** The rows to render for a scroll position: a window plus overscan, and the spacer heights around it. */
export function virtualWindow(
  total: number,
  scrollTop: number,
  viewport: number,
  rowHeight: number,
): { start: number; end: number; padTop: number; padBottom: number } {
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const start = Math.max(0, first - OVERSCAN);
  const end = Math.min(total, first + Math.ceil(viewport / rowHeight) + OVERSCAN);
  return { start, end, padTop: start * rowHeight, padBottom: Math.max(0, total - end) * rowHeight };
}

/**
 * Table (`mt-table`): a lightweight data table for lists of matters, deadlines, invoices and contacts.
 *
 * - Sortable headers (`aria-sort`); `sortMode="external"` leaves sorting to the caller (server-side).
 * - Checkbox selection (`selection`, by `rowKey`), with select-all.
 * - Keyboard: rows take focus; j/k or ↑/↓ move, Home/End and PageUp/PageDown jump, Enter (or a click)
 *   emits `open`, Space or x toggles selection.
 * - Sticky header inside a scroll container, `density`, and virtual scrolling from
 *   `virtualThreshold` rows (200 by default): only the visible rows are rendered.
 * - Custom cells with `<ng-template mtCell="column" let-row>`; an `[mtTableEmpty]` slot for no rows.
 * - Groups: `groupBy` returns each row's group; a header row (an `mtTableGroup` template, or the
 *   label and count) starts each group. Client sorting sorts within groups.
 * - `endReached` fires when scrolling nears the end, for infinite scroll.
 */
@Component({
  selector: 'mt-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/table.css',
    '../../generated/components/check.css',
    '../../generated/components/count.css',
  ],
  imports: [NgTemplateOutlet, MtIcon],
  host: { class: 'mt-table-host' },
  template: `
    <div #scroller class="mt-table-scroll" [style.max-height]="scrollHeight()" (scroll)="onScroll()">
      <table
        class="mt-table"
        [attr.aria-label]="label()"
        [attr.aria-rowcount]="virtual() ? items().length + 1 : null"
        [attr.data-density]="effectiveDensity() === 'compact' ? 'compact' : null"
      >
        <thead>
          <tr [attr.aria-rowindex]="virtual() ? 1 : null">
            @if (selectable()) {
              <th class="mt-table-select" scope="col">
                <button
                  type="button"
                  class="mt-check"
                  role="checkbox"
                  aria-label="Select all rows"
                  [attr.aria-checked]="allState()"
                  [attr.data-checked]="allState() === 'true' ? '' : null"
                  [attr.data-indeterminate]="allState() === 'mixed' ? '' : null"
                  [disabled]="sortedRows().length === 0"
                  (click)="toggleAll()"
                >
                  <mt-icon [name]="allState() === 'mixed' ? 'minus' : 'check'" />
                </button>
              </th>
            }
            @for (column of columns(); track column.id) {
              <th
                scope="col"
                [class.num]="column.numeric"
                [style.width]="column.width ?? null"
                [attr.aria-sort]="ariaSort(column)"
              >
                @if (column.sortable) {
                  <button type="button" class="mt-table-sort" (click)="toggleSort(column)">
                    <span [class.mt-sr]="column.headerHidden">{{ column.header }}</span>
                    <mt-icon
                      [name]="sortIcon(column)"
                      [attr.data-dir]="sort()?.column === column.id ? sort()?.direction : null"
                    />
                  </button>
                } @else {
                  <span [class.mt-sr]="column.headerHidden">{{ column.header }}</span>
                }
              </th>
            }
          </tr>
        </thead>
        <tbody>
          @if (sortedRows().length === 0) {
            <tr class="mt-table-empty">
              <td [attr.colspan]="colspan()"><ng-content select="[mtTableEmpty]" /></td>
            </tr>
          }
          @if (window().padTop > 0) {
            <tr class="mt-table-spacer" aria-hidden="true">
              <td [attr.colspan]="colspan()" [style.height.px]="window().padTop"></td>
            </tr>
          }
          @for (item of visibleItems(); track itemKey(item); let i = $index) {
            @if (item.kind === 'group') {
              <tr
                class="group"
                style="cursor: default"
                [attr.aria-rowindex]="virtual() ? window().start + i + 2 : null"
                [style.height.px]="virtual() ? rowHeight() : null"
              >
                <td [attr.colspan]="colspan()">
                  @if (groupTemplate(); as header) {
                    <ng-container *ngTemplateOutlet="header.template; context: { $implicit: item.group }" />
                  } @else {
                    <span class="mt-row">
                      <span class="t-1">{{ item.group.label }}</span>
                      <span class="mt-count">{{ item.group.count }}</span>
                    </span>
                  }
                </td>
              </tr>
            } @else {
              @let row = item.row;
              @let index = item.index;
              @let key = rowKey()(row);
              <tr
                [attr.data-index]="index"
                [attr.tabindex]="index === activeIndex() ? 0 : -1"
                [attr.data-selected]="selectedSet().has(key) ? '' : null"
                [attr.data-active]="index === activeIndex() ? '' : null"
                [attr.aria-rowindex]="virtual() ? window().start + i + 2 : null"
                (click)="onRowClick($event, index)"
                (focus)="activeIndex.set(index)"
                (keydown)="onKeydown($event)"
              >
                @if (selectable()) {
                  <td class="mt-table-select">
                    <button
                      type="button"
                      class="mt-check"
                      role="checkbox"
                      tabindex="-1"
                      [attr.aria-label]="'Select ' + labelFor(row)"
                      [attr.aria-checked]="selectedSet().has(key)"
                      [attr.data-checked]="selectedSet().has(key) ? '' : null"
                      (click)="toggleRow(key); $event.stopPropagation()"
                    >
                      <mt-icon name="check" />
                    </button>
                  </td>
                }
                @for (column of columns(); track column.id) {
                  <td [class.num]="column.numeric" [class]="column.cellClass ?? ''">
                    @if (templates()[column.id]; as cell) {
                      <ng-container *ngTemplateOutlet="cell; context: { $implicit: row, index: index }" />
                    } @else {
                      {{ display(column, row) }}
                    }
                  </td>
                }
              </tr>
            }
          }
          @if (window().padBottom > 0) {
            <tr class="mt-table-spacer" aria-hidden="true">
              <td [attr.colspan]="colspan()" [style.height.px]="window().padBottom"></td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class MtTable<T> {
  readonly rows = input.required<readonly T[]>();
  readonly columns = input.required<readonly MtTableColumn<T>[]>();
  /** A stable id per row; selection is a list of these. */
  readonly rowKey = input.required<(row: T) => string>();
  /** Accessible name of the table ("Matters"). */
  readonly label = input.required<string>();
  /** How a row is named in its checkbox ("Select Estate of …"); defaults to the key. */
  readonly rowLabel = input<(row: T) => string>();
  readonly selectable = input(false, { transform: booleanAttribute });
  readonly selection = model<readonly string[]>([]);
  readonly sort = model<MtSort | null>(null);
  /** `client` sorts `rows` here; `external` only reports the sort for the caller to apply. */
  readonly sortMode = input<'client' | 'external'>('client');
  /** Row height; the person's density preference (CORE-20) when not set. */
  readonly density = input<MtTableDensity | undefined>(undefined);
  /** Virtualise from this many rows. */
  readonly virtualThreshold = input(200);
  /** Height of the scroll container (CSS); virtual tables default to 480px. */
  readonly maxHeight = input<string>();

  /** Groups rows under header rows (by status, owner…); null for a flat table. */
  readonly groupBy = input<((row: T) => MtTableGroup) | null>(null);

  /** A row was opened (Enter or click). */
  readonly open = output<T>();
  /** Scrolling reached the last rows (load the next page). */
  readonly endReached = output();

  private readonly cells = contentChildren(MtTableCell);
  protected readonly groupTemplate = contentChild(MtTableGroupHeader);
  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly activeIndex = signal(0);
  private readonly scrollTop = signal(0);
  private readonly viewport = signal(480);

  protected readonly templates = computed(() => {
    const map: Record<string, TemplateRef<MtCellContext<T>>> = {};
    for (const cell of this.cells()) map[cell.column()] = cell.template as TemplateRef<MtCellContext<T>>;
    return map;
  });
  protected readonly sortedRows = computed(() => {
    const sort = this.sort();
    const groupOf = this.groupBy();
    let rows: readonly T[] = this.rows();
    if (sort && this.sortMode() === 'client') {
      const column = this.columns().find((c) => c.id === sort.column && c.sortable);
      rows = sortRows(rows, column, sort.direction);
    }
    return groupOf ? groupRows(rows, groupOf) : rows;
  });
  /** The body lines: group headers and rows. Virtual scrolling windows over these. */
  protected readonly items = computed(() => tableItems(this.sortedRows(), this.groupBy()));
  protected readonly virtual = computed(() => this.items().length >= this.virtualThreshold());
  private readonly preferredDensity = inject(DensityService).density;
  protected readonly effectiveDensity = computed(() => this.density() ?? this.preferredDensity());
  protected readonly rowHeight = computed(() => MT_TABLE_ROW_HEIGHT[this.effectiveDensity()]);
  protected readonly scrollHeight = computed(() => this.maxHeight() ?? (this.virtual() ? '480px' : null));
  protected readonly window = computed(() => {
    const total = this.items().length;
    if (!this.virtual()) return { start: 0, end: total, padTop: 0, padBottom: 0 };
    return virtualWindow(total, this.scrollTop(), this.viewport(), this.rowHeight());
  });
  protected readonly visibleItems = computed(() => this.items().slice(this.window().start, this.window().end));
  /** Each row's position among the body lines (group headers above it push it down). */
  private readonly itemIndex = computed(() => {
    const positions: number[] = [];
    this.items().forEach((item, position) => {
      if (item.kind === 'row') positions[item.index] = position;
    });
    return positions;
  });
  protected readonly selectedSet = computed(() => new Set(this.selection()));
  protected readonly colspan = computed(() => this.columns().length + (this.selectable() ? 1 : 0));
  protected readonly allState = computed<'true' | 'false' | 'mixed'>(() => {
    const total = this.sortedRows().length;
    const selected = this.selectedSet();
    if (total === 0 || selected.size === 0) return 'false';
    const all = this.sortedRows().every((row) => selected.has(this.rowKey()(row)));
    return all ? 'true' : 'mixed';
  });

  constructor() {
    afterNextRender(() => {
      const element = this.scroller().nativeElement;
      this.viewport.set(Math.max(0, (element.clientHeight || 480) - HEADER_HEIGHT));
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => this.viewport.set(Math.max(0, element.clientHeight - HEADER_HEIGHT)));
      observer.observe(element);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  protected itemKey(item: MtTableItem<T>): string {
    return item.kind === 'group' ? `group:${item.group.key}` : `row:${this.rowKey()(item.row)}`;
  }

  protected display(column: MtTableColumn<T>, row: T): string {
    const value = cellValue(column, row);
    return value === null || value === undefined || value === '' ? '—' : String(value);
  }

  protected labelFor(row: T): string {
    return (this.rowLabel() ?? this.rowKey())(row);
  }

  protected ariaSort(column: MtTableColumn<T>): string | null {
    if (!column.sortable) return null;
    const sort = this.sort();
    if (sort?.column !== column.id) return 'none';
    return sort.direction === 'asc' ? 'ascending' : 'descending';
  }

  protected sortIcon(column: MtTableColumn<T>): 'updown' | 'arrow-down' {
    return this.sort()?.column === column.id ? 'arrow-down' : 'updown';
  }

  protected toggleSort(column: MtTableColumn<T>): void {
    this.sort.set(nextSort(this.sort(), column.id));
  }

  protected toggleRow(key: string): void {
    const selected = this.selectedSet();
    this.selection.set(selected.has(key) ? this.selection().filter((k) => k !== key) : [...this.selection(), key]);
  }

  protected toggleAll(): void {
    this.selection.set(this.allState() === 'true' ? [] : this.sortedRows().map((row) => this.rowKey()(row)));
  }

  protected onScroll(): void {
    const element = this.scroller().nativeElement;
    this.scrollTop.set(element.scrollTop);
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - END_ROWS * this.rowHeight()) {
      this.endReached.emit();
    }
  }

  protected onRowClick(event: MouseEvent, index: number): void {
    this.activeIndex.set(index);
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, select, textarea, [role="checkbox"]')) return;
    const row = this.sortedRows()[index];
    if (row !== undefined) this.open.emit(row);
  }

  protected onKeydown(event: KeyboardEvent): void {
    // Only when a row itself has focus, so inputs and buttons inside cells keep their keys.
    if (!(event.target instanceof HTMLElement) || event.target.tagName !== 'TR') return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const total = this.sortedRows().length;
    const index = this.activeIndex();
    const moves: Record<string, number> = {
      ArrowDown: index + 1,
      j: index + 1,
      ArrowUp: index - 1,
      k: index - 1,
      PageDown: index + PAGE_ROWS,
      PageUp: index - PAGE_ROWS,
      Home: 0,
      End: total - 1,
    };
    const target = moves[event.key];
    if (target !== undefined) {
      event.preventDefault();
      this.focusRow(Math.min(total - 1, Math.max(0, target)));
      return;
    }
    const row = this.sortedRows()[index];
    if (row === undefined) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      this.open.emit(row);
    } else if ((event.key === ' ' || event.key === 'x') && this.selectable()) {
      event.preventDefault();
      this.toggleRow(this.rowKey()(row));
    }
  }

  /** Moves focus to a row, scrolling it into view (and into the rendered window when virtual). */
  focusRow(index: number): void {
    this.activeIndex.set(index);
    const scroller = this.scroller().nativeElement;
    if (this.virtual()) {
      const height = this.rowHeight();
      const top = (this.itemIndex()[index] ?? index) * height;
      const view = Math.max(height, scroller.clientHeight - HEADER_HEIGHT);
      let next = scroller.scrollTop;
      if (top < next) next = top;
      else if (top + height > next + view) next = top + height - view;
      scroller.scrollTop = next;
      this.scrollTop.set(next);
    }
    afterNextRender(
      () => {
        const element = scroller.querySelector<HTMLElement>(`tr[data-index="${index}"]`);
        element?.focus({ preventScroll: this.virtual() });
      },
      { injector: this.injector },
    );
  }
}
