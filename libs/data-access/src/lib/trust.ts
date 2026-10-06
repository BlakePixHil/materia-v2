import * as z from 'zod';

import {
  DomainError,
  Org,
  TRUST_CALLABLES,
  TrustSnapshot,
  type RecordTrustSnapshotInput,
  type TrustSaveResult,
  type UpdateTrustSettingsInput,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import { repo, type Repository } from './repository';

/**
 * A matter's trust balance snapshot (BILL-11, ADR-035), as `trustSnapshots/{matterId}` holds it.
 * Not strict: the server's `_requestId` is dropped on read.
 */
export const TrustSnapshotItemSchema = /* @__PURE__ */ z.object({ ...TrustSnapshot.schema.shape });
export type TrustSnapshotItem = z.infer<typeof TrustSnapshotItemSchema>;

/**
 * Trust balance snapshots by matter id (`orgs/{orgId}/trustSnapshots`): read-only on the client,
 * and readable only by `billing.view` roles. Every write is `trust-recordSnapshot`, which audits it.
 */
export function trustSnapshotRepository(): Repository<TrustSnapshotItem> {
  const base = repo((orgId) => `orgs/${orgId}/trustSnapshots`, {
    schema: TrustSnapshotItemSchema,
    version: TrustSnapshot.version,
  });
  const refuse = () =>
    Promise.reject(
      new DomainError('FAILED_PRECONDITION', 'Trust balances change through trust-recordSnapshot', {
        reason: 'callable_only',
      }),
    );
  return { ...base, create: refuse, update: refuse, softDelete: refuse, hardDelete: refuse };
}

/** What Settings → Trust account and the matter read from `orgs/{orgId}`: the `trust` settings. */
export const OrgTrustSettingsSchema = /* @__PURE__ */ z.object({ trust: Org.schema.shape.trust });
export type OrgTrustSettings = z.infer<typeof OrgTrustSettingsSchema>;

/** The active org's trust settings, read-only: saves go through `trust-updateSettings`. */
export function orgTrustSettingsRepository(): Repository<OrgTrustSettings> {
  return repo(() => 'orgs', { schema: OrgTrustSettingsSchema, version: Org.version });
}

type Input<T> = Omit<T, 'requestId'>;

/** The `trust-*` callables (BILL-11), both idempotent. */
export interface TrustCallables {
  /** `trust-recordSnapshot` (`trust.record`): the balance copied from the firm's trust records. */
  recordSnapshot(input: Input<RecordTrustSnapshotInput>): Promise<TrustSaveResult>;
  /** `trust-updateSettings` (`org.settings`): Settings → Trust account. */
  updateSettings(input: Input<UpdateTrustSettingsInput>): Promise<TrustSaveResult>;
}

export function trustCallables(client: Pick<CallableClient, 'call'>): TrustCallables {
  return {
    recordSnapshot: (input) =>
      client.call<Input<RecordTrustSnapshotInput>, TrustSaveResult>(TRUST_CALLABLES.recordSnapshot, input, {
        idempotent: true,
      }),
    updateSettings: (input) =>
      client.call<Input<UpdateTrustSettingsInput>, TrustSaveResult>(TRUST_CALLABLES.updateSettings, input, {
        idempotent: true,
      }),
  };
}
