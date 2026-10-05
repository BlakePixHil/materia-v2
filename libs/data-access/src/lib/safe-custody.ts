import * as z from 'zod';

import {
  DomainError,
  GET_EXPORT_URL_CALLABLE,
  matchesSearch,
  parseSearchQuery,
  SAFE_CUSTODY_CALLABLES,
  SafeCustody,
  SoftDeleteShape,
  type ConfirmDestructionInput,
  type GetExportUrlResult,
  type PacketReceiptInput,
  type ReceivePacketInput,
  type ReceivePacketResult,
  type RecordMovementInput,
  type RecordMovementResult,
  type SafeCustodyPdfResult,
  type SafeCustodyStatus,
  type StocktakeReportInput,
  type UpdatePacketInput,
  type VerifyPacketsInput,
  type VerifyPacketsResult,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

/**
 * A safe custody packet as the register reads it (CORE-17): the `SafeCustody` fields, with the
 * soft-delete fields typed and anything else the server keeps (`_requestId`) dropped.
 */
export const PacketItemSchema = /* @__PURE__ */ z.object({
  ...SafeCustody.schema.shape,
  deletedAt: SoftDeleteShape.deletedAt,
  deletedBy: SoftDeleteShape.deletedBy,
});
export type PacketItem = z.infer<typeof PacketItemSchema>;

/**
 * The register (`orgs/{orgId}/safeCustody`, CORE-17): read-only on the client. Every write is a
 * `safeCustody-*` callable (`safeCustodyCallables`), so each movement carries who, when and why.
 */
export function safeCustodyRepository(): Repository<PacketItem> {
  const base = repo((orgId) => `orgs/${orgId}/safeCustody`, { schema: PacketItemSchema, version: SafeCustody.version });
  const refuse = () =>
    Promise.reject(
      new DomainError('FAILED_PRECONDITION', 'Packets change through the safeCustody callables', {
        reason: 'callable_only',
      }),
    );
  return { ...base, create: refuse, update: refuse, softDelete: refuse, hardDelete: refuse };
}

export interface PacketFilters {
  /** What was typed: a testator's name, a packet number, a site or cabinet. */
  query?: string;
  status?: SafeCustodyStatus | null;
}

export const PACKET_PAGE_SIZE = 50;

/**
 * The register's query, newest packet first. One filter reaches Firestore: the search token, else
 * the status (indexes: search CONTAINS + packetNo desc, status + packetNo desc);
 * `packetMatchesFilters` applies the rest.
 */
export function packetListQuery(filters: PacketFilters = {}, pageSize = PACKET_PAGE_SIZE): QuerySpec<PacketItem> {
  const { token } = parseSearchQuery(filters.query ?? '');
  const where = token
    ? [['search', 'array-contains', token] as const]
    : filters.status
      ? [['status', '==', filters.status] as const]
      : [];
  return { ...(where.length ? { where } : {}), orderBy: [['packetNo', 'desc']], pageSize };
}

/** Whether a loaded packet passes every filter (and every word searched). Deleted packets never show. */
export function packetMatchesFilters(row: PacketItem, filters: PacketFilters = {}): boolean {
  if (row.deletedAt) return false;
  if (filters.status && row.status !== filters.status) return false;
  const query = parseSearchQuery(filters.query ?? '');
  if (!query.words.length && !query.number) return true;
  return matchesSearch(row.search, query, [row.packetNo, row.testatorName]);
}

/** A testator's packets (the contact screen). Equality only, so no composite index. */
export function contactPacketsQuery(contactId: string): QuerySpec<PacketItem> {
  return { where: [['testatorContactId', '==', contactId]], pageSize: 50 };
}

/** Held packets in shelf order, for the stocktake (index: status + locationKey asc). */
export function heldPacketsQuery(pageSize = 500): QuerySpec<PacketItem> {
  return { where: [['status', '==', 'held']], orderBy: [['locationKey', 'asc']], pageSize };
}

// ---------- callables ----------

/** Callable input without the request id, which the client adds. */
type Input<T> = Omit<T, 'requestId'>;
type Options = { requestId?: string };

/** The `safeCustody-*` callables (CORE-17), all idempotent, and the export download. */
export interface SafeCustodyCallables {
  receive(input: Input<ReceivePacketInput>, options?: Options): Promise<ReceivePacketResult>;
  update(input: Input<UpdatePacketInput>, options?: Options): Promise<{ id: string }>;
  /** Releases and destructions need a lawyer or above and a recent sign-in (REAUTH_REQUIRED otherwise). */
  recordMovement(input: Input<RecordMovementInput>, options?: Options): Promise<RecordMovementResult>;
  confirmDestruction(input: Input<ConfirmDestructionInput>, options?: Options): Promise<RecordMovementResult>;
  verify(input: Input<VerifyPacketsInput>, options?: Options): Promise<VerifyPacketsResult>;
  receipt(input: Input<PacketReceiptInput>, options?: Options): Promise<SafeCustodyPdfResult>;
  stocktakeReport(input: Input<StocktakeReportInput>, options?: Options): Promise<SafeCustodyPdfResult>;
  /** `jobs-getExportUrl`: a 5-minute link to a finished PDF this member started. */
  exportUrl(jobId: string): Promise<GetExportUrlResult>;
}

export function safeCustodyCallables(client: Pick<CallableClient, 'call'>): SafeCustodyCallables {
  const idempotent =
    <I extends object, O>(name: string) =>
    (input: I, options: Options = {}) =>
      client.call<I, O>(name, input, { idempotent: true, ...options });
  return {
    receive: idempotent(SAFE_CUSTODY_CALLABLES.receive),
    update: idempotent(SAFE_CUSTODY_CALLABLES.update),
    recordMovement: idempotent(SAFE_CUSTODY_CALLABLES.recordMovement),
    confirmDestruction: idempotent(SAFE_CUSTODY_CALLABLES.confirmDestruction),
    verify: idempotent(SAFE_CUSTODY_CALLABLES.verify),
    receipt: idempotent(SAFE_CUSTODY_CALLABLES.receipt),
    stocktakeReport: idempotent(SAFE_CUSTODY_CALLABLES.stocktakeReport),
    exportUrl: (jobId) => client.call<{ jobId: string }, GetExportUrlResult>(GET_EXPORT_URL_CALLABLE, { jobId }),
  };
}
