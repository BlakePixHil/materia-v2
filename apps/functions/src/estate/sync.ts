import type { Firestore } from 'firebase-admin/firestore';

import { RULE_SET_FOR_JURISDICTION, ruleSetReadsFacts } from '@materia/deadlines';
import {
  assetValueChanged,
  distributionDependsOn,
  estateTotals,
  sameEstateTotals,
  type AssetValues,
  type DistributionValues,
  type EstateTotals,
  type LiabilityValues,
} from '@materia/domain';

import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';
import { recomputeMatter } from '../deadlines/recompute';
import { currentRuleSet } from '../deadlines/shared';
import { matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

/** The matter facts the estate register keeps (a rule set reading them is recomputed on change). */
export const ESTATE_VALUE_FACTS = ['estate.grossValueCents', 'estate.netValueCents'] as const;

/** Firestore batches hold 500 writes. */
const BATCH = 400;

export interface EstateSyncOutcome {
  /** The totals were rewritten (they changed). */
  synced: boolean;
  totals: EstateTotals | null;
  /** Gross or net estate value changed. */
  valueChanged: boolean;
  /** The matter's deadlines were recomputed (its rule set reads the estate values). */
  recomputed: boolean;
  /** Distributions flagged for review. */
  flagged: string[];
}

/**
 * Brings `matter.estateRegister` and `estate.grossValueCents`/`netValueCents` in line with the live
 * assets and liabilities (CORE-16), in one transaction that reads them all again, so concurrent and
 * out-of-order events converge on the exact totals. Writes nothing when they already agree.
 */
export async function syncEstateTotals(
  db: Firestore,
  orgId: string,
  matterId: string,
  at: Date,
): Promise<{ totals: EstateTotals; before: Data | undefined; synced: boolean } | null> {
  const matterRef = db.doc(matterPath(orgId, matterId));
  return db.runTransaction(async (tx) => {
    const matter = await tx.get(matterRef);
    // A destroyed matter's tombstone (CORE-19) keeps no estate totals.
    if (!matter.exists || matter.get('destroyedAt')) return null;
    const [assets, liabilities] = await Promise.all([
      tx.get(db.collection(`${matterRef.path}/assets`)),
      tx.get(db.collection(`${matterRef.path}/liabilities`)),
    ]);
    const totals = estateTotals(
      assets.docs.map((doc) => doc.data() as AssetValues),
      liabilities.docs.map((doc) => doc.data() as LiabilityValues),
    );
    const data = matter.data() as Data;
    const stored = data['estateRegister'] as Partial<EstateTotals> | undefined;
    const estate = (data['estate'] as Data | undefined) ?? {};
    const synced =
      !sameEstateTotals(stored, totals) ||
      estate['grossValueCents'] !== totals.grossCents ||
      estate['netValueCents'] !== totals.netCents;
    if (synced) {
      tx.update(matterRef, {
        estateRegister: { ...totals, updatedAt: at },
        'estate.grossValueCents': totals.grossCents,
        'estate.netValueCents': totals.netCents,
      });
    }
    return { totals, before: data, synced };
  });
}

/**
 * Flags the live distributions that depend on an asset whose worth just changed: residuary gifts,
 * and specific gifts of that asset without a fixed amount, recorded before the change.
 */
export async function flagDistributions(
  db: Firestore,
  orgId: string,
  matterId: string,
  assetId: string,
  at: Date,
): Promise<string[]> {
  const snap = await db.collection(`${matterPath(orgId, matterId)}/distributions`).get();
  const flagged = snap.docs.filter((doc) => {
    const data = doc.data() as DistributionValues & {
      needsValueReview?: boolean;
      createdAt?: Date | { toDate(): Date };
    };
    const recorded = data.createdAt instanceof Date ? data.createdAt : data.createdAt?.toDate?.();
    return !data.needsValueReview && distributionDependsOn(data, assetId) && (!recorded || recorded < at);
  });
  for (let start = 0; start < flagged.length; start += BATCH) {
    const batch = db.batch();
    for (const doc of flagged.slice(start, start + BATCH))
      batch.update(doc.ref, { needsValueReview: true, updatedAt: at, updatedBy: 'system' });
    await batch.commit();
  }
  return flagged.map((doc) => doc.id);
}

/** Whether the matter's rule set reads the estate values (no recompute otherwise). */
async function ruleSetReadsEstateValues(db: Firestore, matter: Data, ctx: TriggerContext): Promise<boolean> {
  const jurisdiction = matter['jurisdiction'] as keyof typeof RULE_SET_FOR_JURISDICTION | undefined;
  const ruleSetId = jurisdiction ? RULE_SET_FOR_JURISDICTION[jurisdiction] : undefined;
  const ruleSet = ruleSetId ? await currentRuleSet(db, ruleSetId, ctx.log) : undefined;
  return !!ruleSet && ruleSetReadsFacts(ruleSet, ESTATE_VALUE_FACTS);
}

/**
 * When the gross or net estate value changes (CORE-16): recomputes the matter's deadlines if its
 * rule set has estate-value conditions (CORE-10; none in vic-v1 yet).
 *
 * BILL-05 hook: fee arrangements and costs estimates arrive with BILL-05, which notifies the
 * responsible lawyer here when an estimate depends on the estate value. Until then no estimate does.
 */
export async function estateValueChanged(matter: Data, ctx: TriggerContext): Promise<boolean> {
  const orgId = ctx.params['orgId'] as string;
  const matterId = ctx.params['matterId'] as string;
  if (matter['deletedAt'] || matter['status'] === 'closed' || matter['status'] === 'archived') return false;
  if (!(await ruleSetReadsEstateValues(ctx.db, matter, ctx))) return false;
  await recomputeMatter(ctx.db, {
    orgId,
    matterId,
    uid: 'system',
    role: 'owner',
    cause: 'recompute',
    ports: ctx.ports,
    clock: ctx.clock,
    log: ctx.log,
  });
  return true;
}

/**
 * `estate-onWrite` and `estate-onLiabilityWrite` (CORE-16), on every write of a matter's assets or
 * liabilities: keep the matter's estate totals (`syncEstateTotals`); on an asset whose worth
 * changed, flag the distributions that depend on it for review; and when the gross or net value
 * moved, run the estate-value hooks (`estateValueChanged`).
 */
export async function syncEstate(
  change: TriggerChange,
  ctx: TriggerContext,
  kind: 'asset' | 'liability',
): Promise<EstateSyncOutcome> {
  const orgId = ctx.params['orgId'] as string;
  const matterId = ctx.params['matterId'] as string;
  const synced = await syncEstateTotals(ctx.db, orgId, matterId, ctx.time);
  if (!synced) {
    ctx.log.info('estate sync skipped: no matter, or a destroyed one', { matterId });
    return { synced: false, totals: null, valueChanged: false, recomputed: false, flagged: [] };
  }
  let flagged: string[] = [];
  if (kind === 'asset') {
    const before = change.before?.data() as AssetValues | undefined;
    const after = change.after?.data() as AssetValues | undefined;
    const assetId = ctx.params['assetId'];
    if (assetId && assetValueChanged(before, after))
      flagged = await flagDistributions(ctx.db, orgId, matterId, assetId, ctx.time);
  }
  const estate = (synced.before?.['estate'] as Data | undefined) ?? {};
  const valueChanged =
    estate['grossValueCents'] !== synced.totals.grossCents || estate['netValueCents'] !== synced.totals.netCents;
  const recomputed = valueChanged && synced.before ? await estateValueChanged(synced.before, ctx) : false;
  const outcome = { synced: synced.synced, totals: synced.totals, valueChanged, recomputed, flagged };
  ctx.log.info('estate synced', {
    matterId,
    kind,
    synced: outcome.synced,
    valueChanged,
    recomputed,
    flagged: flagged.length,
  });
  return outcome;
}

export const onWriteDefinition: TriggerDefinition = {
  name: 'estate-onWrite',
  document: 'orgs/{orgId}/matters/{matterId}/assets/{assetId}',
  on: 'written',
  handler: async (change, ctx) => void (await syncEstate(change, ctx, 'asset')),
};

export const onLiabilityWriteDefinition: TriggerDefinition = {
  name: 'estate-onLiabilityWrite',
  document: 'orgs/{orgId}/matters/{matterId}/liabilities/{liabilityId}',
  on: 'written',
  handler: async (change, ctx) => void (await syncEstate(change, ctx, 'liability')),
};

export const onWrite = defineTrigger(onWriteDefinition);
export const onLiabilityWrite = defineTrigger(onLiabilityWriteDefinition);
