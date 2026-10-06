import type { Firestore } from 'firebase-admin/firestore';

import { DomainError, XeroSettingsSchema, type XeroSettings, type XeroSync, type XeroSyncError } from '@materia/domain';

import { isEnabled } from '../core/flags';
import type { Log } from '../core/log';
import { authorizedFetch, integrationStatusPath, type VaultContext } from '../integrations/vault';
import type { Clock, Ports, XeroClient } from '../ports';

type Data = Record<string, unknown>;

/** The org's one Xero connection: the practice's, in the token vault (INT-01). */
export const XERO_CONNECTION = { provider: 'xero' as const, uid: null };

export const xeroStatusPath = (orgId: string) => integrationStatusPath(orgId, 'xero');
export const xeroContactPath = (orgId: string, linkId: string) => `orgs/${orgId}/xeroContacts/${linkId}`;

export interface XeroDeps {
  db: Firestore;
  clock: Clock;
  log: Log;
  ports: Pick<Ports, 'oauth' | 'oauthKms' | 'tasks' | 'xero'>;
}

/** Everything a Xero call needs for one org: its settings, and a client on its connection. */
export interface XeroOrg {
  orgId: string;
  settings: XeroSettings;
  client: XeroClient;
  vault: VaultContext;
  /** Whether the firm is registered for GST now (each invoice keeps its own flag). */
  gstRegistered: boolean;
}

/** A Xero client on the org's connection: every request carries the vault's access token. */
export function xeroClient(deps: XeroDeps, orgId: string): { client: XeroClient; vault: VaultContext } {
  const vault: VaultContext = { orgId, db: deps.db, clock: deps.clock, log: deps.log, ports: deps.ports };
  const client = deps.ports.xero.client((url, init) => authorizedFetch(vault, XERO_CONNECTION, url, init));
  return { client, vault };
}

/** The saved settings, or null when none are saved or they no longer parse. */
export function xeroSettingsOf(org: Data | undefined): XeroSettings | null {
  const parsed = XeroSettingsSchema.safeParse(org?.['xero']);
  return parsed.success ? parsed.data : null;
}

/** Sync can't run: Xero is off for the org, or not set up. Nothing is retried. */
export class XeroNotReady extends Error {
  constructor(
    readonly code: XeroSyncError,
    message: string,
  ) {
    super(message);
    this.name = 'XeroNotReady';
  }
}

/**
 * The org's Xero, ready to use: the flag on, an organisation and accounts chosen, and the
 * connection live. Throws XeroNotReady (`not_connected`) otherwise.
 */
export async function xeroOrg(deps: XeroDeps, orgId: string): Promise<XeroOrg> {
  if (!(await isEnabled({ orgId, db: deps.db, clock: deps.clock }, 'integrations.xero'))) {
    throw new XeroNotReady('not_connected', 'Xero is turned off for this practice.');
  }
  const org = (await deps.db.doc(`orgs/${orgId}`).get()).data();
  if (!org) throw new DomainError('NOT_FOUND', 'Organisation not found');
  const settings = xeroSettingsOf(org);
  if (!settings) {
    throw new XeroNotReady(
      'not_connected',
      'No Xero organisation is chosen. An owner or admin can choose one in Settings → Integrations.',
    );
  }
  const status = (await deps.db.doc(xeroStatusPath(orgId)).get()).get('status');
  if (status !== 'connected') {
    throw new XeroNotReady(
      'not_connected',
      status === 'reconnect_required'
        ? 'Xero needs reconnecting. An owner or admin can reconnect it in Settings → Integrations.'
        : 'Xero isn’t connected. An owner or admin can connect it in Settings → Integrations.',
    );
  }
  const billing = org['billing'] as { gstRegistered?: boolean } | undefined;
  return { orgId, settings, ...xeroClient(deps, orgId), gstRegistered: billing?.gstRegistered !== false };
}

/** The document's Xero copy, if it was sent to this organisation (a copy in another one doesn't count). */
export function syncIn(data: Data | undefined, tenantId: string): XeroSync | null {
  const sync = data?.['xero'] as XeroSync | undefined;
  return sync && sync.tenantId === tenantId ? sync : null;
}
