import { FieldValue, type DocumentReference, type Transaction } from 'firebase-admin/firestore';

import {
  clientContactIdsFrom,
  DomainError,
  Party,
  partyDocId,
  PartyRoleSchema,
  PERMISSIONS,
  RemovePartyInput,
  UpsertPartyInput,
  type PartyResult,
  type PartyRole,
} from '@materia/domain';

import { recordMatterActivity } from './denormalise';
import { matterPath, writableMatter } from './shared';
import { audit } from '../audit/audit';
import { contactPath, isDeleted, isLive, stamp } from '../contacts/shared';
import { defineCallable, type CallableContext, type CallableDefinition } from '../core/callable';

type Data = Record<string, unknown>;

/** A party row as the transaction sees it. */
interface Row {
  contactId: string;
  role: PartyRole | undefined;
  live: boolean;
}

const asRow = (data: Data): Row => {
  const role = PartyRoleSchema.safeParse(data['role']);
  return {
    contactId: typeof data['contactId'] === 'string' ? data['contactId'] : '',
    role: role.success ? role.data : undefined,
    live: !isDeleted(data),
  };
};

const partyNotFound = (partyId: string) => new DomainError('NOT_FOUND', 'Party not found', { partyId });

/**
 * The matter's `clientContactIds` once the party rows are `rows`: the contacts of the live client
 * rows (`clientContactIdsFrom`), plus any client the matter lists with no client row at all (a
 * matter written before CORE-06), in the matter's existing order with new clients appended.
 */
export function nextClientContactIds(current: readonly string[], rows: ReadonlyMap<string, Row>): string[] {
  const all = [...rows.values()];
  const fromRows = clientContactIdsFrom(
    all.filter((row) => row.live && row.role).map((row) => ({ contactId: row.contactId, role: row.role as PartyRole })),
  );
  const withRow = new Set(all.filter((row) => row.role === 'client').map((row) => row.contactId));
  const wanted = new Set([...fromRows, ...current.filter((id) => !withRow.has(id))]);
  return [...current.filter((id) => wanted.has(id)), ...[...wanted].filter((id) => !current.includes(id))];
}

/** What a party change did, for the result and the audit entry. */
interface PartyChange {
  action: 'added' | 'updated' | 'removed';
  partyId: string;
  contactId: string;
  role: string;
  previousPartyId?: string;
  previousRole?: string;
  clientContactIds: string[];
}

/**
 * Reads the live, visible matter and its party rows, lets `apply` change the rows (it queues its own
 * writes), then recomputes `clientContactIds`: empty is LAST_CLIENT, a change is written to the
 * matter (the matters-denormalise trigger then refreshes `search`). `apply` may read more first.
 */
async function changeParties(
  ctx: CallableContext<{ matterId: string }>,
  apply: (args: {
    tx: Transaction;
    /** A party row's reference by id. */
    partyRef: (partyId: string) => DocumentReference;
    rows: Map<string, Row>;
    now: Date;
  }) => Promise<Omit<PartyChange, 'clientContactIds'>>,
): Promise<PartyChange> {
  const { input, orgId, uid, role, db, clock, requestId } = ctx;
  const matterRef = db.doc(matterPath(orgId, input.matterId));
  const now = clock.now();
  const change = await db.runTransaction(async (tx) => {
    const matter = writableMatter(await tx.get(matterRef), role, input.matterId);
    const snaps = await tx.get(db.collection(`${matterRef.path}/parties`));
    const rows = new Map(snaps.docs.map((doc) => [doc.id, asRow(doc.data() as Data)]));
    const partyRef = (partyId: string) => db.doc(`${matterRef.path}/parties/${partyId}`);
    const result = await apply({ tx, partyRef, rows, now });
    const current = Array.isArray(matter['clientContactIds']) ? (matter['clientContactIds'] as string[]) : [];
    const clientContactIds = nextClientContactIds(current, rows);
    if (!clientContactIds.length) {
      throw new DomainError('LAST_CLIENT', 'A matter must keep at least one client', {
        matterId: input.matterId,
        partyId: result.partyId,
      });
    }
    if (JSON.stringify(clientContactIds) !== JSON.stringify(current)) {
      tx.update(matterRef, { clientContactIds, ...stamp(uid, now, requestId) });
    }
    return { ...result, clientContactIds };
  });
  await recordMatterActivity(db, orgId, input.matterId, now);
  return change;
}

async function auditChange(ctx: CallableContext<{ matterId: string }>, change: PartyChange) {
  const { input, orgId } = ctx;
  const path = `${matterPath(orgId, input.matterId)}/parties/${change.partyId}`;
  const moved = change.previousPartyId ? ` (was ${change.previousRole ?? 'unknown'})` : '';
  await audit(ctx, {
    action: `matter.party_${change.action}`,
    entity: { path },
    summary: `Party ${change.partyId} ${change.action} on matter ${input.matterId} as ${change.role}${moved}`,
    data: {
      matterId: input.matterId,
      partyId: change.partyId,
      contactId: change.contactId,
      role: change.role,
      ...(change.previousPartyId ? { previousPartyId: change.previousPartyId, previousRole: change.previousRole } : {}),
    },
  });
  ctx.log.info(`party ${change.action}`, {
    matterId: input.matterId,
    partyId: change.partyId,
    role: change.role,
  });
}

/**
 * `matters-upsertParty` (CORE-06, `matter.edit`, privileged matters for `privileged.view` roles
 * only). On a live matter, in one transaction:
 * - without `partyId`: adds the contact (live and not merged, else INVALID_ARGUMENT on `contactId`)
 *   in the role at `partyDocId(role, contactId)`: a new row, a revived soft-deleted row, or (when the
 *   contact already has the role) an edit of that row's share and notes;
 * - with `partyId`: edits that live row (NOT_FOUND otherwise); a changed role or contact
 *   soft-deletes it and creates or revives the row at the new id (INVALID_ARGUMENT on `role` when
 *   the contact already has that role on the matter).
 * `share` and `notes` are the row's full state: omitted clears them. Then `clientContactIds` is
 * recomputed from the live client rows (LAST_CLIENT when none would be left). Audited as
 * `matter.party_added` or `matter.party_updated` (ids and roles only).
 */
export const upsertPartyDefinition = {
  name: 'matters-upsertParty',
  input: UpsertPartyInput,
  roles: PERMISSIONS['matter.edit'],
  idempotent: true,
  handler: async (ctx): Promise<PartyResult> => {
    const { input, orgId, uid, db, requestId } = ctx;
    const change = await changeParties(ctx, async ({ tx, partyRef, rows, now }) => {
      const old = input.partyId ? rows.get(input.partyId) : undefined;
      if (input.partyId && !old?.live) throw partyNotFound(input.partyId);
      const moving = !!old && (old.role !== input.role || old.contactId !== input.contactId);
      const sameLive = [...rows].find(
        ([id, row]) => id !== input.partyId && row.live && row.role === input.role && row.contactId === input.contactId,
      )?.[0];
      if (moving && sameLive) {
        throw new DomainError('INVALID_ARGUMENT', 'The contact already has that role on the matter', {
          fields: { role: ['This contact already has that role on the matter'] },
        });
      }
      if (!input.partyId || moving) {
        const contact = await tx.get(db.doc(contactPath(orgId, input.contactId)));
        if (!contact.exists || !isLive(contact.data())) {
          throw new DomainError('INVALID_ARGUMENT', 'Invalid party', {
            fields: { contactId: ['Choose an existing contact'] },
          });
        }
      }

      const targetId = input.partyId && !moving ? input.partyId : (sameLive ?? partyDocId(input.role, input.contactId));
      const target = rows.get(targetId);
      const ref = partyRef(targetId);
      const meta = stamp(uid, now, requestId);
      if (!target) {
        tx.create(
          ref,
          Party.schema.parse({
            contactId: input.contactId,
            role: input.role,
            ...(input.share ? { share: input.share } : {}),
            ...(input.notes ? { notes: input.notes } : {}),
            addedFrom: 'manual',
            orgId,
            matterId: input.matterId,
            createdAt: now,
            createdBy: uid,
            ...meta,
            schemaVersion: Party.version,
          }),
        );
      } else {
        tx.update(ref, {
          contactId: input.contactId,
          role: input.role,
          share: input.share || FieldValue.delete(),
          notes: input.notes || FieldValue.delete(),
          // Reviving a soft-deleted row (a no-op on a live one).
          ...(target.live ? {} : { deletedAt: null, deletedBy: null }),
          // Rows written before the collection-group keys existed get them.
          orgId,
          matterId: input.matterId,
          ...meta,
        });
      }
      rows.set(targetId, { contactId: input.contactId, role: input.role, live: true });
      if (moving && input.partyId && targetId !== input.partyId) {
        tx.update(partyRef(input.partyId), {
          deletedAt: now,
          deletedBy: uid,
          ...meta,
        });
        rows.set(input.partyId, { ...(old as Row), live: false });
      }
      return {
        action: !input.partyId && !target?.live ? 'added' : 'updated',
        partyId: targetId,
        contactId: input.contactId,
        role: input.role,
        ...(moving && input.partyId && input.partyId !== targetId
          ? { previousPartyId: input.partyId, previousRole: old?.role ?? 'unknown' }
          : {}),
      };
    });
    await auditChange(ctx, change);
    return { matterId: input.matterId, partyId: change.partyId, clientContactIds: change.clientContactIds };
  },
} satisfies CallableDefinition<typeof UpsertPartyInput, PartyResult>;

/**
 * `matters-removeParty` (CORE-06, `matter.edit`, privileged visibility as above). Soft-deletes a
 * live party row of a live matter (NOT_FOUND otherwise) and recomputes `clientContactIds`; removing
 * the last client is LAST_CLIENT. Audited as `matter.party_removed`.
 */
export const removePartyDefinition = {
  name: 'matters-removeParty',
  input: RemovePartyInput,
  roles: PERMISSIONS['matter.edit'],
  idempotent: true,
  handler: async (ctx): Promise<PartyResult> => {
    const { input, uid, requestId } = ctx;
    const change = await changeParties(ctx, async ({ tx, partyRef, rows, now }) => {
      const row = rows.get(input.partyId);
      if (!row?.live) throw partyNotFound(input.partyId);
      tx.update(partyRef(input.partyId), {
        deletedAt: now,
        deletedBy: uid,
        ...stamp(uid, now, requestId),
      });
      rows.set(input.partyId, { ...row, live: false });
      return { action: 'removed', partyId: input.partyId, contactId: row.contactId, role: row.role ?? 'unknown' };
    });
    await auditChange(ctx, change);
    return { matterId: input.matterId, partyId: change.partyId, clientContactIds: change.clientContactIds };
  },
} satisfies CallableDefinition<typeof RemovePartyInput, PartyResult>;

export const upsertParty = defineCallable(upsertPartyDefinition);
export const removeParty = defineCallable(removePartyDefinition);
