import type { MatterListFilters, MatterListItem, SavedViewItem, WithId } from '@materia/data-access/repository';
import {
  DEFAULT_MATTER_VIEWS,
  DomainError,
  MATTER_STATUS_LABELS,
  type Jurisdiction,
  type MatterGroupBy,
  type MatterSortField,
  type MatterStatus,
  type MatterViewDefinition,
  type MatterViewFilters,
  type MatterViewSort,
} from '@materia/domain';
import { MATTER_TYPE_LABELS, type MtSort, type MtTableGroup } from '@materia/ui';

import { errorCopy } from '../../core/error-copy';

/** The Matters list's rows. */
export type MatterRow = WithId<MatterListItem>;

/** The view on screen: a default or saved view, possibly changed since it was picked. */
export interface MatterViewState {
  filters: MatterViewFilters;
  sort: MatterViewSort;
  groupBy: MatterGroupBy;
}

export const DEFAULT_VIEW_ID = 'my-open';
export const DEFAULT_SORT: MatterViewSort = { field: 'lastActivity', dir: 'desc' };

/** Where the list remembers the view it was left on (cleared at sign-out). */
export const LAST_VIEW_KEY = 'materia.matters.view';

/** The view the list was left on, and any unsaved changes to it. */
export interface LastMatterView {
  viewId: string;
  draft: MatterViewState | null;
}

export function readLastView(): LastMatterView | null {
  try {
    const raw = localStorage.getItem(LAST_VIEW_KEY);
    const value = raw ? (JSON.parse(raw) as Partial<LastMatterView>) : null;
    if (!value || typeof value.viewId !== 'string') return null;
    const draft = value.draft;
    const valid = !!draft && typeof draft === 'object' && !!draft.filters && !!draft.sort && !!draft.groupBy;
    return { viewId: value.viewId, draft: valid ? { ...draft, filters: cleanFilters(draft.filters) } : null };
  } catch {
    return null;
  }
}

export function writeLastView(value: LastMatterView): void {
  try {
    localStorage.setItem(LAST_VIEW_KEY, JSON.stringify(value));
  } catch {
    // Not remembered (private window); the default view stands next time.
  }
}

/** A saved view as the picker lists it, marked as the person's own. */
export interface MatterViewOption extends MatterViewDefinition {
  saved: boolean;
}

export function savedViewOption(view: WithId<SavedViewItem>): MatterViewOption {
  return { id: view.id, name: view.name, filters: view.filters, sort: view.sort, groupBy: view.groupBy, saved: true };
}

export const DEFAULT_VIEW_OPTIONS: readonly MatterViewOption[] = DEFAULT_MATTER_VIEWS.map((view) => ({
  ...view,
  saved: false,
}));

/** Filters without empty values, so two views with the same meaning compare equal. */
export function cleanFilters(filters: MatterListFilters): MatterViewFilters {
  const clean: MatterViewFilters = {};
  if (filters.status?.length) clean.status = [...filters.status];
  if (filters.type?.length) clean.type = [...filters.type];
  if (filters.responsible) clean.responsible = filters.responsible;
  if (filters.label) clean.label = filters.label;
  if (filters.jurisdiction) clean.jurisdiction = filters.jurisdiction;
  if (filters.hasOverdue) clean.hasOverdue = true;
  if (filters.closedWithinDays) clean.closedWithinDays = filters.closedWithinDays;
  return clean;
}

function canonical(state: MatterViewState): string {
  const filters = cleanFilters(state.filters);
  const sorted = {
    ...filters,
    ...(filters.status ? { status: [...filters.status].sort() } : {}),
    ...(filters.type ? { type: [...filters.type].sort() } : {}),
  };
  return JSON.stringify([Object.entries(sorted).sort(([a], [b]) => a.localeCompare(b)), state.sort, state.groupBy]);
}

/** Whether two view states show the same thing. */
export function sameView(a: MatterViewState, b: MatterViewState): boolean {
  return canonical(a) === canonical(b);
}

/** Table sort ↔ view sort; no table sort means the default (most recently active first). */
export function toTableSort(sort: MatterViewSort): MtSort | null {
  return sort.field === DEFAULT_SORT.field && sort.dir === DEFAULT_SORT.dir
    ? null
    : { column: sort.field, direction: sort.dir };
}

export function fromTableSort(sort: MtSort | null): MatterViewSort {
  return sort ? { field: sort.column as MatterSortField, dir: sort.direction } : DEFAULT_SORT;
}

export const STATUS_ORDER: readonly MatterStatus[] = ['lead', 'open', 'on_hold', 'closed', 'archived'];
export const JURISDICTIONS: readonly Jurisdiction[] = ['VIC', 'NSW', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];

const wipFormatter = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  maximumFractionDigits: 0,
});

/** WIP in whole dollars (`$4,860`), as the list shows it. */
export function formatWip(cents: number): string {
  return wipFormatter.format(Math.round(cents / 100));
}

/** A stage id as words until templates name their stages (`notice-period` → `Notice period`). */
export function stageLabel(stageId: string | undefined): string {
  if (!stageId) return '';
  const words = stageId.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The group a row falls in, for "Group by". Statuses keep their lifecycle order. */
export function matterGroup(
  groupBy: MatterGroupBy,
  row: MatterListItem,
  memberName: (uid: string) => string,
): MtTableGroup {
  switch (groupBy) {
    case 'status':
      return { key: row.status, label: MATTER_STATUS_LABELS[row.status] };
    case 'type':
      return { key: row.type, label: MATTER_TYPE_LABELS[row.type] };
    case 'responsible':
      return { key: row.responsibleUid, label: memberName(row.responsibleUid) };
    default:
      return { key: '', label: '' };
  }
}

/** Rows ordered so groups come out in a sensible order (statuses by lifecycle, others by name). */
export function orderForGroups(
  rows: readonly MatterRow[],
  groupBy: MatterGroupBy,
  memberName: (uid: string) => string,
): MatterRow[] {
  if (groupBy === 'none') return [...rows];
  const rank = (row: MatterRow): string =>
    groupBy === 'status'
      ? String(STATUS_ORDER.indexOf(row.status))
      : matterGroup(groupBy, row, memberName).label.toLowerCase();
  return rows
    .map((row, index) => ({ row, index, key: rank(row) }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.index - b.index)
    .map((entry) => entry.row);
}

/** A one-line summary of a bulk status change: what moved, and what didn't and why. */
export function bulkStatusSummary(
  to: MatterStatus,
  moved: number,
  failed: readonly { number: string; message: string }[],
): { title: string; description?: string; tone: 'success' | 'neutral' | 'danger' } {
  const status = MATTER_STATUS_LABELS[to];
  const plural = (n: number) => (n === 1 ? '1 matter' : `${n} matters`);
  if (!failed.length) return { title: `Moved ${plural(moved)} to ${status}`, tone: 'success' };
  const reasons = failed.map((f) => `${f.number}: ${f.message}`).join(' ');
  return {
    title: moved
      ? `Moved ${plural(moved)} to ${status}; ${failed.length} couldn’t move`
      : `Couldn’t move ${plural(failed.length)} to ${status}`,
    description: reasons,
    tone: moved ? 'neutral' : 'danger',
  };
}

/**
 * Why `matters-changeStatus` refused, in words. A lead opens only once a lawyer has recorded the
 * conflict check as clear or waived (`FAILED_PRECONDITION`, `details.reason: 'conflict_check_not_clear'`).
 */
export function changeStatusErrorCopy(error: unknown): string {
  const details =
    error instanceof DomainError ? error.details : (error as { details?: Record<string, unknown> })?.details;
  if (details?.['reason'] === 'conflict_check_not_clear') {
    return details['conflictStatus'] === 'conflict'
      ? 'The conflict check found a conflict, so the matter can’t open.'
      : 'The conflict check needs a lawyer’s determination before the matter can open.';
  }
  return errorCopy(error);
}
