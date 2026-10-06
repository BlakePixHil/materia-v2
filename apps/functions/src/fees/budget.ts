import { AggregateField, type Firestore, type Query, type Transaction } from 'firebase-admin/firestore';

import {
  budgetAlertPcts,
  MatterBudgetSchema,
  planBudget,
  sameBudget,
  type BudgetSums,
  type MatterBudget,
} from '@materia/domain';

import { isDeleted } from '../contacts/shared';
import { isEnabled } from '../core/flags';
import type { Log } from '../core/log';
import { matterPath } from '../matters/shared';
import { notify } from '../notifications/notify';
import type { Clock, Ports } from '../ports';

type Data = Record<string, unknown>;

export interface BudgetDeps {
  db: Firestore;
  orgId: string;
  clock: Clock;
  log: Log;
  ports: Pick<Ports, 'tasks'>;
}

export interface BudgetOutcome {
  budget: MatterBudget;
  /** Whether `matter.budget` was written (false when it already held these figures). */
  written: boolean;
  /** Thresholds alerted now. */
  fired: number[];
  /** Notifications written for them. */
  notified: string[];
}

/** A sum over a query, inside the transaction (an aggregation: one read per 1,000 documents). */
async function sumOf(tx: Transaction, query: Query, field: string): Promise<number> {
  const snap = await tx.get(query.aggregate({ total: AggregateField.sum(field) }));
  const total = snap.data().total;
  return typeof total === 'number' && Number.isFinite(total) ? Math.round(total) : 0;
}

/**
 * The live totals of a collection: everything, less soft-deleted documents (a live document may
 * lack `deletedAt`, so `== null` would miss it), and what is billed.
 */
async function totals(tx: Transaction, query: Query, field: string): Promise<{ live: number; billed: number }> {
  const [all, deleted, billed] = await Promise.all([
    sumOf(tx, query, field),
    sumOf(tx, query.where('deletedAt', '!=', null), field),
    sumOf(tx, query.where('status', '==', 'billed'), field),
  ]);
  return { live: all - deleted, billed };
}

/**
 * What the budget is built from: live time at its rate and live disbursements ex GST (BILL-04's
 * schema). Billed is what is billed, less the credit notes (ex GST) against the matter's invoices
 * (BILL-07); a credit note on a voided invoice can't exist, since only uncredited invoices are voided.
 */
export async function budgetSums(tx: Transaction, db: Firestore, path: string): Promise<BudgetSums> {
  const [orgPath, matterId] = path.split('/matters/') as [string, string];
  const [time, disbursements, credited] = await Promise.all([
    totals(tx, db.collection(`${path}/timeEntries`), 'amountCents'),
    totals(tx, db.collection(`${path}/disbursements`), 'amountExGstCents'),
    sumOf(tx, db.collection(`${orgPath}/creditNotes`).where('matterId', '==', matterId), 'subtotalCents'),
  ]);
  return {
    timeCents: time.live,
    disbursementsCents: disbursements.live,
    billedCents: Math.max(0, time.billed + disbursements.billed - credited),
  };
}

const BASIS_WORD = { fixed: 'fixed fee', capped: 'cap', hourly: 'estimate', conditional: 'estimate' } as const;

/** The people a budget alert goes to: the responsible lawyer and their supervisor. */
async function alertRecipients(tx: Transaction, db: Firestore, orgId: string, matter: Data): Promise<string[]> {
  const responsible = matter['responsibleUid'];
  if (typeof responsible !== 'string' || !responsible) return [];
  const member = await tx.get(db.doc(`orgs/${orgId}/members/${responsible}`));
  const supervisor = member.get('supervisorUid');
  return typeof supervisor === 'string' && supervisor && supervisor !== responsible
    ? [responsible, supervisor]
    : [responsible];
}

/**
 * Recomputes a matter's `budget` (BILL-05) from its time entries and disbursements, and alerts the
 * responsible lawyer and their supervisor at each threshold the recorded value newly reaches. One
 * transaction holds the sums, the matter and the alert markers, so concurrent writes converge and
 * each threshold is alerted once per fee revision. Alerts need `billing.feeBudgets`; the budget
 * itself is kept regardless, so turning the flag on finds it ready. A deleted matter is left alone.
 */
export async function recomputeBudget(deps: BudgetDeps, matterId: string): Promise<BudgetOutcome | null> {
  const { db, orgId, log } = deps;
  const ref = db.doc(matterPath(orgId, matterId));
  const [org, alertsOn] = await Promise.all([
    db.doc(`orgs/${orgId}`).get(),
    isEnabled({ orgId, db, clock: deps.clock }, 'billing.feeBudgets'),
  ]);
  const pcts = budgetAlertPcts(org.data() as { billing?: { budgetAlertPcts?: unknown } } | undefined);

  let dispatch: (() => Promise<void>)[] = [];
  const outcome = await db.runTransaction(async (tx): Promise<BudgetOutcome | null> => {
    dispatch = [];
    const snap = await tx.get(ref);
    const matter = snap.data();
    // A destroyed matter's tombstone (CORE-19) keeps no budget.
    if (!snap.exists || !matter || isDeleted(matter) || matter['destroyedAt']) return null;
    const sums = await budgetSums(tx, db, ref.path);
    const fee = (matter['fee'] ?? null) as Parameters<typeof planBudget>[0]['fee'];
    const previous = MatterBudgetSchema.safeParse(matter['budget']);
    const { budget, fire } = planBudget({
      fee,
      previous: previous.success ? previous.data : null,
      sums,
      pcts,
      alertsOn,
    });
    const recipients = fire.length ? await alertRecipients(tx, db, orgId, matter) : [];
    const written = !sameBudget(previous.success ? previous.data : null, budget);
    if (written) tx.update(ref, { budget });

    const notified: string[] = [];
    const number = typeof matter['number'] === 'string' ? matter['number'] : 'A matter';
    const basis = fee && fee.arrangement !== 'pro_bono' ? BASIS_WORD[fee.arrangement] : 'estimate';
    for (const pct of fire) {
      const result = await notify(
        deps,
        {
          kind: 'budget_alert',
          matterId,
          recipients,
          title: `Budget ${pct}% used: ${number}`,
          body: `${number} has reached ${pct}% of its ${basis} (${budget.pct ?? pct}% recorded). Suggested: revise the estimate and update the costs disclosure.`,
          link: `/matters/${matterId}/overview`,
          key: `budget-${matterId}-r${budget.revision ?? 0}-${pct}`,
        },
        { tx },
      );
      notified.push(...result.ids);
      dispatch.push(result.dispatch);
    }
    return { budget, written, fired: fire, notified };
  });
  for (const send of dispatch) await send();
  if (outcome) {
    log.info('budget recomputed', {
      matterId,
      pct: outcome.budget.pct ?? null,
      written: outcome.written,
      fired: outcome.fired,
      notified: outcome.notified.length,
    });
  }
  return outcome;
}
