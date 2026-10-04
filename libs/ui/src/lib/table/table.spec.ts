import { Component, signal } from '@angular/core';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import {
  cellValue,
  compareCells,
  MtTable,
  MtTableCell,
  MtTableGroupHeader,
  type MtSort,
  type MtTableColumn,
  type MtTableGroup,
  groupRows,
  nextSort,
  sortRows,
  tableItems,
  virtualWindow,
} from './table';

interface Row {
  id: string;
  ref: string;
  name: string;
  wip: number | null;
}

// Fictional sample data, as in the design system.
const ROWS: Row[] = [
  { id: 'a', ref: 'WE-142', name: 'Estate of Margaret Whitfield', wip: 4860 },
  { id: 'b', ref: 'WE-097', name: 'Nguyen v Nguyen', wip: 18920 },
  { id: 'c', ref: 'WE-151', name: 'Harriet and Paul Okafor', wip: null },
];

const COLUMNS: MtTableColumn<Row>[] = [
  { id: 'ref', header: 'Ref', cellClass: 'ref' },
  { id: 'name', header: 'Matter', sortable: true, cellClass: 'title' },
  {
    id: 'wip',
    header: 'WIP',
    sortable: true,
    numeric: true,
    value: (r) => (r.wip === null ? null : `$${r.wip}`),
    sortValue: (r) => r.wip,
  },
];

@Component({
  imports: [MtTable, MtTableCell],
  template: `
    <mt-table
      label="Matters"
      [rows]="rows()"
      [columns]="columns"
      [rowKey]="key"
      [rowLabel]="name"
      [selectable]="true"
      [(selection)]="selection"
      [(sort)]="sort"
      [virtualThreshold]="threshold()"
      (open)="opened.push($event.id)"
    >
      <ng-template mtCell="ref" let-row>[{{ row.ref }}]</ng-template>
      <p mtTableEmpty>No matters yet</p>
    </mt-table>
  `,
})
class Host {
  readonly rows = signal<readonly Row[]>(ROWS);
  readonly columns = COLUMNS;
  readonly key = (row: Row) => row.id;
  readonly name = (row: Row) => row.name;
  readonly selection = signal<readonly string[]>([]);
  readonly sort = signal<MtSort | null>(null);
  readonly threshold = signal(200);
  readonly opened: string[] = [];
}

const bodyRows = () => screen.getAllByRole('row').filter((row) => row.hasAttribute('data-index'));
const names = () => bodyRows().map((row) => within(row).getAllByRole('cell')[2]?.textContent?.trim());

describe('table helpers', () => {
  it('compares numbers numerically and text naturally, empty values last', () => {
    expect(compareCells(2, 10)).toBeLessThan(0);
    expect(compareCells('WE-9', 'WE-10')).toBeLessThan(0);
    expect(compareCells('apple', 'Apple')).toBe(0);
    expect(compareCells(null, 'a')).toBe(1);
    expect(compareCells('a', undefined)).toBe(-1);
    expect(compareCells('', null)).toBe(0);
  });

  it('reads cell values from value() or the row property', () => {
    const row = { id: 'x', when: new Date(0), missing: null, flag: true } as unknown as Row;
    expect(cellValue({ id: 'id', header: 'Id' }, row)).toBe('x');
    expect(cellValue({ id: 'missing', header: 'M' }, row)).toBeNull();
    expect(cellValue({ id: 'flag', header: 'F' }, row)).toBe('true');
    expect(cellValue({ id: 'id', header: 'Id', value: () => 7 }, row)).toBe(7);
  });

  it('sorts stably in both directions with empty values last', () => {
    const wip = COLUMNS[2];
    expect(sortRows(ROWS, wip, 'asc').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sortRows(ROWS, wip, 'desc').map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(sortRows(ROWS, COLUMNS[1], 'asc').map((r) => r.id)).toEqual(['a', 'c', 'b']);
    expect(sortRows(ROWS, undefined, 'asc')).toEqual(ROWS);
  });

  it('cycles sort ascending, descending, then off', () => {
    expect(nextSort(null, 'name')).toEqual({ column: 'name', direction: 'asc' });
    expect(nextSort({ column: 'name', direction: 'asc' }, 'name')).toEqual({ column: 'name', direction: 'desc' });
    expect(nextSort({ column: 'name', direction: 'desc' }, 'name')).toBeNull();
    expect(nextSort({ column: 'name', direction: 'desc' }, 'wip')).toEqual({ column: 'wip', direction: 'asc' });
  });

  it('computes a virtual window with overscan and spacers', () => {
    expect(virtualWindow(10_000, 0, 400, 40)).toEqual({ start: 0, end: 18, padTop: 0, padBottom: 9982 * 40 });
    expect(virtualWindow(10_000, 4000, 400, 40)).toEqual({
      start: 92,
      end: 118,
      padTop: 92 * 40,
      padBottom: 9882 * 40,
    });
    expect(virtualWindow(20, 2000, 400, 40)).toEqual({ start: 42, end: 20, padTop: 42 * 40, padBottom: 0 });
  });
});

describe('MtTable', () => {
  it('renders headers, default and template cells, and aria-sort on sortable columns', async () => {
    await render(Host);
    expect(screen.getByRole('table', { name: 'Matters' })).toBeInTheDocument();
    const headers = screen.getAllByRole('columnheader');
    expect(headers.map((h) => h.getAttribute('aria-sort'))).toEqual([null, null, 'none', 'none']);
    expect(screen.getByText('[WE-142]')).toBeInTheDocument();
    expect(screen.getByText('$4860')).toBeInTheDocument();
    expect(within(bodyRows()[2] as HTMLElement).getAllByRole('cell')[3]).toHaveTextContent('—');
  });

  it('sorts by a header click and reports the sort', async () => {
    const { fixture } = await render(Host);
    const matter = screen.getByRole('button', { name: 'Matter' });
    await userEvent.click(matter);
    expect(screen.getAllByRole('columnheader')[2]).toHaveAttribute('aria-sort', 'ascending');
    expect(names()).toEqual(['Estate of Margaret Whitfield', 'Harriet and Paul Okafor', 'Nguyen v Nguyen']);
    await userEvent.click(matter);
    expect(screen.getAllByRole('columnheader')[2]).toHaveAttribute('aria-sort', 'descending');
    expect(names()[0]).toBe('Nguyen v Nguyen');
    expect(fixture.componentInstance.sort()).toEqual({ column: 'name', direction: 'desc' });
    await userEvent.click(matter);
    expect(fixture.componentInstance.sort()).toBeNull();
    expect(names()[0]).toBe('Estate of Margaret Whitfield');
  });

  it('selects rows with checkboxes and select-all, with a mixed state', async () => {
    const { fixture } = await render(Host);
    const all = screen.getByRole('checkbox', { name: 'Select all rows' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Nguyen v Nguyen' }));
    expect(fixture.componentInstance.selection()).toEqual(['b']);
    expect(all).toHaveAttribute('aria-checked', 'mixed');
    expect(bodyRows()[1]).toHaveAttribute('data-selected');
    await userEvent.click(all);
    expect(fixture.componentInstance.selection()).toEqual(['a', 'b', 'c']);
    expect(all).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(all);
    expect(fixture.componentInstance.selection()).toEqual([]);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Nguyen v Nguyen' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Nguyen v Nguyen' }));
    expect(fixture.componentInstance.selection()).toEqual([]);
    // A checkbox click doesn't open the row.
    expect(fixture.componentInstance.opened).toEqual([]);
  });

  it('moves between rows with j/k and arrows, opens with Enter, selects with Space and x', async () => {
    const { fixture } = await render(Host);
    const rows = bodyRows();
    expect(rows.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    await userEvent.tab(); // select-all
    await userEvent.tab(); // Matter sort
    await userEvent.tab(); // WIP sort
    await userEvent.tab();
    expect(rows[0]).toHaveFocus();
    await userEvent.keyboard('j');
    expect(bodyRows()[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(bodyRows()[2]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(bodyRows()[2]).toHaveFocus();
    await userEvent.keyboard('k');
    expect(bodyRows()[1]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(fixture.componentInstance.opened).toEqual(['b']);
    await userEvent.keyboard(' ');
    expect(fixture.componentInstance.selection()).toEqual(['b']);
    await userEvent.keyboard('x');
    expect(fixture.componentInstance.selection()).toEqual([]);
    await userEvent.keyboard('{End}');
    expect(bodyRows()[2]).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(bodyRows()[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}{PageDown}');
    expect(bodyRows()[2]).toHaveFocus();
    await userEvent.keyboard('{PageUp}');
    expect(bodyRows()[0]).toHaveFocus();
    // Modified keys are left to the browser and the app.
    await userEvent.keyboard('{Control>}j{/Control}');
    expect(bodyRows()[0]).toHaveFocus();
  });

  it('opens a row on click', async () => {
    const { fixture } = await render(Host);
    await userEvent.click(screen.getByText('Nguyen v Nguyen'));
    expect(fixture.componentInstance.opened).toEqual(['b']);
    expect(bodyRows()[1]).toHaveAttribute('tabindex', '0');
  });

  it('shows the empty slot with no rows', async () => {
    const { fixture } = await render(Host);
    fixture.componentInstance.rows.set([]);
    fixture.detectChanges();
    expect(await screen.findByText('No matters yet')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select all rows' })).toBeDisabled();
  });

  it('virtualises large tables: renders a window of rows with spacers and aria-rowcount', async () => {
    const { fixture } = await render(Host);
    const many = Array.from({ length: 10_000 }, (_, i) => ({
      id: `r${i}`,
      ref: `WE-${i}`,
      name: `Matter ${i}`,
      wip: i,
    }));
    fixture.componentInstance.rows.set(many);
    fixture.detectChanges();
    await fixture.whenStable();
    const table = screen.getByRole('table');
    expect(table).toHaveAttribute('aria-rowcount', '10001');
    const rendered = bodyRows();
    expect(rendered.length).toBeLessThan(60);
    expect(rendered[0]).toHaveAttribute('aria-rowindex', '2');
    // Scrolling moves the window.
    const scroller = table.parentElement as HTMLElement;
    // jsdom has no layout, so give the scroller a writable scroll position.
    Object.defineProperty(scroller, 'scrollTop', { value: 40_000, writable: true });
    scroller.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    expect(bodyRows()[0]).toHaveAttribute('data-index', '992');
    // Keyboard navigation scrolls the active row into the window.
    (bodyRows()[0] as HTMLElement).focus();
    await userEvent.keyboard('{End}');
    await fixture.whenStable();
    expect(document.activeElement).toHaveAttribute('data-index', '9999');
    await userEvent.keyboard('{Home}');
    await fixture.whenStable();
    expect(document.activeElement).toHaveAttribute('data-index', '0');
  });
});

@Component({
  imports: [MtTable, MtTableGroupHeader],
  template: `
    <mt-table
      label="Matters"
      [rows]="rows()"
      [columns]="columns"
      [rowKey]="key"
      [groupBy]="group()"
      [(sort)]="sort"
      [maxHeight]="'200px'"
      (endReached)="ends = ends + 1"
    >
      @if (custom()) {
        <ng-template mtTableGroup let-group>
          <strong>{{ group.label }} ({{ group.count }})</strong>
        </ng-template>
      }
    </mt-table>
  `,
})
class GroupHost {
  readonly rows = signal<readonly Row[]>(ROWS);
  readonly columns = COLUMNS;
  readonly key = (row: Row) => row.id;
  readonly byWip = (row: Row): MtTableGroup =>
    row.wip === null ? { key: 'none', label: 'No WIP' } : { key: 'some', label: 'Has WIP' };
  readonly group = signal<((row: Row) => MtTableGroup) | null>(this.byWip);
  readonly custom = signal(false);
  readonly sort = signal<MtSort | null>(null);
  ends = 0;
}

describe('MtTable groups and infinite scroll', () => {
  it('builds group lines and orders rows by group', () => {
    const byFirst = (row: Row): MtTableGroup => ({ key: row.name[0] ?? '', label: row.name[0] ?? '' });
    expect(tableItems(ROWS, null).map((item) => item.kind)).toEqual(['row', 'row', 'row']);
    const rows = groupRows([...ROWS, { id: 'd', ref: 'WE-1', name: 'Estate of Ivy', wip: 1 }], byFirst);
    expect(rows.map((r) => r.id)).toEqual(['a', 'd', 'b', 'c']);
    expect(
      tableItems(rows, byFirst).map((item) =>
        item.kind === 'group' ? `${item.group.label}:${item.group.count}` : item.index,
      ),
    ).toEqual(['E:2', 0, 1, 'N:1', 2, 'H:1', 3]);
  });

  it('renders a header row per group, sorts within groups, and keeps row indexes for the keyboard', async () => {
    const { fixture } = await render(GroupHost);
    const headers = () => screen.getAllByRole('row').filter((row) => row.classList.contains('group'));
    expect(headers().map((row) => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Has WIP2', 'No WIP1']);
    expect(bodyRows().map((row) => row.getAttribute('data-index'))).toEqual(['0', '1', '2']);
    await userEvent.click(screen.getByRole('button', { name: /WIP/ }));
    await userEvent.click(screen.getByRole('button', { name: /WIP/ }));
    expect(bodyRows().map((row) => within(row).getAllByRole('cell')[1]?.textContent?.trim())).toEqual([
      'Nguyen v Nguyen',
      'Estate of Margaret Whitfield',
      'Harriet and Paul Okafor',
    ]);
    fixture.componentInstance.custom.set(true);
    fixture.detectChanges();
    expect(headers()[0]?.textContent?.trim()).toBe('Has WIP (2)');
    fixture.componentInstance.group.set(null);
    fixture.detectChanges();
    expect(headers()).toHaveLength(0);
  });

  it('virtualises over group headers and reports reaching the end', async () => {
    const { fixture } = await render(GroupHost);
    const many = Array.from({ length: 400 }, (_, i) => ({
      id: `r${i}`,
      ref: `WE-${i}`,
      name: `M ${i}`,
      wip: i % 2 ? i : null,
    }));
    fixture.componentInstance.rows.set(many);
    fixture.detectChanges();
    await fixture.whenStable();
    const table = screen.getByRole('table');
    expect(table).toHaveAttribute('aria-rowcount', '403');
    const scroller = table.parentElement as HTMLElement;
    Object.defineProperty(scroller, 'clientHeight', { value: 200 });
    Object.defineProperty(scroller, 'scrollHeight', { value: 402 * 40 });
    Object.defineProperty(scroller, 'scrollTop', { value: 1000, writable: true });
    scroller.dispatchEvent(new Event('scroll'));
    expect(fixture.componentInstance.ends).toBe(0);
    scroller.scrollTop = 402 * 40 - 300;
    scroller.dispatchEvent(new Event('scroll'));
    expect(fixture.componentInstance.ends).toBe(1);
    // The last row sits below both group headers.
    fixture.detectChanges();
    (bodyRows()[0] as HTMLElement).focus();
    await userEvent.keyboard('{End}');
    await fixture.whenStable();
    expect(document.activeElement).toHaveAttribute('data-index', '399');
  });
});
