import {
  DomainError,
  DEFAULT_ORG_TIMEZONE,
  MatterNumber,
  matterNumberKey,
  matterNumberYear,
  PERMISSIONS,
  RenumberMatterInput,
  type RenumberMatterResult,
} from '@materia/domain';

import {
  contactNames,
  writableMatter,
  matterNumberPath,
  matterPath,
  matterSearch,
  mattersPath,
  searchContactIds,
} from './shared';
import { audit } from '../audit/audit';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';

/**
 * `matters-renumber` (CORE-21a, `matter.renumber`: lawyer and above). Gives a live matter a number
 * the person typed (to match the firm's other system, say). In one transaction: refuses a number
 * reserved by another matter or held by one without a reservation (ALREADY_EXISTS with
 * `details.number`), reserves the new number in `matterNumbers`, releases the old reservation when
 * it was this matter's, and updates `number` and `search`. A case-only change ("m-1" → "M-1") keeps
 * the same reservation. The year's counter is left alone: createMatter skips taken numbers. Audited
 * as `matter.renumbered`.
 */
export const renumberDefinition = {
  name: 'matters-renumber',
  input: RenumberMatterInput,
  roles: PERMISSIONS['matter.renumber'],
  idempotent: true,
  handler: async (ctx): Promise<RenumberMatterResult> => {
    const { input, orgId, uid, role, db, clock, requestId, log } = ctx;
    const ref = db.doc(matterPath(orgId, input.matterId));
    const number = input.number.trim();
    const newKey = matterNumberKey(number);
    const now = clock.now();
    const meta = { createdAt: now, createdBy: uid, updatedAt: now, updatedBy: uid };

    // Names for the search tokens, read before the transaction (they don't change the outcome).
    const before = writableMatter(await ref.get(), role, input.matterId);
    const names = await contactNames(db, orgId, searchContactIds(before));
    const org = (await db.doc(`orgs/${orgId}`).get()).data() ?? {};
    const timeZone = typeof org['timezone'] === 'string' && org['timezone'] ? org['timezone'] : DEFAULT_ORG_TIMEZONE;

    const from = await db.runTransaction(async (tx) => {
      const data = writableMatter(await tx.get(ref), role, input.matterId);
      const current = typeof data['number'] === 'string' ? data['number'] : '';
      if (current === number) return null;
      const oldKey = current ? matterNumberKey(current) : null;
      const newRef = db.doc(matterNumberPath(orgId, newKey));
      const [reserved, held, oldReservation] = await Promise.all([
        tx.get(newRef),
        tx.get(db.collection(mattersPath(orgId)).where('number', '==', number).limit(2)),
        oldKey && oldKey !== newKey ? tx.get(db.doc(matterNumberPath(orgId, oldKey))) : Promise.resolve(null),
      ]);
      const reservedByOther = reserved.exists && reserved.get('matterId') !== input.matterId;
      const heldByOther = held.docs.some((doc) => doc.id !== input.matterId);
      if (reservedByOther || heldByOther) {
        throw new DomainError('ALREADY_EXISTS', `Another matter already has the number ${number}`, {
          number,
          fields: { number: [`Another matter already has ${number}`] },
        });
      }

      if (reserved.exists) {
        // This matter's own reservation (a case-only change): keep it, with the new spelling.
        tx.update(newRef, { number, updatedAt: now, updatedBy: uid });
      } else {
        // The year the matter was numbered in, kept from its old reservation when it has one.
        const kept = Number(oldReservation?.get('year'));
        const year = Number.isInteger(kept) && kept >= 2000 ? kept : matterNumberYear(now, timeZone);
        tx.create(
          newRef,
          MatterNumber.schema.parse({ number, matterId: input.matterId, year, ...meta, schemaVersion: 1 }),
        );
      }
      if (oldReservation?.exists && oldReservation.get('matterId') === input.matterId) tx.delete(oldReservation.ref);
      tx.update(ref, {
        number,
        search: matterSearch({ ...data, number }, names),
        ...stamp(uid, now, requestId),
      });
      return current;
    });

    if (from === null) return { matterId: input.matterId, number, changed: false };
    await audit(ctx, {
      action: 'matter.renumbered',
      entity: { path: ref.path },
      summary: `Matter ${input.matterId} renumbered`,
      data: { from, to: number },
    });
    log.info('matter renumbered', { matterId: input.matterId });
    return { matterId: input.matterId, number, changed: true };
  },
} satisfies CallableDefinition<typeof RenumberMatterInput, RenumberMatterResult>;

export const renumber = defineCallable(renumberDefinition);
