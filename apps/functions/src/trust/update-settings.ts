import { PERMISSIONS, TRUST_CALLABLES, UpdateTrustSettingsInput, type TrustSaveResult } from '@materia/domain';

import { trustOrg } from './shared';
import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';

/**
 * `trust-updateSettings` (BILL-11; `org.settings`, idempotent): Settings → Trust account. Whether
 * matters show trust balances, which records they're copied from, and when one is out of date.
 * Turning the display off keeps the snapshots, hidden. Behind `billing.trustDisplay`. Audited.
 */
export const updateSettingsDefinition = {
  name: TRUST_CALLABLES.updateSettings,
  input: UpdateTrustSettingsInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  handler: async ({ input, orgId, uid, db, clock, requestId, log }): Promise<TrustSaveResult> => {
    const org = await trustOrg(db, orgId, clock);
    const next = input.settings;
    const current = org.data['trust'] as Record<string, unknown> | undefined;
    const changed = (['showOnMatters', 'system', 'otherName', 'staleAfterDays'] as const).filter(
      (key) => (current?.[key] ?? undefined) !== (next[key] ?? undefined),
    );
    if (current && !changed.length) return { saved: false };

    const trust = {
      showOnMatters: next.showOnMatters,
      system: next.system,
      ...(next.otherName ? { otherName: next.otherName } : {}),
      staleAfterDays: next.staleAfterDays,
    };
    await db.doc(`orgs/${orgId}`).update({ trust, updatedAt: clock.now(), updatedBy: uid, _requestId: requestId });
    await audit(
      { uid, orgId, requestId, db, clock },
      {
        action: 'trust.settings_updated',
        // As `org.settings_updated`: the audit entity is a document inside the org.
        entity: { path: `orgs/${orgId}/members/${uid}` },
        summary: `Trust settings changed: ${changed.join(', ')}`,
        data: { changed, showOnMatters: next.showOnMatters, system: next.system, staleAfterDays: next.staleAfterDays },
      },
    );
    log.info('trust settings updated', { orgId, changed });
    return { saved: true };
  },
} satisfies CallableDefinition<typeof UpdateTrustSettingsInput, TrustSaveResult>;

export const updateSettings = defineCallable(updateSettingsDefinition);
