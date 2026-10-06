import { createHash } from 'node:crypto';

import { idempotencyKey } from './client';
import { xeroContactPath, type XeroDeps, type XeroOrg } from './shared';
import { compact } from '../contacts/shared';
import { XeroApiError, type XeroContactInput } from '../ports';

type Data = Record<string, unknown>;

/** `xeroContacts/{tenantId}_{sha256 of the sorted client ids}`: one link per organisation and client set. */
export function xeroContactLinkId(tenantId: string, clientContactIds: readonly string[]): string {
  const clients = createHash('sha256')
    .update([...clientContactIds].sort().join(','))
    .digest('hex')
    .slice(0, 40);
  return `${tenantId}_${clients}`;
}

const NAME_TAKEN = /already assigned to another contact/i;

/** An address Xero's `where` filter can take (no quotes or backslashes). */
const usableEmail = (email: unknown): string | undefined =>
  typeof email === 'string' && /^[^\s"\\@]+@[^\s"\\@]+$/.test(email.trim()) ? email.trim() : undefined;

function firstEmail(contact: Data | undefined): string | undefined {
  for (const email of (contact?.['emails'] as { address?: unknown }[] | undefined) ?? []) {
    const address = usableEmail(email?.address);
    if (address) return address;
  }
  return undefined;
}

/**
 * The Xero contact an invoice's buyer is (BILL-09). Matched by the link stored from a previous
 * invoice, then (for a single client) by email when exactly one active Xero contact has it, else
 * created. Never matched by name alone: when Xero says the name is taken by someone else, the new
 * contact's name gets the client's Materia reference in brackets.
 */
export async function ensureXeroContact(deps: XeroDeps, x: XeroOrg, invoice: Data): Promise<string> {
  const { db } = deps;
  const tenantId = x.settings.tenantId;
  const matter = (await db.doc(`orgs/${x.orgId}/matters/${String(invoice['matterId'])}`).get()).data();
  const clientContactIds = [...new Set((matter?.['clientContactIds'] as string[] | undefined) ?? [])].sort();
  const buyer = (invoice['buyer'] ?? {}) as { name?: string; abn?: string; address?: string };
  const name = (buyer.name ?? String(invoice['matterTitle'] ?? 'Client')).trim() || 'Client';
  // A matter with no client (rare) is linked by the matter itself.
  const linkKeys = clientContactIds.length ? clientContactIds : [`matter-${String(invoice['matterId'])}`];
  const linkRef = db.doc(xeroContactPath(x.orgId, xeroContactLinkId(tenantId, linkKeys)));

  const link = await linkRef.get();
  if (link.exists) {
    const found = await x.client.contact(tenantId, String(link.get('contactId')));
    if (found && !found.archived) return found.id;
  }

  const save = async (contactId: string, savedName: string) => {
    const at = deps.clock.now();
    await linkRef.set({
      tenantId,
      contactId,
      clientContactIds: clientContactIds.length ? clientContactIds : [String(invoice['matterId'])],
      name: savedName,
      createdAt: link.exists ? link.get('createdAt') : at,
      createdBy: 'system',
      updatedAt: at,
      updatedBy: 'system',
      schemaVersion: 1,
    });
    return contactId;
  };

  let email: string | undefined;
  if (clientContactIds.length === 1) {
    email = firstEmail((await db.doc(`orgs/${x.orgId}/contacts/${clientContactIds[0]}`).get()).data());
    if (email) {
      const [match, ...others] = (await x.client.contactsByEmail(tenantId, email)).filter(
        (contact) => !contact.archived,
      );
      if (match && !others.length) return save(match.id, match.name);
    }
  }

  const input = compact({
    name,
    email,
    taxNumber: buyer.abn || undefined,
    address: buyer.address || undefined,
  }) as XeroContactInput;
  const key = (variant: string) => idempotencyKey('contact', x.orgId, tenantId, linkRef.id, variant);
  try {
    const created = await x.client.createContact(tenantId, input, key('name'));
    return save(created.id, created.name);
  } catch (error) {
    if (!(error instanceof XeroApiError && error.messages.some((message) => NAME_TAKEN.test(message)))) throw error;
  }
  // Someone else in Xero has the name: never assume it's this client.
  const suffix = clientContactIds[0] ? `Materia ${clientContactIds[0].slice(0, 6)}` : 'Materia';
  const created = await x.client.createContact(tenantId, { ...input, name: `${name} (${suffix})` }, key('suffix'));
  return save(created.id, created.name);
}
