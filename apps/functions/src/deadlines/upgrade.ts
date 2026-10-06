import { FieldPath, FieldValue, type Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { RULE_SET_FOR_JURISDICTION, type RuleSet } from '@materia/deadlines';
import { PERMISSIONS, ProposeRulesetUpgradeInput, type ProposeRulesetUpgradeResult, type Role } from '@materia/domain';

import { recomputeMatter } from './recompute';
import { CLOSED_STATUSES, currentRuleSet } from './shared';
import { audit } from '../audit/audit';
import { REGION } from '../config';
import { isDeleted } from '../contacts/shared';
import { adminDb } from '../core/admin';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { createLog, type Log } from '../core/log';
import { mattersPath } from '../matters/shared';
import type { Clock, Ports } from '../ports';
import { ports as container, systemClock } from '../ports/container';

/** Who runs one page of an upgrade, and where it starts. */
export interface UpgradePageRequest {
  orgId: string;
  uid: string;
  role: Role;
  requestId: string;
  cursor?: string | undefined;
  limit: number;
  /** The org's clock (`orgClock`). */
  clock: Clock;
  ports: Pick<Ports, 'tasks'>;
  log: Log;
}

/**
 * One page of the backfill after a rule set version is published (CORE-10): recomputes the org's
 * live, open matters (by id, from `cursor`) against the latest published rule set with cause
 * `ruleset_upgrade`: unchanged dates take the new provenance, new rules create deadlines, and
 * changed or removed upcoming deadlines become proposals for the responsible lawyer, never silent
 * changes. A matter that fails is logged and listed in `failed`; the rest carry on. Re-running a
 * page is safe (a recompute with nothing new writes nothing). Audited once per page as
 * `deadline.ruleset_upgrade_proposed` on `auditPath`.
 */
export async function upgradeMattersPage(
  db: Firestore,
  request: UpgradePageRequest,
  auditPath: string,
): Promise<ProposeRulesetUpgradeResult> {
  const { orgId, uid, role, requestId, clock, log } = request;
  let query = db.collection(mattersPath(orgId)).orderBy(FieldPath.documentId()).limit(request.limit);
  if (request.cursor) query = query.startAfter(request.cursor);
  const page = await query.get();

  const result: ProposeRulesetUpgradeResult = { processed: 0, upgraded: 0, proposed: 0, created: 0, failed: [] };
  for (const matter of page.docs) {
    const data = matter.data();
    if (isDeleted(data) || CLOSED_STATUSES.has(data['status'])) continue;
    try {
      const outcome = await recomputeMatter(db, {
        orgId,
        matterId: matter.id,
        uid,
        role,
        requestId,
        cause: 'ruleset_upgrade',
        clock,
        ports: request.ports,
        log,
      });
      result.processed += 1;
      if (outcome.updated.length || outcome.created.length || outcome.proposed.length) result.upgraded += 1;
      result.proposed += outcome.proposed.length;
      result.created += outcome.created.length;
    } catch (error) {
      result.failed.push(matter.id);
      log.error('ruleset upgrade failed for a matter', {
        matterId: matter.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  const last = page.docs[page.docs.length - 1];
  if (page.size === request.limit && last) result.nextCursor = last.id;

  await audit(
    { uid, orgId, requestId, db, clock },
    {
      action: 'deadline.ruleset_upgrade_proposed',
      entity: { path: auditPath },
      summary: `Rule set upgrade: ${result.processed} matters recomputed, ${result.proposed} proposals`,
      data: {
        processed: result.processed,
        upgraded: result.upgraded,
        proposed: result.proposed,
        created: result.created,
        failed: result.failed.length,
        ...(request.cursor ? { cursor: request.cursor } : {}),
      },
    },
  );
  log.info('ruleset upgrade page', { ...result, failed: result.failed.length });
  return result;
}

/**
 * `deadlines-proposeRulesetUpgrade` (CORE-10; org.settings, idempotent): one page of the upgrade
 * (`upgradeMattersPage`), by hand. Run it again with `nextCursor` until absent. `deadlines-
 * upgradeRuleSets` runs the same pages on its own once a new version is published.
 */
export const proposeRulesetUpgradeDefinition = {
  name: 'deadlines-proposeRulesetUpgrade',
  input: ProposeRulesetUpgradeInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  handler: async (ctx): Promise<ProposeRulesetUpgradeResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const clock = await orgClock(db, orgId, ctx.clock);
    // No document stands for a run by hand; the request id names it.
    return upgradeMattersPage(
      db,
      { orgId, uid, role, requestId, cursor: input.cursor, limit: input.limit, clock, ports: ctx.ports, log },
      `orgs/${orgId}/ruleSetUpgrades/${requestId}`,
    );
  },
} satisfies CallableDefinition<typeof ProposeRulesetUpgradeInput, ProposeRulesetUpgradeResult>;

export const proposeRulesetUpgrade = defineCallable(proposeRulesetUpgradeDefinition);

// ---------- the automatic upgrade ----------

/**
 * The record of an org's upgrade to one rule set version (server-only): `running` with the
 * `cursor` to carry on from, then `done` with the totals. Its existence as `done` is what makes
 * the upgrade happen once.
 */
export const ruleSetUpgradePath = (orgId: string, ruleSetId: string, version: number) =>
  `orgs/${orgId}/ruleSetUpgrades/${ruleSetId}-v${version}`;

const UPGRADE_PAGE = 200;
/** The most failed matter ids an upgrade record lists (the log has them all). */
const FAILED_IDS_MAX = 100;
/** Stop starting pages after this long, leaving room before the 540 s timeout. */
export const UPGRADE_TIME_BUDGET_MS = 420_000;

export interface OrgUpgradeOutcome {
  ruleSetId: string;
  version: number;
  /**
   * `current`: nothing of the org's was computed by an older version; `done`: upgraded now;
   * `partial`: out of time, carried on next run; `skipped`: done before.
   */
  status: 'current' | 'done' | 'partial' | 'skipped';
  processed: number;
  proposed: number;
}

export interface UpgradeDeps {
  clock: Clock;
  log: Log;
  ports: Pick<Ports, 'tasks'>;
  /** False once the run should start no more pages. */
  timeLeft: () => boolean;
  /** Matters per page (default 200). */
  pageSize?: number;
}

interface UpgradeRecord {
  status?: 'running' | 'done';
  cursor?: string;
  processed?: number;
  upgraded?: number;
  proposed?: number;
  created?: number;
  failed?: string[];
}

/**
 * Upgrades one org to the latest published version of each rule set (CORE-10), the way
 * `deadlines-proposeRulesetUpgrade` does by hand, as `system` (with an owner's view, so privileged
 * matters are included). For each version: nothing when its record (`ruleSetUpgradePath`) is
 * `done`; marked `done` at once when none of the org's deadlines was computed by an older version
 * of the set; otherwise page after page from the record's `cursor`, saving it after each, until the
 * last page (`done`, with the totals and any failed matters, which raise an ops alert; an admin can
 * re-run those by hand) or until `timeLeft()` says stop (`partial`: the next run carries on).
 */
export async function upgradeOrgRuleSets(
  db: Firestore,
  orgId: string,
  ruleSets: readonly RuleSet[],
  deps: UpgradeDeps,
): Promise<OrgUpgradeOutcome[]> {
  const clock = await orgClock(db, orgId, deps.clock);
  const log = deps.log.child({ orgId });
  const outcomes: OrgUpgradeOutcome[] = [];
  for (const ruleSet of ruleSets) {
    const { ruleSetId, version } = ruleSet;
    const ref = db.doc(ruleSetUpgradePath(orgId, ruleSetId, version));
    const record = ((await ref.get()).data() ?? {}) as UpgradeRecord;
    const outcome: OrgUpgradeOutcome = { ruleSetId, version, status: 'skipped', processed: 0, proposed: 0 };
    outcomes.push(outcome);
    if (record.status === 'done') continue;
    const stamp = () => ({ updatedAt: clock.now(), updatedBy: 'system' });

    if (record.status === undefined) {
      const older = await db
        .collectionGroup('deadlines')
        .where('orgId', '==', orgId)
        .where('computed.ruleSetId', '==', ruleSetId)
        .where('computed.ruleSetVersion', '<', version)
        .limit(1)
        .get();
      const base = { ruleSetId, version, processed: 0, upgraded: 0, proposed: 0, created: 0, failed: [] };
      const created = { createdAt: clock.now(), createdBy: 'system', ...stamp(), schemaVersion: 1 };
      if (older.empty) {
        await ref.set({ ...base, status: 'done', current: true, ...created });
        outcome.status = 'current';
        continue;
      }
      await ref.set({ ...base, status: 'running', ...created });
    }

    const totals = {
      processed: record.processed ?? 0,
      upgraded: record.upgraded ?? 0,
      proposed: record.proposed ?? 0,
      created: record.created ?? 0,
      failed: record.failed ?? [],
    };
    let cursor = record.cursor;
    outcome.status = 'partial';
    while (deps.timeLeft()) {
      const page = await upgradeMattersPage(
        db,
        {
          orgId,
          uid: 'system',
          role: 'owner',
          requestId: `ruleset-upgrade-${ruleSetId}-v${version}`,
          cursor,
          limit: deps.pageSize ?? UPGRADE_PAGE,
          clock,
          ports: deps.ports,
          log,
        },
        ref.path,
      );
      totals.processed += page.processed;
      totals.upgraded += page.upgraded;
      totals.proposed += page.proposed;
      totals.created += page.created;
      totals.failed = [...totals.failed, ...page.failed].slice(0, FAILED_IDS_MAX);
      outcome.processed += page.processed;
      outcome.proposed += page.proposed;
      cursor = page.nextCursor;
      if (!cursor) {
        await ref.update({
          ...totals,
          status: 'done',
          cursor: FieldValue.delete(),
          finishedAt: clock.now(),
          ...stamp(),
        });
        outcome.status = 'done';
        if (totals.failed.length) {
          log.error('ops alert: rule set upgrade left matters out', {
            alert: 'ruleset_upgrade_failed',
            ruleSetId,
            version,
            failed: totals.failed.length,
          });
        }
        break;
      }
      await ref.update({ ...totals, cursor, ...stamp() });
    }
    if (outcome.status === 'partial') log.info('ruleset upgrade continues next run', { ruleSetId, version });
  }
  return outcomes;
}

/** The latest published version of every jurisdiction's rule set. */
export async function currentRuleSets(db: Firestore, log: Log): Promise<RuleSet[]> {
  const ids = [...new Set(Object.values(RULE_SET_FOR_JURISDICTION))].filter((id): id is string => !!id);
  const sets = await Promise.all(ids.map((id) => currentRuleSet(db, id, log)));
  return sets.filter((set): set is RuleSet => !!set);
}

/** `upgradeOrgRuleSets` for every live org, until the time budget runs out; one org's failure doesn't stop the rest. */
export async function upgradeAllOrgs(
  db: Firestore,
  deps: UpgradeDeps,
): Promise<{ orgs: number; upgraded: number; pending: number; failed: number }> {
  const ruleSets = await currentRuleSets(db, deps.log);
  const summary = { orgs: 0, upgraded: 0, pending: 0, failed: 0 };
  if (!ruleSets.length) return summary;
  const orgs = await db.collection('orgs').get();
  for (const org of orgs.docs) {
    if (isDeleted(org.data())) continue;
    summary.orgs += 1;
    try {
      const outcomes = await upgradeOrgRuleSets(db, org.id, ruleSets, deps);
      if (outcomes.some((o) => o.status === 'done')) summary.upgraded += 1;
      if (outcomes.some((o) => o.status === 'partial')) summary.pending += 1;
    } catch (error) {
      summary.failed += 1;
      deps.log.error('ruleset upgrade failed', {
        orgId: org.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return summary;
}

/**
 * `deadlines-upgradeRuleSets` (CORE-10): hourly, so a newly published rule set version reaches every
 * org's matters as proposals within hours, without anyone running `deadlines-proposeRulesetUpgrade`.
 * Cheap when there is nothing to do (one record read per org and rule set); a large backlog carries
 * on from its cursor in the next run.
 */
export const upgradeRuleSets = onSchedule(
  {
    schedule: 'every 60 minutes',
    timeZone: 'Australia/Melbourne',
    region: REGION,
    retryCount: 0,
    timeoutSeconds: 540,
  },
  async () => {
    const log = createLog({ fn: 'deadlines-upgradeRuleSets' });
    const stopAt = Date.now() + UPGRADE_TIME_BUDGET_MS;
    const timeLeft = () => Date.now() < stopAt;
    log.info('ok', await upgradeAllOrgs(adminDb(), { clock: systemClock, log, ports: container(), timeLeft }));
  },
);
