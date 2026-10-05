import { FieldPath } from 'firebase-admin/firestore';

import { PERMISSIONS, ProposeRulesetUpgradeInput, type ProposeRulesetUpgradeResult } from '@materia/domain';

import { recomputeMatter } from './recompute';
import { CLOSED_STATUSES } from './shared';
import { audit } from '../audit/audit';
import { isDeleted } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { mattersPath } from '../matters/shared';

/**
 * `deadlines-proposeRulesetUpgrade` (CORE-10; org.settings, idempotent): the backfill after a rule
 * set version is published. Recomputes a page of the org's live, open matters (by id, from
 * `cursor`) against the latest published rule set with cause `ruleset_upgrade`: unchanged dates
 * take the new provenance, new rules create deadlines, and changed or removed upcoming deadlines
 * become proposals for the responsible lawyer, never silent changes. A matter that fails is
 * logged and listed in `failed`; the rest carry on. Run it again with `nextCursor` until absent;
 * re-running a page is safe (a recompute with nothing new writes nothing). Audited once per page
 * as `deadline.ruleset_upgrade_proposed`.
 */
export const proposeRulesetUpgradeDefinition = {
  name: 'deadlines-proposeRulesetUpgrade',
  input: ProposeRulesetUpgradeInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  handler: async (ctx): Promise<ProposeRulesetUpgradeResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const clock = await orgClock(db, orgId, ctx.clock);
    let query = db.collection(mattersPath(orgId)).orderBy(FieldPath.documentId()).limit(input.limit);
    if (input.cursor) query = query.startAfter(input.cursor);
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
    if (page.size === input.limit && last) result.nextCursor = last.id;

    await audit(
      { uid, orgId, requestId, db, clock },
      {
        action: 'deadline.ruleset_upgrade_proposed',
        entity: { path: `orgs/${orgId}` },
        summary: `Rule set upgrade: ${result.processed} matters recomputed, ${result.proposed} proposals`,
        data: {
          processed: result.processed,
          upgraded: result.upgraded,
          proposed: result.proposed,
          created: result.created,
          failed: result.failed.length,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
      },
    );
    log.info('ruleset upgrade page', { ...result, failed: result.failed.length });
    return result;
  },
} satisfies CallableDefinition<typeof ProposeRulesetUpgradeInput, ProposeRulesetUpgradeResult>;

export const proposeRulesetUpgrade = defineCallable(proposeRulesetUpgradeDefinition);
