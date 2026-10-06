import * as z from 'zod';

import {
  DomainError,
  IntegrationStatus,
  Org,
  XERO_CALLABLES,
  type DisconnectIntegrationInput,
  type DisconnectIntegrationResult,
  type SaveXeroSettingsInput,
  type SaveXeroSettingsResult,
  type SendToXeroInput,
  type SendToXeroResult,
  type StartIntegrationInput,
  type StartIntegrationResult,
  type XeroOptionsInput,
  type XeroOptionsResult,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import { repo, type Repository } from './repository';

/** What Settings → Integrations and an invoice read from `orgs/{orgId}`: the `xero` settings (BILL-09). */
export const OrgXeroSettingsSchema = /* @__PURE__ */ z.object({ xero: Org.schema.shape.xero });
export type OrgXeroSettings = z.infer<typeof OrgXeroSettingsSchema>;

/** The active org's Xero settings, read-only: saves go through `xero-saveSettings`. */
export function orgXeroSettingsRepository(): Repository<OrgXeroSettings> {
  return repo(() => 'orgs', { schema: OrgXeroSettingsSchema, version: Org.version });
}

/**
 * A connection's state (`integrationStatus/{id}`, INT-01): connected, needs reconnecting or off,
 * the provider account, and for Xero when payments were last brought across (BILL-09). Not
 * strict: fields the server adds later are dropped on read.
 */
export const IntegrationStatusItemSchema = /* @__PURE__ */ z.object({ ...IntegrationStatus.schema.shape });
export type IntegrationStatusItem = z.infer<typeof IntegrationStatusItemSchema>;

/**
 * Connections by id (`orgs/{orgId}/integrationStatus`; the practice's Xero connection is `xero`):
 * read-only on the client. Only the token vault's callables write them.
 */
export function integrationStatusRepository(): Repository<IntegrationStatusItem> {
  const base = repo((orgId) => `orgs/${orgId}/integrationStatus`, {
    schema: IntegrationStatusItemSchema,
    version: IntegrationStatus.version,
  });
  const refuse = () =>
    Promise.reject(
      new DomainError('FAILED_PRECONDITION', 'Connections change through the integrations-* callables', {
        reason: 'callable_only',
      }),
    );
  return { ...base, create: refuse, update: refuse, softDelete: refuse, hardDelete: refuse };
}

type Input<T> = Omit<T, 'requestId'>;

/** The `xero-*` callables (BILL-09), all idempotent. */
export interface XeroCallables {
  /** `xero-options` (`org.settings`): the Xero organisations the connection reaches, and one's accounts. */
  options(input?: Input<XeroOptionsInput>): Promise<XeroOptionsResult>;
  /** `xero-saveSettings` (`org.settings`): Settings → Integrations. */
  saveSettings(input: Input<SaveXeroSettingsInput>): Promise<SaveXeroSettingsResult>;
  /**
   * `xero-send` (`billing.issue`): one invoice or credit note, or (neither, owners and admins)
   * everything issued since the "send from" date that isn't in Xero yet.
   */
  send(input?: Input<SendToXeroInput>): Promise<SendToXeroResult>;
}

export function xeroCallables(client: Pick<CallableClient, 'call'>): XeroCallables {
  return {
    options: (input = {}) =>
      client.call<Input<XeroOptionsInput>, XeroOptionsResult>(XERO_CALLABLES.options, input, { idempotent: true }),
    saveSettings: (input) =>
      client.call<Input<SaveXeroSettingsInput>, SaveXeroSettingsResult>(XERO_CALLABLES.saveSettings, input, {
        idempotent: true,
      }),
    send: (input = {}) =>
      client.call<Input<SendToXeroInput>, SendToXeroResult>(XERO_CALLABLES.send, input, { idempotent: true }),
  };
}

/** The token vault's connect and disconnect (INT-01), which Settings → Integrations uses for Xero. */
export const INTEGRATION_CALLABLES = {
  start: 'integrations-start',
  disconnect: 'integrations-disconnect',
} as const;

/** `integrations-start` and `integrations-disconnect`, both idempotent. */
export interface IntegrationCallables {
  /** Begins connecting: returns the provider's consent page. Needs a sign-in within five minutes. */
  start(input: Input<StartIntegrationInput>): Promise<StartIntegrationResult>;
  /** Deletes the connection's token and revokes it where the provider can. */
  disconnect(input: Input<DisconnectIntegrationInput>): Promise<DisconnectIntegrationResult>;
}

export function integrationCallables(client: Pick<CallableClient, 'call'>): IntegrationCallables {
  return {
    start: (input) =>
      client.call<Input<StartIntegrationInput>, StartIntegrationResult>(INTEGRATION_CALLABLES.start, input, {
        idempotent: true,
      }),
    disconnect: (input) =>
      client.call<Input<DisconnectIntegrationInput>, DisconnectIntegrationResult>(
        INTEGRATION_CALLABLES.disconnect,
        input,
        { idempotent: true },
      ),
  };
}
