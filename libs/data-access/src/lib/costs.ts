import * as z from 'zod';

import {
  COSTS_CALLABLES,
  Matter,
  SoftDeleteShape,
  type DisclosureResult,
  type GenerateDisclosureInput,
  type GenerateDisclosureResult,
  type MarkDisclosureSentInput,
  type SetDisclosureWaiverInput,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

type Input<T> = Omit<T, 'requestId'>;

/** The `costs-*` callables (BILL-06): generating a matter's costs disclosure, recording it as sent, a lawyer's waiver. */
export interface CostsCallables {
  /** `costs-generateDisclosure` (billing.view; flag billing.costsDisclosure; idempotent). */
  generateDisclosure(
    input: Input<z.input<typeof GenerateDisclosureInput>>,
    options?: { requestId?: string },
  ): Promise<GenerateDisclosureResult>;
  /** `costs-markDisclosureSent` (billing.view; flag; idempotent): the date and how it was given. */
  markDisclosureSent(
    input: Input<z.input<typeof MarkDisclosureSentInput>>,
    options?: { requestId?: string },
  ): Promise<DisclosureResult>;
  /** `costs-setDisclosureWaiver` (matter.fee: lawyer and above; flag; idempotent): a waiver with its reason, or `null`. */
  setDisclosureWaiver(
    input: Input<z.input<typeof SetDisclosureWaiverInput>>,
    options?: { requestId?: string },
  ): Promise<DisclosureResult>;
}

export function costsCallables(client: Pick<CallableClient, 'call'>): CostsCallables {
  const call =
    <I extends object, R>(name: string) =>
    (input: I, options: { requestId?: string } = {}) =>
      client.call<I, R>(name, input, { idempotent: true, ...options });
  return {
    generateDisclosure: call(COSTS_CALLABLES.generateDisclosure),
    markDisclosureSent: call(COSTS_CALLABLES.markDisclosureSent),
    setDisclosureWaiver: call(COSTS_CALLABLES.setDisclosureWaiver),
  };
}

const matter = Matter.schema.shape;

/** A matter as the costs disclosure report reads it (BILL-06). */
export const DisclosureReportRowSchema = /* @__PURE__ */ z.object({
  number: matter.number,
  title: matter.title,
  type: matter.type,
  status: matter.status,
  jurisdiction: matter.jurisdiction,
  responsibleUid: matter.responsibleUid,
  privileged: matter.privileged,
  costsDisclosure: matter.costsDisclosure.optional().catch(undefined),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type DisclosureReportRow = z.infer<typeof DisclosureReportRowSchema>;

/** The org's matters, read for the report (billing.view roles, who see privileged matters too). */
export function disclosureReportRepository(): Repository<DisclosureReportRow> {
  return repo((orgId) => `orgs/${orgId}/matters`, { schema: DisclosureReportRowSchema, version: Matter.version });
}

/** Matters whose disclosure is due and not given: `required` or `update_required` (a single-field query, no index). */
export const OUTSTANDING_DISCLOSURES_QUERY: QuerySpec<DisclosureReportRow> = {
  where: [['costsDisclosure.status', 'in', ['required', 'update_required']]],
  pageSize: 500,
};
