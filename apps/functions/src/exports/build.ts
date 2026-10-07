import { createHash } from 'node:crypto';

import type { DocumentSnapshot, Firestore, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';

import {
  asJurisdiction,
  BILLING_UNIT_MINUTES,
  canExport,
  contactDisplayName,
  contactExportCells,
  contactPassesFilters,
  CSV_BOM,
  dayOfInstant,
  deadlineExportCells,
  deadlineMatchesFilters,
  EXPORT_MAX_ROWS,
  exportHeader,
  exportIncludesPrivileged,
  exportLine,
  instantOf,
  invoiceExportCells,
  invoicePassesFilter,
  isUnbilledWip,
  matterExportCells,
  matterPassesFilters,
  timeExportCells,
  type ContactExportFilters,
  type DateOnly,
  type DeadlineFilters,
  type ExportJobInput,
  type InvoiceExportFilters,
  type MatterExportFilters,
  type Role,
  type TimeExportFilters,
} from '@materia/domain';

import { isDeleted } from '../contacts/shared';
import type { FileStore } from '../documents/files';

/**
 * Builds a list export (INS-03, ADR-055): each kind's rows read page by page from Firestore and
 * written as CSV lines, so a 100k-row export never sits in memory. The same code runs inside
 * `exports-create` (small exports) and on the `exports-run` queue (large ones).
 */

type Data = Record<string, unknown>;

/** Who the export is for and what it holds. */
export interface ExportScope {
  db: Firestore;
  orgId: string;
  uid: string;
  role: Role;
  request: ExportJobInput;
  timeZone: string;
  now: Date;
  today: DateOnly;
}

/** Documents read per page. */
export const EXPORT_PAGE_SIZE = 500;

/** Every document a query matches, a page at a time (cursor on the last document). */
async function* pages(query: Query, pageSize = EXPORT_PAGE_SIZE): AsyncGenerator<QueryDocumentSnapshot[]> {
  let last: QueryDocumentSnapshot | undefined;
  for (;;) {
    const snap = await (last ? query.startAfter(last) : query).limit(pageSize).get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.size < pageSize) return;
    last = snap.docs[snap.docs.length - 1];
  }
}

/** The query each kind walks (and counts, to decide whether it runs in the background). */
export function exportQuery(scope: Pick<ExportScope, 'db' | 'orgId' | 'request'>): Query {
  const { db, orgId, request } = scope;
  switch (request.kind) {
    case 'matters':
      return db.collection(`orgs/${orgId}/matters`).orderBy('number');
    case 'contacts':
      return db.collection(`orgs/${orgId}/contacts`).orderBy('sortName');
    case 'invoices':
      return db.collection(`orgs/${orgId}/invoices`).orderBy('createdAt', 'desc');
    case 'time': {
      const filters = request.filters as TimeExportFilters;
      return db
        .collectionGroup('timeEntries')
        .where('orgId', '==', orgId)
        .where('date', '>=', filters.from)
        .where('date', '<=', filters.to)
        .orderBy('date', 'asc');
    }
    case 'deadlines':
      return db
        .collectionGroup('deadlines')
        .where('orgId', '==', orgId)
        .where('status', '==', 'upcoming')
        .orderBy('dueDate', 'asc');
  }
}

/** Matters, members and contacts read once per export, by id. */
class Lookups {
  private readonly matters = new Map<string, Data | null>();
  private readonly names = new Map<string, string>();
  private readonly contacts = new Map<string, string>();

  constructor(
    private readonly db: Firestore,
    private readonly orgId: string,
  ) {}

  private async load<T>(
    cache: Map<string, T>,
    ids: Iterable<string>,
    path: (id: string) => string,
    read: (snap: DocumentSnapshot) => T,
  ) {
    const missing = [...new Set(ids)].filter((id) => id && !cache.has(id));
    for (let start = 0; start < missing.length; start += 300) {
      const batch = missing.slice(start, start + 300);
      const snaps = await this.db.getAll(...batch.map((id) => this.db.doc(path(id))));
      snaps.forEach((snap, i) => cache.set(batch[i] as string, read(snap)));
    }
  }

  async loadMatters(ids: Iterable<string>) {
    await this.load(
      this.matters,
      ids,
      (id) => `orgs/${this.orgId}/matters/${id}`,
      (snap) => snap.data() ?? null,
    );
  }
  matter = (id: unknown): Data | null => this.matters.get(String(id)) ?? null;

  async loadMembers(uids: Iterable<string>) {
    await this.load(
      this.names,
      uids,
      (uid) => `orgs/${this.orgId}/members/${uid}`,
      (snap) => String(snap.get('displayName') ?? snap.id),
    );
  }
  member = (uid: unknown): string => this.names.get(String(uid)) ?? '';

  async loadContacts(ids: Iterable<string>) {
    await this.load(
      this.contacts,
      ids,
      (id) => `orgs/${this.orgId}/contacts/${id}`,
      (snap) => {
        const data = snap.data();
        return data && !isDeleted(data) ? contactDisplayName(data) : '';
      },
    );
  }
  contact = (id: string): string => this.contacts.get(id) ?? '';
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** A live matter whose rows this export may hold. */
function matterAllowed(matter: Data | null, includePrivileged: boolean): matter is Data {
  if (!matter || isDeleted(matter) || matter['destroyedAt']) return false;
  return matter['privileged'] !== true || includePrivileged;
}

/** One page's CSV lines. */
type PageRows = (docs: QueryDocumentSnapshot[]) => Promise<string[]>;

function pageRows(scope: ExportScope, lookups: Lookups, extra: { unitMinutes: number }): PageRows {
  const { request } = scope;
  const includePrivileged = request.includePrivileged;
  switch (request.kind) {
    case 'matters': {
      const filters = request.filters as MatterExportFilters;
      return async (docs) => {
        const matters = docs
          .map((doc) => doc.data())
          .filter((matter) => matterAllowed(matter, includePrivileged))
          .filter((matter) =>
            matterPassesFilters(
              {
                deletedAt: matter['deletedAt'],
                status: String(matter['status'] ?? ''),
                type: String(matter['type'] ?? ''),
                responsibleUid: String(matter['responsibleUid'] ?? ''),
                labels: strings(matter['labels']),
                jurisdiction: String(matter['jurisdiction'] ?? ''),
                nextDeadline: matter['nextDeadline'] as { dueDate: string } | undefined,
                closedAt: instantOf(matter['closedAt']),
                search: strings(matter['search']),
                number: String(matter['number'] ?? ''),
                title: String(matter['title'] ?? ''),
              },
              filters,
              { viewerUid: scope.uid, today: scope.today, now: scope.now },
            ),
          );
        await Promise.all([
          lookups.loadContacts(matters.flatMap((matter) => strings(matter['clientContactIds']))),
          lookups.loadMembers(matters.map((matter) => String(matter['responsibleUid'] ?? ''))),
        ]);
        return matters.map((matter) =>
          exportLine(
            matterExportCells(matter, {
              openedOn: dayOfInstant(matter['createdAt'], scope.timeZone),
              closedOn: matter['closedAt'] ? dayOfInstant(matter['closedAt'], scope.timeZone) : null,
              clients: strings(matter['clientContactIds']).map(lookups.contact).filter(Boolean),
              responsible: lookups.member(matter['responsibleUid']),
            }),
          ),
        );
      };
    }
    case 'contacts': {
      const filters = request.filters as ContactExportFilters;
      return async (docs) =>
        docs
          .map((doc) => doc.data())
          .filter((contact) =>
            contactPassesFilters(
              {
                ...(contact as Partial<Parameters<typeof contactPassesFilters>[0]>),
                kind: String(contact['kind'] ?? ''),
                tags: strings(contact['tags']),
                matterRoles: strings(contact['matterRoles']),
                emails: (contact['emails'] as Parameters<typeof contactPassesFilters>[0]['emails']) ?? [],
                phones: (contact['phones'] as Parameters<typeof contactPassesFilters>[0]['phones']) ?? [],
              },
              filters,
            ),
          )
          .map((contact) => exportLine(contactExportCells(contact)));
    }
    case 'time': {
      const filters = request.filters as TimeExportFilters;
      return async (docs) => {
        const entries = docs
          .map((doc) => doc.data())
          .filter((entry) => !isDeleted(entry))
          .filter((entry) => !filters.uid || entry['uid'] === filters.uid)
          .filter((entry) => !filters.status || entry['status'] === filters.status)
          .filter(
            (entry) =>
              !filters.unbilledOnly ||
              isUnbilledWip({
                matterId: String(entry['matterId']),
                date: String(entry['date']),
                amountCents: Number(entry['amountCents']),
                billable: entry['billable'] === true,
                status: String(entry['status']),
                invoiceId: entry['invoiceId'] as string | undefined,
              }),
          );
        await Promise.all([
          lookups.loadMatters(entries.map((entry) => String(entry['matterId']))),
          lookups.loadMembers(entries.map((entry) => String(entry['uid']))),
        ]);
        return entries.flatMap((entry) => {
          const matter = lookups.matter(entry['matterId']);
          if (!matterAllowed(matter, includePrivileged)) return [];
          if (filters.responsibleUid && matter['responsibleUid'] !== filters.responsibleUid) return [];
          if (filters.matterType && matter['type'] !== filters.matterType) return [];
          const writeDown = entry['writeDown'] as { originalAmountCents?: number; reason?: string } | undefined;
          return [
            exportLine(
              timeExportCells({
                date: String(entry['date']),
                matterNumber: String(matter['number'] ?? ''),
                matterTitle: String(matter['title'] ?? ''),
                person: lookups.member(entry['uid']) || String(entry['uid']),
                narrative: String(entry['narrative'] ?? ''),
                minutes: Number(entry['minutes']) || 0,
                units: Number(entry['units']) || 0,
                unitMinutes: extra.unitMinutes,
                rateCents: Number(entry['rateCents']) || 0,
                amountCents: Number(entry['amountCents']) || 0,
                billable: entry['billable'] === true,
                status: String(entry['status']),
                originalAmountCents: writeDown?.originalAmountCents,
                writeDownReason: writeDown?.reason,
              }),
            ),
          ];
        });
      };
    }
    case 'invoices': {
      const filters = request.filters as InvoiceExportFilters;
      return async (docs) => {
        const invoices = docs
          .map((doc) => doc.data())
          .filter((invoice) => !isDeleted(invoice))
          .filter((invoice) => invoicePassesFilter(String(invoice['status'] ?? ''), filters.status));
        await lookups.loadMatters(invoices.map((invoice) => String(invoice['matterId'])));
        return invoices
          .filter((invoice) => {
            // An invoice outlives its matter's deletion (it is a financial record); only privilege hides it.
            const matter = lookups.matter(invoice['matterId']);
            return matter?.['privileged'] !== true || includePrivileged;
          })
          .map((invoice) => exportLine(invoiceExportCells(invoice)));
      };
    }
    case 'deadlines': {
      const filters = request.filters as DeadlineFilters;
      return async (docs) => {
        const deadlines = docs
          .map((doc) => doc.data())
          .filter((deadline) => !isDeleted(deadline))
          .filter((deadline) => deadline['privileged'] !== true || includePrivileged);
        await Promise.all([
          lookups.loadMatters(deadlines.map((deadline) => String(deadline['matterId']))),
          lookups.loadMembers(deadlines.map((deadline) => String(deadline['assigneeUid'] ?? ''))),
        ]);
        return deadlines.flatMap((deadline) => {
          const matter = lookups.matter(deadline['matterId']);
          if (!matterAllowed(matter, includePrivileged)) return [];
          const passes = deadlineMatchesFilters(
            {
              ...(deadline as Parameters<typeof deadlineMatchesFilters>[0]),
              critical: deadline['critical'] === true,
              kind: String(deadline['kind'] ?? ''),
            },
            filters,
            {
              uid: scope.uid,
              matter: {
                jurisdiction: asJurisdiction(matter['jurisdiction']),
                responsibleUid: matter['responsibleUid'] as string | undefined,
                teamUids: strings(matter['teamUids']),
              },
            },
          );
          if (!passes) return [];
          return [
            exportLine(
              deadlineExportCells(deadline, {
                matterNumber: String(matter['number'] ?? ''),
                matterTitle: String(matter['title'] ?? ''),
                jurisdiction: String(matter['jurisdiction'] ?? ''),
                assignee: lookups.member(deadline['assigneeUid']),
              }),
            ),
          ];
        });
      };
    }
  }
}

/** The export's lines: the header, then each row (no line endings). */
export async function* exportLines(scope: ExportScope, pageSize = EXPORT_PAGE_SIZE): AsyncGenerator<string> {
  const lookups = new Lookups(scope.db, scope.orgId);
  const org = scope.request.kind === 'time' ? await scope.db.doc(`orgs/${scope.orgId}`).get() : null;
  const unitMinutes = Number(org?.get('billing.unitMinutes')) || BILLING_UNIT_MINUTES;
  const rows = pageRows(scope, lookups, { unitMinutes });
  yield exportHeader(scope.request.kind);
  let written = 0;
  for await (const docs of pages(exportQuery(scope), pageSize)) {
    for (const line of await rows(docs)) {
      if (written >= EXPORT_MAX_ROWS) return;
      written++;
      yield line;
    }
  }
}

export interface ExportFile {
  storagePath: string;
  rows: number;
  sizeBytes: number;
  sha256: string;
}

/**
 * Writes the export to `orgs/{orgId}/exports/{jobId}.csv`: UTF-8 with a byte-order mark, CRLF
 * lines. A retry replaces what an earlier attempt left. `onRows` hears the count as it grows.
 */
export async function writeExport(
  files: FileStore,
  scope: ExportScope,
  jobId: string,
  options: { onRows?: (rows: number) => Promise<void> | void; pageSize?: number; disposition?: string } = {},
): Promise<ExportFile> {
  const storagePath = `orgs/${scope.orgId}/exports/${jobId}.csv`;
  const hash = createHash('sha256');
  let sizeBytes = 0;
  let rows = -1;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    const encoder = new TextEncoder();
    let buffer = CSV_BOM;
    const flush = () => {
      const bytes = encoder.encode(buffer);
      buffer = '';
      hash.update(bytes);
      sizeBytes += bytes.length;
      return bytes;
    };
    for await (const line of exportLines(scope, options.pageSize)) {
      buffer += `${line}\r\n`;
      rows++;
      if (rows > 0 && rows % 1000 === 0) await options.onRows?.(rows);
      if (buffer.length >= 64 * 1024) yield flush();
    }
    if (buffer) yield flush();
  }
  await files.remove(storagePath);
  await files.writeStream(storagePath, chunks(), {
    contentType: 'text/csv; charset=utf-8',
    ...(options.disposition ? { disposition: options.disposition } : {}),
  });
  return { storagePath, rows: Math.max(0, rows), sizeBytes, sha256: hash.digest('hex') };
}

/**
 * Whether the member may still have this export now it's written (a role change or removal
 * while it ran discards it): still an active member, still allowed this list, and still allowed
 * privileged rows if it holds them.
 */
export async function stillAllowed(
  db: Firestore,
  orgId: string,
  uid: string,
  request: ExportJobInput,
): Promise<boolean> {
  const member = await db.doc(`orgs/${orgId}/members/${uid}`).get();
  const role = member.get('role') as Role | undefined;
  if (member.get('status') !== 'active' || !canExport(role, request.kind)) return false;
  return !request.includePrivileged || exportIncludesPrivileged(role, true);
}
