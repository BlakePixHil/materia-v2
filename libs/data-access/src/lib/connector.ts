import * as z from 'zod';

import {
  CONNECTOR_CALLABLES,
  ConnectorConnection,
  DomainError,
  Org,
  OrgConnectorSettingsSchema,
  type AuthorizeConnectorInput,
  type AuthorizeConnectorResult,
  type DisconnectConnectorInput,
  type DisconnectConnectorResult,
  type SetConnectorPracticeInput,
  type SetConnectorPracticeResult,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import { repo, type Repository } from './repository';

// The schemas are built on first use, not when the repository barrel loads (MOB-02b, ADR-056).

/** What Settings → Claude connector reads from `orgs/{orgId}` (INT-07): the practice's switch. */
const orgConnectorSettingsReadSchema = () =>
  z.object({
    name: Org.schema.shape.name,
    settings: z.object({ connector: OrgConnectorSettingsSchema.optional() }).optional(),
  });
export type OrgConnectorSettingsRead = z.infer<ReturnType<typeof orgConnectorSettingsReadSchema>>;
let settingsSchema: ReturnType<typeof orgConnectorSettingsReadSchema> | undefined;

/** The active org's connector switch, read-only: it changes through `connector-setPractice`. */
export function orgConnectorSettingsRepository(): Repository<OrgConnectorSettingsRead> {
  return repo(() => 'orgs', { schema: (settingsSchema ??= orgConnectorSettingsReadSchema()), version: Org.version });
}

/** A person's connection of Claude to the practice (`connectorConnections/{id}`, INT-07, ADR-064). */
export type ConnectorConnectionItem = ConnectorConnection;

/**
 * Connections (`orgs/{orgId}/connectorConnections`): everyone reads their own (query `uid`), owners
 * and admins every one. Read-only on the client; only the `connector-*` callables and the token
 * endpoint write them.
 */
export function connectorConnectionsRepository(): Repository<ConnectorConnectionItem> {
  const base = repo((orgId) => `orgs/${orgId}/connectorConnections`, {
    schema: ConnectorConnection.schema,
    version: ConnectorConnection.version,
  });
  const refuse = () =>
    Promise.reject(
      new DomainError('FAILED_PRECONDITION', 'Connections change through the connector-* callables', {
        reason: 'callable_only',
      }),
    );
  return { ...base, create: refuse, update: refuse, softDelete: refuse, hardDelete: refuse };
}

type Input<T> = Omit<T, 'requestId'>;

/** The `connector-*` callables (INT-07), all idempotent. */
export interface ConnectorCallables {
  /** The consent page's Allow: returns the redirect back to Claude. Needs a sign-in within five minutes. */
  authorize(input: Input<AuthorizeConnectorInput> & { origin?: string }): Promise<AuthorizeConnectorResult>;
  /** Owners and admins: the practice's switch, and whether Claude may suggest changes. Needs a recent sign-in. */
  setPractice(input: Input<SetConnectorPracticeInput>): Promise<SetConnectorPracticeResult>;
  /** Ends a connection at once: the person's own, or anyone's for owners and admins. */
  disconnect(input: Input<DisconnectConnectorInput>): Promise<DisconnectConnectorResult>;
}

export function connectorCallables(client: Pick<CallableClient, 'call'>): ConnectorCallables {
  return {
    authorize: (input) =>
      client.call<Input<AuthorizeConnectorInput> & { origin?: string }, AuthorizeConnectorResult>(
        CONNECTOR_CALLABLES.authorize,
        input,
        { idempotent: true },
      ),
    setPractice: (input) =>
      client.call<Input<SetConnectorPracticeInput>, SetConnectorPracticeResult>(
        CONNECTOR_CALLABLES.setPractice,
        input,
        {
          idempotent: true,
        },
      ),
    disconnect: (input) =>
      client.call<Input<DisconnectConnectorInput>, DisconnectConnectorResult>(CONNECTOR_CALLABLES.disconnect, input, {
        idempotent: true,
      }),
  };
}
