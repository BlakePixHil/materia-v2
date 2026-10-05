import * as z from 'zod';

import {
  Asset,
  Distribution,
  ESTATE_CALLABLES,
  Liability,
  SoftDeleteShape,
  type ExportInventoryInput,
  type ExportInventoryResult,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

/**
 * The estate register (CORE-16): a matter's `assets`, `liabilities` and `distributions`, written by
 * clients directly under the rules (`matter.edit`: create, edit the whitelisted fields, soft delete
 * or restore). `estate-onWrite` keeps the matter's totals (`estateRegister`) and flags
 * distributions for review.
 */

const asset = Asset.schema.shape;
const liability = Liability.schema.shape;
const distribution = Distribution.schema.shape;

/** An asset as the Estate tab reads it; other fields are dropped, not rejected. */
export const EstateAssetSchema = /* @__PURE__ */ z.object({
  class: asset.class,
  description: asset.description,
  institution: asset.institution,
  valueAtDeathCents: asset.valueAtDeathCents,
  valuationSource: asset.valuationSource,
  valuedOn: asset.valuedOn,
  jointlyHeld: asset.jointlyHeld,
  jointHolding: asset.jointHolding,
  shareBps: asset.shareBps,
  passesOutsideEstate: asset.passesOutsideEstate,
  status: asset.status,
  realisedCents: asset.realisedCents,
  originalCurrency: asset.originalCurrency,
  originalAmount: asset.originalAmount,
  documentIds: asset.documentIds,
  notes: asset.notes,
  createdAt: asset.createdAt.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type EstateAsset = z.infer<typeof EstateAssetSchema>;

export const EstateLiabilitySchema = /* @__PURE__ */ z.object({
  class: liability.class,
  creditor: liability.creditor,
  reference: liability.reference,
  amountCents: liability.amountCents,
  status: liability.status,
  notes: liability.notes,
  createdAt: liability.createdAt.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type EstateLiability = z.infer<typeof EstateLiabilitySchema>;

export const EstateDistributionSchema = /* @__PURE__ */ z.object({
  beneficiaryPartyId: distribution.beneficiaryPartyId,
  kind: distribution.kind,
  amountCents: distribution.amountCents,
  assetId: distribution.assetId,
  share: distribution.share,
  status: distribution.status,
  paidOn: distribution.paidOn,
  notes: distribution.notes,
  needsValueReview: distribution.needsValueReview,
  createdAt: distribution.createdAt.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type EstateDistribution = z.infer<typeof EstateDistributionSchema>;

const under = (matterId: () => string | null, collection: string) => (orgId: string) =>
  `orgs/${orgId}/matters/${matterId() ?? '-'}/${collection}`;

export function estateAssetsRepository(matterId: () => string | null): Repository<EstateAsset> {
  return repo(under(matterId, 'assets'), {
    schema: EstateAssetSchema,
    version: Asset.version,
    create: Asset.create,
    update: Asset.update,
  });
}

export function estateLiabilitiesRepository(matterId: () => string | null): Repository<EstateLiability> {
  return repo(under(matterId, 'liabilities'), {
    schema: EstateLiabilitySchema,
    version: Liability.version,
    create: Liability.create,
    update: Liability.update,
  });
}

export function estateDistributionsRepository(matterId: () => string | null): Repository<EstateDistribution> {
  return repo(under(matterId, 'distributions'), {
    schema: EstateDistributionSchema,
    version: Distribution.version,
    create: Distribution.create,
    update: Distribution.update,
  });
}

/**
 * A page of a matter's register, in the order entered. Totals never need every row: they come from
 * the matter's trigger-kept `estateRegister` once a register outgrows a page.
 */
export const ESTATE_PAGE_SIZE = 200;
export const ESTATE_ASSETS_QUERY: QuerySpec<EstateAsset> = {
  orderBy: [['createdAt', 'asc']],
  pageSize: ESTATE_PAGE_SIZE,
};
export const ESTATE_LIABILITIES_QUERY: QuerySpec<EstateLiability> = {
  orderBy: [['createdAt', 'asc']],
  pageSize: ESTATE_PAGE_SIZE,
};
export const ESTATE_DISTRIBUTIONS_QUERY: QuerySpec<EstateDistribution> = {
  orderBy: [['createdAt', 'asc']],
  pageSize: ESTATE_PAGE_SIZE,
};

type Input<T> = Omit<T, 'requestId'>;

export interface EstateCallables {
  exportInventory(input: Input<ExportInventoryInput>): Promise<ExportInventoryResult>;
}

/** `estate-exportInventory` (idempotent: a retry reuses the request id). */
export function estateCallables(client: Pick<CallableClient, 'call'>): EstateCallables {
  return {
    exportInventory: (input) =>
      client.call<Input<ExportInventoryInput>, ExportInventoryResult>(ESTATE_CALLABLES.exportInventory, input, {
        idempotent: true,
      }),
  };
}
