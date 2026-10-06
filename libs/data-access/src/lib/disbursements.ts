import { inject } from '@angular/core';
import * as z from 'zod';

import {
  DISBURSEMENT_CALLABLES,
  Disbursement,
  DisbursementCreateInput,
  DisbursementPresetSchema,
  DisbursementPresetsDoc,
  DomainError,
  SoftDeleteShape,
  type SetDisbursementStatusInput,
  type SetDisbursementStatusResult,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import { OrgContext } from './org-context';
import type { QuerySpec } from './query';
import { groupRepo, repo, type GroupRepository, type Repository } from './repository';

const item = Disbursement.schema.shape;

/** A disbursement as the Time tab reads it (BILL-04). Other fields are dropped, not rejected. */
export const DisbursementItemSchema = /* @__PURE__ */ z.object({
  orgId: item.orgId.optional(),
  matterId: item.matterId.optional(),
  date: item.date,
  description: item.description,
  payee: item.payee,
  category: item.category,
  presetId: item.presetId,
  amountExGstCents: item.amountExGstCents,
  gstCents: item.gstCents,
  amountIncGstCents: item.amountIncGstCents,
  gstTreatment: item.gstTreatment,
  receiptDocumentId: item.receiptDocumentId,
  status: item.status,
  invoiceId: item.invoiceId,
  createdAt: item.createdAt.optional(),
  createdBy: item.createdBy.optional(),
  updatedAt: item.updatedAt.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type DisbursementItem = z.infer<typeof DisbursementItemSchema>;

/**
 * What a form gives a new disbursement, with the client's preview of the amounts
 * (`disbursementAmounts`). The repository adds org, matter, `status: 'unbilled'` and
 * `wipCountedCents: 0`, which the rules require; `disbursements-onWrite` then recomputes the GST.
 */
export type NewDisbursementFields = Omit<
  z.input<typeof DisbursementCreateInput>,
  'orgId' | 'matterId' | 'status' | 'wipCountedCents'
>;

/**
 * A matter's disbursements (`orgs/{orgId}/matters/{matterId}/disbursements`, BILL-04): live
 * queries, client-direct creates, updates of an unbilled one's whitelisted fields
 * (`Disbursement.update`) and soft deletes. Writing off goes through `disbursementCallables`.
 */
export function matterDisbursementRepository(matterId: () => string | null): Repository<DisbursementItem> {
  const context = inject(OrgContext);
  const base = repo((orgId) => `orgs/${orgId}/matters/${matterId() ?? '-'}/disbursements`, {
    schema: DisbursementItemSchema,
    version: Disbursement.version,
    create: DisbursementCreateInput,
    update: Disbursement.update,
  });
  return {
    ...base,
    create: (fields, options) => {
      const id = matterId();
      if (!id)
        return Promise.reject(
          new DomainError('INVALID_ARGUMENT', 'No matter to record the disbursement on', { field: 'matterId' }),
        );
      return base.create(
        { ...fields, orgId: context.requireOrgId(), matterId: id, status: 'unbilled', wipCountedCents: 0 },
        options,
      );
    },
  };
}

/** A matter's disbursements, newest first. */
export const MATTER_DISBURSEMENTS_QUERY: QuerySpec<DisbursementItem> = { orderBy: [['date', 'desc']], pageSize: 500 };

/**
 * Disbursements across the org (the `disbursements` collection group, scoped to the active org),
 * for WIP lists (BILL-03). Only roles with privileged.view read through the group.
 */
export function disbursementGroupRepository(): GroupRepository<DisbursementItem> {
  return groupRepo('disbursements', { schema: DisbursementItemSchema, version: Disbursement.version });
}

/** `orgs/{orgId}/settings/disbursementPresets` as read (BILL-04). A malformed list reads as missing. */
export const DisbursementPresetsItemSchema = /* @__PURE__ */ z.object({
  presets: z.array(DisbursementPresetSchema).catch([]),
});
export type DisbursementPresetsItem = z.infer<typeof DisbursementPresetsItemSchema>;

/**
 * The org's disbursement presets document, by id `disbursementPresets`. Every member reads it;
 * owners and admins create it (the first save) and replace its list.
 */
export function disbursementPresetsRepository(): Repository<DisbursementPresetsItem> {
  return repo((orgId) => `orgs/${orgId}/settings`, {
    schema: DisbursementPresetsItemSchema,
    version: DisbursementPresetsDoc.version,
    create: DisbursementPresetsDoc.create,
    update: DisbursementPresetsDoc.update,
  });
}

// ---------- callables ----------

type Input<T> = Omit<T, 'requestId'>;

/** The `disbursements-*` callables (BILL-04). */
export interface DisbursementCallables {
  /** `disbursements-setStatus` (time.approve; idempotent): writes off or restores. Billed ones are skipped. */
  setStatus(
    input: Input<SetDisbursementStatusInput>,
    options?: { requestId?: string },
  ): Promise<SetDisbursementStatusResult>;
}

export function disbursementCallables(client: Pick<CallableClient, 'call'>): DisbursementCallables {
  return {
    setStatus: (input, options = {}) =>
      client.call<Input<SetDisbursementStatusInput>, SetDisbursementStatusResult>(
        DISBURSEMENT_CALLABLES.setStatus,
        input,
        { idempotent: true, ...options },
      ),
  };
}
