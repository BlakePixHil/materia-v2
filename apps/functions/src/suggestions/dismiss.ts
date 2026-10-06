import {
  can,
  DismissSuggestionInput,
  DomainError,
  isOpenSuggestion,
  PERMISSIONS,
  type DismissSuggestionResult,
} from '@materia/domain';

import { countOutcomes, metricOf, suggestionPath, type Data } from './shared';
import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { requireFlag } from '../core/flags';

/**
 * `suggestions-dismiss` (AI-07; `clerk.use`, idempotent): an open (proposed or stale) suggestion
 * the caller can see becomes `dismissed`, with an optional reason (Clerk's evals read it), in a
 * transaction (a suggestion already resolved is ALREADY_RESOLVED; a privileged one is NOT_FOUND
 * without `privileged.view`). Audited as `suggestion.dismissed` (`via: 'clerk'`, no reason text)
 * and counted in the org's Clerk metrics. Proposals don't re-propose a dismissed suggestion's
 * `dedupeKey` (ADR-037).
 */
export const dismissDefinition = {
  name: 'suggestions-dismiss',
  input: DismissSuggestionInput,
  roles: PERMISSIONS['clerk.use'],
  idempotent: true,
  handler: async (ctx): Promise<DismissSuggestionResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const clock = await orgClock(db, orgId, ctx.clock);
    await requireFlag({ orgId, db, clock }, 'clerk.features.suggestions');
    const ref = db.doc(suggestionPath(orgId, input.matterId, input.suggestionId));
    const now = clock.now();
    const stored = await db.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data() as Data | undefined;
      if (!data || (data['privileged'] === true && !can(role, 'privileged.view'))) {
        throw new DomainError('NOT_FOUND', 'Suggestion not found', { suggestionId: input.suggestionId });
      }
      if (!isOpenSuggestion(data['status'])) {
        throw new DomainError('ALREADY_RESOLVED', 'The suggestion was already resolved', {
          suggestionId: input.suggestionId,
          status: data['status'],
        });
      }
      tx.update(ref, {
        status: 'dismissed',
        resolvedBy: uid,
        resolvedAt: now,
        ...(input.reason ? { dismissReason: input.reason } : {}),
        updatedAt: now,
        updatedBy: uid,
        _requestId: requestId,
      });
      return data;
    });
    await audit(
      { uid, orgId, requestId, db, clock },
      {
        action: 'suggestion.dismissed',
        entity: { path: ref.path },
        summary: `Clerk suggestion ${input.suggestionId} (${String(stored['kind'])}) dismissed on matter ${input.matterId}`,
        data: { via: 'clerk', kind: stored['kind'], matterId: input.matterId, reasoned: !!input.reason },
      },
    );
    await countOutcomes(db, orgId, now, [metricOf(stored, 'dismissed')], log);
    log.info('suggestion dismissed', { matterId: input.matterId, suggestionId: input.suggestionId });
    return { suggestionId: input.suggestionId, status: 'dismissed' };
  },
} satisfies CallableDefinition<typeof DismissSuggestionInput, DismissSuggestionResult>;

export const dismiss = defineCallable(dismissDefinition);
