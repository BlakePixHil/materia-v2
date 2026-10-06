import {
  BILLING_WIP_MAX_ENTRIES,
  BillingWipInput,
  can,
  cents,
  PERMISSIONS,
  today,
  wipByMatter,
  wipRows,
  type BillingWipResult,
  type WipMatterLike,
} from '@materia/domain';

import { defineCallable, type CallableDefinition } from '../core/callable';

type Data = Record<string, unknown>;

/** Matters read per `getAll`. */
const MATTER_BATCH = 300;

/**
 * `billing-wip` (BILL-03; `billing.view`): the WIP tab, aggregated on the server. Reads the org's
 * final, billable time (a projection of four fields, up to BILLING_WIP_MAX_ENTRIES) and sums it per
 * matter (`wipByMatter`), adds matters with only unbilled disbursements (BILL-04's
 * `disbursementWipCents`), then reads each matter for its number, fee, budget (BILL-05) and last
 * invoice (BILL-07). Deleted matters are left out, and privileged ones for roles without
 * privileged.view. INS-01's rollups replace the scan when they land.
 */
export const wipDefinition = {
  name: 'billing-wip',
  input: BillingWipInput,
  roles: PERMISSIONS['billing.view'],
  handler: async ({ orgId, role, db, clock, log }): Promise<BillingWipResult> => {
    const [org, entrySnap, disbursementSnap] = await Promise.all([
      db.doc(`orgs/${orgId}`).get(),
      db
        .collectionGroup('timeEntries')
        .where('orgId', '==', orgId)
        .where('status', '==', 'final')
        .where('billable', '==', true)
        .select('matterId', 'date', 'amountCents', 'invoiceId')
        .limit(BILLING_WIP_MAX_ENTRIES)
        .get(),
      db.collection(`orgs/${orgId}/matters`).where('disbursementWipCents', '>', 0).select().get(),
    ]);
    const wip = wipByMatter(
      entrySnap.docs.map((doc) => ({
        matterId: String(doc.get('matterId')),
        date: String(doc.get('date')),
        amountCents: Number(doc.get('amountCents')),
        invoiceId: doc.get('invoiceId') as string | undefined,
        billable: true,
        status: 'final',
      })),
    );
    const ids = [...new Set([...wip.map((row) => row.matterId), ...disbursementSnap.docs.map((doc) => doc.id)])];
    const matters = new Map<string, WipMatterLike>();
    for (let i = 0; i < ids.length; i += MATTER_BATCH) {
      const refs = ids.slice(i, i + MATTER_BATCH).map((id) => db.doc(`orgs/${orgId}/matters/${id}`));
      for (const snap of await db.getAll(...refs)) {
        const data = snap.data() as Data | undefined;
        if (!data) continue;
        if (data['privileged'] === true && !can(role, 'privileged.view')) continue;
        matters.set(snap.id, data as unknown as WipMatterLike);
      }
    }
    const timeZone = typeof org.get('timezone') === 'string' ? (org.get('timezone') as string) : undefined;
    const rows = wipRows(wip, matters, today(timeZone, clock.now()));
    const totalCents = cents(rows.reduce((sum, row) => sum + row.totalCents, 0));
    const truncated = entrySnap.size >= BILLING_WIP_MAX_ENTRIES;
    log.info('wip read', { matters: rows.length, entries: entrySnap.size, truncated });
    return { rows, totalCents, truncated };
  },
} satisfies CallableDefinition<typeof BillingWipInput, BillingWipResult>;

export const wip = defineCallable(wipDefinition);
