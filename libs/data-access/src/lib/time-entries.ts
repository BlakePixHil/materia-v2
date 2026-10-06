import { inject } from '@angular/core';
import * as z from 'zod';

import {
  BILLING_CALLABLES,
  DomainError,
  SoftDeleteShape,
  TIME_CALLABLES,
  TimeEntry,
  TimeEntryCreateInput,
  type BillingWipResult,
  type RejectTimeEntriesInput,
  type SetTimeEntryStatusInput,
  type SetTimeEntryStatusResult,
  type TimeExportInput,
  type TimeWriteDownInput,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import { OrgContext } from './org-context';
import type { QuerySpec } from './query';
import { groupRepo, repo, type GroupRepository, type Repository } from './repository';

const entry = TimeEntry.schema.shape;

/** A time entry as the Time tab reads it (BILL-01). Other fields are dropped, not rejected. */
export const TimeEntryItemSchema = /* @__PURE__ */ z.object({
  orgId: entry.orgId.optional(),
  matterId: entry.matterId.optional(),
  uid: entry.uid,
  date: entry.date,
  minutes: entry.minutes,
  units: entry.units,
  rateCents: entry.rateCents,
  amountCents: entry.amountCents,
  narrative: entry.narrative,
  billable: entry.billable,
  status: entry.status,
  source: entry.source,
  taskId: entry.taskId,
  invoiceId: entry.invoiceId,
  writeDown: entry.writeDown,
  rejection: entry.rejection,
  createdAt: entry.createdAt.optional(),
  updatedAt: entry.updatedAt.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type TimeEntryItem = z.infer<typeof TimeEntryItemSchema>;

/**
 * What a form gives a new entry: the work and the client's preview of units, rate and amount
 * (`computeTimeEntry`). The repository adds org, matter, the author, `status: 'draft'`,
 * `source: 'manual'` and `wipCountedCents: 0`, which the rules require; `time-onWrite` then
 * replaces the preview with the values in force.
 */
export type NewTimeEntryFields = Pick<
  z.input<typeof TimeEntryCreateInput>,
  'date' | 'minutes' | 'narrative' | 'billable' | 'units' | 'rateCents' | 'amountCents' | 'taskId'
>;

/**
 * A matter's time entries (`orgs/{orgId}/matters/{matterId}/timeEntries`, BILL-01): live queries,
 * client-direct creates of my own drafts, updates of a draft's whitelisted fields (`TimeEntry.update`:
 * date, minutes, narrative, billable, the preview values, taskId) and soft deletes. Offline writes
 * queue and sync later. Status changes go through `timeCallables`.
 */
export function matterTimeRepository(matterId: () => string | null): Repository<TimeEntryItem> {
  const context = inject(OrgContext);
  const base = repo((orgId) => `orgs/${orgId}/matters/${matterId() ?? '-'}/timeEntries`, {
    schema: TimeEntryItemSchema,
    version: TimeEntry.version,
    create: TimeEntryCreateInput,
    update: TimeEntry.update,
  });
  return {
    ...base,
    create: (fields, options) => {
      const id = matterId();
      if (!id)
        return Promise.reject(
          new DomainError('INVALID_ARGUMENT', 'No matter to record the time on', { field: 'matterId' }),
        );
      return base.create(
        {
          ...fields,
          orgId: context.requireOrgId(),
          matterId: id,
          uid: context.requireUid(),
          status: 'draft',
          source: 'manual',
          wipCountedCents: 0,
        },
        options,
      );
    },
  };
}

/** A matter's entries, newest day first (the Time tab groups them by date). */
export const MATTER_TIME_QUERY: QuerySpec<TimeEntryItem> = { orderBy: [['date', 'desc']], pageSize: 500 };

/**
 * Time entries across the org (the `timeEntries` collection group, scoped to the active org).
 * Through the group every member reads their own entries; only roles with privileged.view read
 * other people's. Writes go through `matterTimeRepository` by the row's `matterId`.
 */
export function timeGroupRepository(): GroupRepository<TimeEntryItem> {
  return groupRepo('timeEntries', { schema: TimeEntryItemSchema, version: TimeEntry.version });
}

/** One person's entries on one day, across every matter (indexed: orgId, uid, date): the 24-hour check. */
export const dayTimeQuery = (uid: string, date: string): QuerySpec<TimeEntryItem> => ({
  where: [
    ['uid', '==', uid],
    ['date', '==', date],
  ],
  pageSize: 200,
});

/**
 * One person's entries dated `from` to `to`, across every matter, oldest first (indexed: orgId,
 * uid, date): My time's week and the FY budget card (BILL-03). Bounded at `pageSize`.
 */
export const personTimeQuery = (uid: string, from: string, to: string, pageSize = 500): QuerySpec<TimeEntryItem> => ({
  where: [
    ['uid', '==', uid],
    ['date', '>=', from],
    ['date', '<=', to],
  ],
  orderBy: [['date', 'asc']],
  pageSize,
});

/**
 * Drafts across the org, oldest first (indexed: orgId, status, date): the Approvals tab (BILL-03).
 * Only roles with privileged.view read other people's entries through the group, which every
 * approver (time.approve) has.
 */
export const DRAFT_TIME_QUERY: QuerySpec<TimeEntryItem> = {
  where: [['status', '==', 'draft']],
  orderBy: [['date', 'asc']],
  pageSize: 500,
};

// ---------- callables ----------

type Input<T> = Omit<T, 'requestId'>;

/** The `time-*` callables (BILL-01, BILL-03) and `billing-wip`. */
export interface TimeCallables {
  /**
   * `time-setStatus` (time.approve; idempotent): approves drafts (`final`, snapshotting each
   * entry's rate) or returns final entries to draft. Billed and written-off entries are skipped.
   */
  setStatus(input: Input<SetTimeEntryStatusInput>, options?: { requestId?: string }): Promise<SetTimeEntryStatusResult>;
  /** `time-writeDown` (time.approve; idempotent, BILL-03): to new units, by a percentage, or a write-off. */
  writeDown(input: Input<TimeWriteDownInput>, options?: { requestId?: string }): Promise<SetTimeEntryStatusResult>;
  /** `time-reject` (time.approve; idempotent, BILL-03): sends drafts back to their authors with a note. */
  reject(input: Input<RejectTimeEntriesInput>, options?: { requestId?: string }): Promise<SetTimeEntryStatusResult>;
  /** `time-exportCsv` (time.approve, BILL-03): entries by filter as CSV. */
  exportCsv(input: Input<TimeExportInput>): Promise<{ csv: string; rows: number; truncated: boolean }>;
  /** `billing-wip` (billing.view, BILL-03): unbilled WIP by matter, aggregated on the server. */
  wip(): Promise<BillingWipResult>;
}

export function timeCallables(client: Pick<CallableClient, 'call'>): TimeCallables {
  return {
    setStatus: (input, options = {}) =>
      client.call<Input<SetTimeEntryStatusInput>, SetTimeEntryStatusResult>(TIME_CALLABLES.setStatus, input, {
        idempotent: true,
        ...options,
      }),
    writeDown: (input, options = {}) =>
      client.call<Input<TimeWriteDownInput>, SetTimeEntryStatusResult>(TIME_CALLABLES.writeDown, input, {
        idempotent: true,
        ...options,
      }),
    reject: (input, options = {}) =>
      client.call<Input<RejectTimeEntriesInput>, SetTimeEntryStatusResult>(TIME_CALLABLES.reject, input, {
        idempotent: true,
        ...options,
      }),
    exportCsv: (input) =>
      client.call<Input<TimeExportInput>, { csv: string; rows: number; truncated: boolean }>(
        TIME_CALLABLES.exportCsv,
        input,
      ),
    wip: () => client.call<Record<string, never>, BillingWipResult>(BILLING_CALLABLES.wip, {}),
  };
}
