import * as z from 'zod';

import { centsToDecimal, csvCell, TIME_CSV_COLUMNS, timeCsvCells, type TimeCsvRow } from './billing';
import { contactDisplayName, contactSearchTokens, formatPhone } from './contacts';
import { MATTER_STATUS_LABELS } from './matters';
import { owingCents, paidCents, type PaymentLike } from './payments';
import { can, PERMISSIONS } from './permissions';
import { DocIdSchema } from './schemas/common';
import {
  DeadlineKindSchema,
  JurisdictionSchema,
  MatterTypeSchema,
  PartyRoleSchema,
  ReferrerIndustrySchema,
  TimeEntryStatusSchema,
  type Jurisdiction,
  type MatterStatus,
  type Role,
} from './schemas/enums';
import { MatterViewFiltersSchema } from './schemas/views';
import { searchWords } from './search';
import { DateOnlySchema, type DateOnly } from './values/date-only';

/**
 * CSV exports of the core lists (INS-03, ADR-055): `exports-create` writes the list, filtered as
 * the screen filters it, to `orgs/{orgId}/exports/{jobId}.csv` (7 days, like every export), and
 * the member who asked downloads it through `jobs-getExportUrl`.
 */

export const EXPORT_KINDS = ['matters', 'contacts', 'time', 'invoices', 'deadlines'] as const;
export const ExportKindSchema = z.enum(EXPORT_KINDS);
export type ExportKind = z.infer<typeof ExportKindSchema>;

/** The file's name (and the toast's): "Matters export". */
export const EXPORT_KIND_LABELS: Readonly<Record<ExportKind, string>> = {
  matters: 'Matters',
  contacts: 'Contacts',
  time: 'Time entries',
  invoices: 'Invoices',
  deadlines: 'Deadlines',
};

/**
 * Who may export each list: the people who see it, except read-only members (they look, they
 * don't take data away). Time and invoices follow `time-exportCsv` and the Invoices screen.
 */
export const EXPORT_ROLES: Readonly<Record<ExportKind, readonly Role[]>> = {
  matters: ['owner', 'admin', 'lawyer', 'paralegal'],
  contacts: ['owner', 'admin', 'lawyer', 'paralegal'],
  time: PERMISSIONS['time.approve'],
  invoices: PERMISSIONS['billing.view'],
  deadlines: ['owner', 'admin', 'lawyer', 'paralegal'],
};

export const canExport = (role: Role | null | undefined, kind: ExportKind): boolean =>
  !!role && EXPORT_ROLES[kind].includes(role);

/**
 * Whether rows on privileged matters go in: only when asked for ("Include privileged matters")
 * by someone who may see them (lawyers and above). Otherwise they are left out, whatever the role.
 */
export const exportIncludesPrivileged = (role: Role | null | undefined, includePrivileged: boolean | undefined) =>
  includePrivileged === true && !!role && can(role, 'privileged.view');

/** Up to this many rows are written while the caller waits; more run in the background. */
export const EXPORT_INLINE_MAX_ROWS = 5000;
/** A runaway guard: no list export writes more rows than this. */
export const EXPORT_MAX_ROWS = 250_000;

/** Callers leave a filter out by sending `null` (or nothing): both mean "not set". */
const dropEmpty = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined))
    : value;
const filters = <T extends z.ZodRawShape>(shape: T) => z.preprocess(dropEmpty, z.object(shape).strict());

const QueryText = z.string().max(200);

/** The Matters list's filters (a saved view's, plus what was typed in the filter box). */
export const MatterExportFiltersSchema = z.preprocess(
  dropEmpty,
  MatterViewFiltersSchema.extend({ query: QueryText.optional() }).strict(),
);
export type MatterExportFilters = z.infer<typeof MatterExportFiltersSchema>;

/** The Contacts list's filters. */
export const ContactExportFiltersSchema = filters({
  query: QueryText.optional(),
  kind: z.enum(['person', 'organisation']).optional(),
  tag: z.string().max(60).optional(),
  referrersOnly: z.boolean().optional(),
  industry: ReferrerIndustrySchema.optional(),
  role: PartyRoleSchema.optional(),
});
export type ContactExportFilters = z.infer<typeof ContactExportFiltersSchema>;

/** Time entries dated `from` to `to`, narrowed like `time-exportCsv`. */
export const TimeExportFiltersSchema = z.preprocess(
  dropEmpty,
  z
    .object({
      from: DateOnlySchema,
      to: DateOnlySchema,
      uid: DocIdSchema.optional(),
      status: TimeEntryStatusSchema.optional(),
      /** Unbilled WIP only (final, billable, not invoiced). */
      unbilledOnly: z.boolean().optional(),
      responsibleUid: DocIdSchema.optional(),
      matterType: MatterTypeSchema.optional(),
    })
    .strict()
    .refine((input) => input.from <= input.to, { message: 'The start is after the end', path: ['to'] }),
);
export type TimeExportFilters = z.infer<typeof TimeExportFiltersSchema>;

/** The Invoices screen's "Show" choice: everything, pre-bills, issued invoices or void ones. */
export const INVOICE_EXPORT_STATUSES = ['all', 'draft', 'live', 'void'] as const;
export const InvoiceExportFiltersSchema = filters({ status: z.enum(INVOICE_EXPORT_STATUSES).optional() });
export type InvoiceExportFilters = z.infer<typeof InvoiceExportFiltersSchema>;

/** The Deadlines screen's filters (upcoming deadlines only, as the screen shows them). */
export const DeadlineExportFiltersSchema = filters({
  mine: z.boolean().optional(),
  team: z.boolean().optional(),
  critical: z.boolean().optional(),
  kinds: z.array(DeadlineKindSchema).max(10).optional(),
  jurisdictions: z.array(JurisdictionSchema).max(8).optional(),
});
export type DeadlineExportFilters = z.infer<typeof DeadlineExportFiltersSchema>;

const common = {
  requestId: z.uuid(),
  /** Rows on privileged matters too (lawyers and above; ignored for anyone else). */
  includePrivileged: z
    .boolean()
    .nullish()
    .transform((value) => value === true),
};

/** `exports-create` (INS-03): one list, with the filters it is showing. */
export const CreateExportInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('matters'), filters: MatterExportFiltersSchema.default({}), ...common }),
  z.object({ kind: z.literal('contacts'), filters: ContactExportFiltersSchema.default({}), ...common }),
  z.object({ kind: z.literal('time'), filters: TimeExportFiltersSchema, ...common }),
  z.object({ kind: z.literal('invoices'), filters: InvoiceExportFiltersSchema.default({}), ...common }),
  z.object({ kind: z.literal('deadlines'), filters: DeadlineExportFiltersSchema.default({}), ...common }),
]);
export type CreateExportInput = z.input<typeof CreateExportInput>;
export type CreateExportRequest = z.output<typeof CreateExportInput>;

export const CREATE_EXPORT_CALLABLE = 'exports-create';

/**
 * What `exports-create` answers: a small export is ready at once (with its download link); a
 * large one is `queued`, and the caller follows the job (`export_ready` tells them when it's done).
 */
export type CreateExportResult =
  | { jobId: string; status: 'succeeded'; rows: number; url: string; expiresAt: string; fileName: string }
  | { jobId: string; status: 'queued' };

/** The input an export job keeps (`jobs/{jobId}.input`), so the background run reads the same list. */
export interface ExportJobInput {
  kind: ExportKind;
  filters: Record<string, unknown>;
  includePrivileged: boolean;
}

/** An export's file name: "Matters 2026-10-06". */
export const exportName = (kind: ExportKind, today: DateOnly) => `${EXPORT_KIND_LABELS[kind]} ${today}`;

// ---------- CSV ----------

/**
 * A byte-order mark: Excel reads a CSV as UTF-8 only when it starts with one (otherwise names
 * such as "Zoë" arrive garbled).
 */
export const CSV_BOM = '﻿';

/**
 * A cell Excel must keep as text: always quoted, so a phone number keeps its leading zero
 * (`"0412 345 678"`), and never a formula.
 */
export function csvTextCell(value: unknown): string {
  const cell = csvCell(value);
  if (!cell || cell.startsWith('"')) return cell;
  return `"${cell}"`;
}

const yesNo = (value: unknown) => (value === true ? 'Yes' : 'No');
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const date = (value: unknown) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '');

/** A cell that is already escaped: `csvLine` leaves it as it is. */
class Escaped {
  constructor(readonly cell: string) {}
  toString() {
    return this.cell;
  }
}
const text = (value: unknown) => new Escaped(csvTextCell(value));
/**
 * A number this code formatted (`-2.50`): written as it is, so a credit stays a number in Excel
 * rather than being defused into text like a typed `-` would be.
 */
const decimal = (value: string) => (/^-?\d+(\.\d+)?$/.test(value) ? new Escaped(value) : value);
const money = (value: unknown) => decimal(centsToDecimal(Number(value) || 0));

/** One line of cells, where `Escaped` cells (quoted text) are kept as they are. */
export function exportLine(cells: readonly unknown[]): string {
  return cells.map((cell) => (cell instanceof Escaped ? cell.cell : csvCell(cell))).join(',');
}

export const EXPORT_COLUMNS: Readonly<Record<ExportKind, readonly string[]>> = {
  matters: [
    'Matter',
    'Title',
    'Type',
    'Status',
    'Clients',
    'Responsible',
    'Jurisdiction',
    'Opened',
    'Closed',
    'Next deadline',
    'Next deadline due',
    'WIP time',
    'WIP disbursements',
    'Outstanding',
    'Labels',
    'Privileged',
  ],
  contacts: [
    'Name',
    'Kind',
    'Given names',
    'Family name',
    'Organisation',
    'ABN',
    'Email',
    'Other emails',
    'Phone',
    'Other phones',
    'Address',
    'Tags',
    'Referrer',
    'Roles in matters',
  ],
  time: TIME_CSV_COLUMNS,
  invoices: [
    'Invoice',
    'Status',
    'Matter',
    'Matter title',
    'To',
    'Issued',
    'Due',
    'Subtotal ex GST',
    'GST',
    'Total',
    'Credited',
    'Paid',
    'Owing',
    'Paid from trust',
  ],
  deadlines: ['Due', 'Time', 'Deadline', 'Kind', 'Critical', 'Matter', 'Matter title', 'Jurisdiction', 'Assignee'],
};

/** The header line. */
export const exportHeader = (kind: ExportKind): string => exportLine(EXPORT_COLUMNS[kind]);

type Data = Record<string, unknown>;

/** What a matter row needs besides the matter: dates in the org's time zone, and names. */
export interface MatterRowContext {
  openedOn: DateOnly | null;
  closedOn: DateOnly | null;
  clients: readonly string[];
  responsible: string;
}

export function matterExportCells(matter: Data, ctx: MatterRowContext): unknown[] {
  const next = matter['nextDeadline'] as { title?: unknown; dueDate?: unknown } | undefined;
  const status = str(matter['status']) as MatterStatus;
  return [
    text(matter['number']),
    str(matter['title']),
    str(matter['type']),
    MATTER_STATUS_LABELS[status] ?? status,
    ctx.clients.join('; '),
    ctx.responsible,
    str(matter['jurisdiction']),
    ctx.openedOn ?? '',
    ctx.closedOn ?? '',
    str(next?.title),
    date(next?.dueDate),
    money(matter['wipCents']),
    money(matter['disbursementWipCents']),
    money(matter['outstandingCents']),
    ((matter['labels'] as string[] | undefined) ?? []).join('; '),
    yesNo(matter['privileged']),
  ];
}

const phoneText = (phone: { number?: unknown }) => formatPhone(str(phone.number));

function addressText(address: Data | undefined): string {
  if (!address) return '';
  return [address['line1'], address['line2'], address['suburb'], address['state'], address['postcode']]
    .map(str)
    .filter(Boolean)
    .join(', ');
}

export function contactExportCells(contact: Data): unknown[] {
  const emails = ((contact['emails'] as { address?: unknown }[] | undefined) ?? []).map((email) => str(email.address));
  const phones = ((contact['phones'] as { number?: unknown }[] | undefined) ?? []).map(phoneText);
  const addresses = (contact['addresses'] as Data[] | undefined) ?? [];
  return [
    contactDisplayName(contact as Parameters<typeof contactDisplayName>[0]),
    str(contact['kind']),
    str(contact['givenNames']),
    str(contact['familyName']),
    str(contact['orgName']),
    text(contact['abn'] ?? ''),
    emails[0] ?? '',
    emails.slice(1).join('; '),
    text(phones[0] ?? ''),
    text(phones.slice(1).join('; ')),
    text(addressText(addresses[0])),
    ((contact['tags'] as string[] | undefined) ?? []).join('; '),
    yesNo(contact['isReferrer']),
    ((contact['matterRoles'] as string[] | undefined) ?? []).join('; '),
  ];
}

export const timeExportCells = (row: TimeCsvRow): unknown[] => [
  date(row.date),
  text(row.matterNumber),
  ...timeCsvCells(row).slice(2),
];

/** An invoice: a pre-bill until it has a number. */
export function invoiceExportCells(invoice: Data): unknown[] {
  const payments = (invoice['payments'] as PaymentLike[] | undefined) ?? [];
  const status = str(invoice['status']);
  const amounts = {
    totalCents: Number(invoice['totalCents']) || 0,
    creditedCents: Number(invoice['creditedCents']) || 0,
    payments,
  };
  const live = status !== 'draft' && status !== 'void';
  return [
    text(str(invoice['number']) || 'Pre-bill'),
    status,
    text(invoice['matterNumber'] ?? ''),
    str(invoice['matterTitle']),
    str((invoice['buyer'] as Data | undefined)?.['name']),
    date(invoice['issueDate']),
    date(invoice['dueDate']),
    money(invoice['subtotalCents']),
    money(invoice['gstCents']),
    money(invoice['totalCents']),
    money(invoice['creditedCents']),
    decimal(centsToDecimal(paidCents(payments))),
    live ? decimal(centsToDecimal(owingCents(amounts))) : '',
    yesNo(invoice['paidFromTrust']),
  ];
}

export interface DeadlineRowContext {
  matterNumber: string;
  matterTitle: string;
  jurisdiction: string;
  assignee: string;
}

export const deadlineExportCells = (deadline: Data, ctx: DeadlineRowContext): unknown[] => [
  date(deadline['dueDate']),
  str(deadline['dueTime']),
  str(deadline['title']),
  str(deadline['kind']),
  yesNo(deadline['critical']),
  text(ctx.matterNumber),
  ctx.matterTitle,
  ctx.jurisdiction,
  ctx.assignee,
];

// ---------- filters (shared with the lists) ----------

/** What the Matters list's filters read from a matter. */
export interface MatterFilterRow {
  deletedAt?: unknown;
  status: string;
  type: string;
  responsibleUid: string;
  labels: readonly string[];
  jurisdiction: string;
  nextDeadline?: { dueDate: string } | null | undefined;
  closedAt?: Date | null | undefined;
  search: readonly string[];
  number: string;
  title: string;
}

export interface MatterFilterContext {
  viewerUid?: string | null;
  /** Today in the org's time zone, for "has overdue". */
  today: DateOnly;
  /** Now, for "closed within N days". */
  now: Date;
}

/** The Matters list's filters (CORE-03), for the list and its export alike. */
export function matterPassesFilters(
  row: MatterFilterRow,
  filters: MatterExportFilters,
  context: MatterFilterContext,
): boolean {
  if (row.deletedAt) return false;
  if (filters.status?.length && !filters.status.includes(row.status as MatterStatus)) return false;
  if (filters.type?.length && !(filters.type as readonly string[]).includes(row.type)) return false;
  const responsible = filters.responsible === 'me' ? (context.viewerUid ?? null) : (filters.responsible ?? null);
  if (filters.responsible && row.responsibleUid !== responsible) return false;
  if (filters.label && !row.labels.includes(filters.label)) return false;
  if (filters.jurisdiction && row.jurisdiction !== filters.jurisdiction) return false;
  if (filters.hasOverdue && !(row.nextDeadline && row.nextDeadline.dueDate < context.today)) return false;
  if (filters.closedWithinDays) {
    const since = context.now.getTime() - filters.closedWithinDays * 86_400_000;
    if (!row.closedAt || row.closedAt.getTime() < since) return false;
  }
  const words = searchWords(filters.query).filter((word) => word.length >= 2);
  if (words.length) {
    const tokens = new Set(row.search);
    const haystack = `${row.number} ${row.title}`.toLowerCase();
    if (!words.every((word) => tokens.has(word.slice(0, 10)) || haystack.includes(word))) return false;
  }
  return true;
}

/** What the Contacts list's filters read from a contact. */
export interface ContactFilterRow {
  mergedInto?: unknown;
  deletedAt?: unknown;
  kind: string;
  isReferrer?: boolean | undefined;
  referrerMeta?: { industry?: string | undefined } | undefined;
  tags: readonly string[];
  matterRoles: readonly string[];
  familyName?: string | undefined;
  givenNames?: string | undefined;
  preferredName?: string | undefined;
  orgName?: string | undefined;
  abn?: string | undefined;
  emails: readonly { type: 'personal' | 'work' | 'other'; address: string }[];
  phones: readonly { type: 'mobile' | 'home' | 'work' | 'other'; number: string }[];
}

/**
 * The Contacts list's filters (CORE-01), for the list and its export alike: the ones the query
 * couldn't carry, and every word of a multi-word search. Tombstones of merged contacts never pass.
 */
export function contactPassesFilters(row: ContactFilterRow, filters: ContactExportFilters = {}): boolean {
  if (row.mergedInto || row.deletedAt) return false;
  if (filters.kind && row.kind !== filters.kind) return false;
  if ((filters.referrersOnly || filters.industry) && !row.isReferrer) return false;
  if (filters.industry && row.referrerMeta?.industry !== filters.industry) return false;
  if (filters.tag && !row.tags.includes(filters.tag)) return false;
  if (filters.role && !row.matterRoles.includes(filters.role)) return false;
  const words = searchWords(filters.query);
  if (words.length && words.some((word) => word.length >= 2)) {
    const { familyName, givenNames, preferredName, orgName, emails, phones, abn } = row;
    const tokens = new Set(
      contactSearchTokens({
        ...(familyName ? { familyName } : {}),
        ...(givenNames ? { givenNames } : {}),
        ...(preferredName ? { preferredName } : {}),
        ...(orgName ? { orgName } : {}),
        ...(abn ? { abn } : {}),
        emails: [...emails],
        phones: [...phones],
      }),
    );
    if (!words.filter((word) => word.length >= 2).every((word) => tokens.has(word.slice(0, 10)))) return false;
  }
  return true;
}

/** The invoice statuses each "Show" choice keeps. */
export function invoicePassesFilter(status: string, filter: InvoiceExportFilters['status']): boolean {
  if (!filter || filter === 'all') return true;
  if (filter === 'live') return status === 'issued' || status === 'part_paid' || status === 'paid';
  return status === filter;
}

/** A jurisdiction the deadline filters can read. */
export const asJurisdiction = (value: unknown): Jurisdiction | undefined =>
  JurisdictionSchema.safeParse(value).success ? (value as Jurisdiction) : undefined;
