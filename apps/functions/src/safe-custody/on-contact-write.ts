import { contactDisplayName, type Contact, type SafeCustodyLocation } from '@materia/domain';

import { derivedFields } from './shared';
import { isDeleted, safeCustodyQuery } from '../contacts/shared';
import { isMigrationWrite } from '../core/migration';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';
import { notify } from '../notifications/notify';

type Data = Record<string, unknown>;

export interface ContactWriteOutcome {
  /** Packets whose lawyer was told the testator died. */
  notified: string[];
  /** Packets whose testator name (and search) was refreshed. */
  renamed: string[];
}

/**
 * Follows a testator's contact for the register (CORE-17):
 *
 * - when `dateOfDeath` is first recorded, each packet still in custody (held or out) tells its
 *   responsible lawyer "Original will held: SC-000123", linking to the packet, which offers to open
 *   a probate matter. Keyed by packet, so a redelivered event replaces rather than repeats it. No
 *   names in the notification: it may be emailed.
 * - when the name changes, each packet's `testatorName` and search tokens follow.
 */
export async function onTestatorWrite(change: TriggerChange, ctx: TriggerContext): Promise<ContactWriteOutcome> {
  const outcome: ContactWriteOutcome = { notified: [], renamed: [] };
  const after = change.after?.data() as (Partial<Contact> & Data) | undefined;
  if (!after) return outcome;
  const before = change.before?.data() as (Partial<Contact> & Data) | undefined;
  const orgId = ctx.params['orgId'] as string;
  const contactId = ctx.params['contactId'] as string;
  // A death the migration loads (MIG-06) was known in legacy: the packets' names follow, nobody is told.
  const died = !!after.dateOfDeath && !before?.dateOfDeath && !isDeleted(after) && !isMigrationWrite(before, after);
  const name = contactDisplayName(after);
  const renamed = !!before && name !== contactDisplayName(before);
  if (!died && !renamed) return outcome;

  const packets = await safeCustodyQuery(ctx.db, orgId, contactId).get();
  for (const packet of packets.docs) {
    const data = packet.data();
    if (isDeleted(data)) continue;
    if (renamed && data['testatorName'] !== name) {
      await packet.ref.update({
        testatorName: name,
        ...derivedFields(String(data['packetNo']), name, (data['location'] ?? {}) as Partial<SafeCustodyLocation>),
      });
      outcome.renamed.push(packet.id);
    }
    if (died && (data['status'] === 'held' || data['status'] === 'out')) {
      const packetNo = String(data['packetNo']);
      const result = await notify(
        { db: ctx.db, orgId, clock: ctx.clock, log: ctx.log, ports: ctx.ports },
        {
          kind: 'safe_custody',
          packetId: packet.id,
          recipients: [String(data['responsibleUid'] ?? data['createdBy'] ?? '')],
          title: `Original will held: ${packetNo}`,
          body: `The testator of ${packetNo} has died. Their original is in safe custody: open the packet to start a probate matter.`,
          link: `/safe-custody/${packet.id}`,
          key: `sc-death-${packet.id}`,
        },
      );
      if (result.ids.length) outcome.notified.push(packet.id);
    }
  }
  ctx.log.info('testator followed', { notified: outcome.notified.length, renamed: outcome.renamed.length });
  return outcome;
}

export const onContactWriteDefinition: TriggerDefinition = {
  name: 'safeCustody-onContactWrite',
  document: 'orgs/{orgId}/contacts/{contactId}',
  on: 'written',
  handler: async (change, ctx) => void (await onTestatorWrite(change, ctx)),
};

/** `safeCustody-onContactWrite`. */
export const onContactWrite = defineTrigger(onContactWriteDefinition);
