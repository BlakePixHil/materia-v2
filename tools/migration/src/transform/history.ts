import type { MatterRef } from './comments.ts';
import { MIGRATION_ACTOR, migratedMeta, migId, type TransformContext, type TransformedRecord } from './context.ts';
import { instantOr } from './dates.ts';
import { htmlToText } from './html.ts';
import { cleanText } from './values.ts';
import { arr, obj, str } from '../legacy/snapshot.ts';

/**
 * A card's `history[]` → the matter's activity feed (`kind: 'legacy_history'`). The legacy line
 * froze the actor's display name in its HTML (`<strong>Name</strong> moved card`): the tags go,
 * the names stay as text. The actor is the user's uid for their own entries, `migration` for
 * anyone else's.
 */

export const LEGACY_HISTORY_KIND = 'legacy_history';

export function mapHistory(ctx: TransformContext, matter: MatterRef, history: unknown): TransformedRecord[] {
  const records: TransformedRecord[] = [];
  arr(history).forEach((raw, index) => {
    const entry = obj(raw);
    if (!entry) return;
    const action = obj(entry['action']);
    const legacyPath = `${matter.cardPath}#history/${str(entry['id']) || index}`;
    const summary =
      htmlToText(str(action?.['description']) ?? '') || cleanText(action?.['name']) || 'Updated (imported)';
    const at = instantOr(ctx, entry['date'], legacyPath);
    const actor = str(entry['uid']) === ctx.uid ? ctx.uid : MIGRATION_ACTOR;
    const name = cleanText(action?.['name']);
    records.push({
      entity: 'activity',
      path: `orgs/${matter.orgId}/matters/${matter.matterId}/activity/${migId(legacyPath)}`,
      legacyPath,
      data: {
        kind: LEGACY_HISTORY_KIND,
        summary,
        actorUid: actor,
        at,
        refs: name ? { legacyAction: name } : {},
        ...migratedMeta(ctx, { legacyPath, createdAt: at, updatedAt: at, by: actor }),
      },
    });
  });
  return records;
}
