import { z } from 'zod';

import { DEFAULT_ORG_TIMEZONE } from './constants';
import { DocIdSchema } from './schemas/common';
import { Matter } from './schemas/contacts-matters';
import { MatterStatusSchema } from './schemas/enums';
import type { MatterStatus } from './schemas/enums';
import type { MatterGroupBy, MatterViewFilters, MatterViewSort } from './schemas/views';
import { searchTokens } from './search';
import { dateOnlyAt } from './values/date-only';

/**
 * Matters (CORE-03): number allocation and formatting, the status state machine, search tokens,
 * saved views and the callable inputs. Shared by the web app and Functions.
 */

// ---------- numbers ----------

export const DEFAULT_MATTER_NUMBER_FORMAT = 'M-{YYYY}-{seq:4}';
const FORMAT_TOKEN = /\{(YYYY|YY|seq(?::(\d))?)\}/g;

/** A format must contain `{seq}` (or `{seq:N}`, zero-padded to N digits) and may use `{YYYY}` and `{YY}`. */
export function isMatterNumberFormat(format: string): boolean {
  return /\{seq(?::\d)?\}/.test(format) && format.replace(FORMAT_TOKEN, '').indexOf('{') === -1;
}

/** `formatMatterNumber('M-{YYYY}-{seq:4}', 2026, 7)` → `M-2026-0007`. */
export function formatMatterNumber(format: string, year: number, seq: number): string {
  const pattern = isMatterNumberFormat(format) ? format : DEFAULT_MATTER_NUMBER_FORMAT;
  return pattern.replace(FORMAT_TOKEN, (_match, token: string, width?: string) => {
    if (token === 'YYYY') return String(year);
    if (token === 'YY') return String(year % 100).padStart(2, '0');
    return String(seq).padStart(width ? Number(width) : 1, '0');
  });
}

/** The numbering year: the calendar year in the org's time zone (1 January in Melbourne, not UTC). */
export function matterNumberYear(now: Date, timeZone: string = DEFAULT_ORG_TIMEZONE): number {
  return Number(dateOnlyAt(now, timeZone).slice(0, 4));
}

/** `orgs/{orgId}/counters/matter-{YYYY}`. */
export function matterCounterId(year: number): string {
  return `matter-${year}`;
}

// ---------- status ----------

/** Allowed transitions. `closed → open` (reopen) needs a reason; `lead → open` needs a clear conflict check. */
export const MATTER_TRANSITIONS: Readonly<Record<MatterStatus, readonly MatterStatus[]>> = {
  lead: ['open'],
  open: ['on_hold', 'closed'],
  on_hold: ['open'],
  closed: ['open', 'archived'],
  archived: [],
};

export function canTransition(from: MatterStatus, to: MatterStatus): boolean {
  return MATTER_TRANSITIONS[from].includes(to);
}

export type TransitionRequirement = 'conflict_clear' | 'reason';

/** What a valid transition still needs. */
export function transitionRequirements(from: MatterStatus, to: MatterStatus): TransitionRequirement[] {
  if (from === 'lead' && to === 'open') return ['conflict_clear'];
  if (from === 'closed' && to === 'open') return ['reason'];
  return [];
}

/** The status a new matter starts in: `open` once the conflict check is clear, otherwise `lead`. */
export function initialMatterStatus(conflictStatus: Matter['conflictCheck']['status'] | undefined): MatterStatus {
  return conflictStatus === 'clear' ? 'open' : 'lead';
}

export const MATTER_STATUS_LABELS: Readonly<Record<MatterStatus, string>> = {
  lead: 'Lead',
  open: 'Open',
  on_hold: 'On hold',
  closed: 'Closed',
  archived: 'Archived',
};

// ---------- search ----------

export interface MatterSearchFields {
  number: string;
  title: string;
  clientNames?: readonly string[];
  deceasedName?: string;
  externalRef?: string;
}

/**
 * Search tokens for `matters-denormalise`: the number (also without separators, so "M-2026-0007",
 * "m20260007" and "0007" all match), title, client and deceased names, and the external reference.
 */
export function matterSearchTokens(fields: MatterSearchFields): string[] {
  const compact = (value?: string) => value?.replace(/[^\p{L}\p{N}]+/gu, '');
  return searchTokens(
    compact(fields.number),
    fields.number,
    fields.title,
    ...(fields.clientNames ?? []),
    fields.deceasedName,
    fields.externalRef,
    compact(fields.externalRef),
  );
}

// ---------- saved views ----------

export interface MatterViewDefinition {
  id: string;
  name: string;
  filters: MatterViewFilters;
  sort: MatterViewSort;
  groupBy: MatterGroupBy;
}

/** The built-in views every user has. "My open matters" is the default. */
export const DEFAULT_MATTER_VIEWS: readonly MatterViewDefinition[] = [
  {
    id: 'my-open',
    name: 'My open matters',
    filters: { status: ['open'], responsible: 'me' },
    sort: { field: 'lastActivity', dir: 'desc' },
    groupBy: 'none',
  },
  {
    id: 'all-open',
    name: 'All open',
    filters: { status: ['open'] },
    sort: { field: 'lastActivity', dir: 'desc' },
    groupBy: 'none',
  },
  {
    id: 'leads',
    name: 'Leads',
    filters: { status: ['lead'] },
    sort: { field: 'lastActivity', dir: 'desc' },
    groupBy: 'none',
  },
  {
    id: 'on-hold',
    name: 'On hold',
    filters: { status: ['on_hold'] },
    sort: { field: 'lastActivity', dir: 'desc' },
    groupBy: 'none',
  },
  {
    id: 'recently-closed',
    name: 'Recently closed',
    filters: { status: ['closed'], closedWithinDays: 90 },
    sort: { field: 'lastActivity', dir: 'desc' },
    groupBy: 'none',
  },
];

// ---------- callable inputs ----------

const RequestId = z.uuid();

/**
 * `matters-createMatter`: the matter's fields without the number and status, which the server
 * allocates. Status is `lead`, or `open` when `conflictCheck.status` is already `clear`.
 */
export const CreateMatterInput = z.object({
  requestId: RequestId,
  matter: Matter.create.omit({ status: true }),
});
export type CreateMatterInput = z.infer<typeof CreateMatterInput>;

/** `matters-changeStatus` (lawyer and above). */
export const ChangeMatterStatusInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  to: MatterStatusSchema,
  reason: z.string().trim().max(500).optional(),
});
export type ChangeMatterStatusInput = z.infer<typeof ChangeMatterStatusInput>;

export interface CreateMatterResult {
  matterId: string;
  number: string;
  status: MatterStatus;
}
export interface ChangeMatterStatusResult {
  matterId: string;
  status: MatterStatus;
}
