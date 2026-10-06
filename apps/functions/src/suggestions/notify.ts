import { canAcceptSuggestion, SUGGESTION_KIND_LABELS, type Role } from '@materia/domain';

import type { ProposeResult } from './propose';
import { CLERK_ACTOR, type Data } from './shared';
import { matterPath } from '../matters/shared';
import { notify, type NotifyContext } from '../notifications/notify';

export interface SuggestionNoticeOptions {
  /** Who to tell when the responsible lawyer can't take it (the document's uploader, for ingest). */
  fallbackUid?: string;
}

/**
 * Tells a person about Clerk suggestions made in the background (CORE-22a, AI-07): one `suggestion`
 * notification per batch (one document's classification), so the Inbox's Clerk filter and inline
 * Review have something to show. It goes to the matter's responsible lawyer or, failing that, to
 * `fallbackUid`: the first of them who is an active member able to accept one of the new
 * suggestions (`canAcceptSuggestion`: never a read-only member, and a privileged suggestion needs
 * `privileged.view`). Nobody suitable, nothing is sent. `notify()` then applies their preferences.
 *
 * The notification points at the first suggestion they can accept and counts only those, keyed
 * `suggest-{matterId}-{suggestionId}` so a rerun rewrites it rather than sending another. The title
 * and body name the kinds and the matter number, never the suggestions' content, which may be
 * privileged. Best effort: a failure is logged, never thrown (the suggestions stand either way).
 * Returns the notification ids.
 */
export async function notifyNewSuggestions(
  ctx: NotifyContext,
  matterId: string,
  created: ProposeResult['created'],
  options: SuggestionNoticeOptions = {},
): Promise<string[]> {
  if (!created.length) return [];
  const { db, orgId, log } = ctx;
  try {
    const matter = ((await db.doc(matterPath(orgId, matterId)).get()).data() ?? {}) as Data;
    const candidates = [...new Set([matter['responsibleUid'], options.fallbackUid])].filter(
      (uid): uid is string => typeof uid === 'string' && uid.length > 0,
    );
    for (const uid of candidates) {
      const member = (await db.doc(`orgs/${orgId}/members/${uid}`).get()).data();
      if (member?.['status'] !== 'active') continue;
      const role = member['role'] as Role;
      const reviewable = created.filter((item) => canAcceptSuggestion(role, item.kind, item.privileged));
      const first = reviewable[0];
      if (!first) continue;
      const count = reviewable.length;
      const number = typeof matter['number'] === 'string' && matter['number'] ? matter['number'] : 'a matter';
      const kinds = [...new Set(reviewable.map((item) => SUGGESTION_KIND_LABELS[item.kind]))].join(', ');
      const sent = await notify(ctx, {
        kind: 'suggestion',
        suggestionId: first.id,
        matterId,
        recipients: [uid],
        title: count === 1 ? `Clerk has a suggestion on ${number}` : `Clerk has ${count} suggestions on ${number}`,
        body: `${kinds}: review ${count === 1 ? 'it' : 'them'} before anything changes.`,
        link: `/matters/${matterId}/overview`,
        key: `suggest-${matterId}-${first.id}`,
        actor: CLERK_ACTOR,
      });
      return sent.ids;
    }
    log.info('suggestions not notified', { matterId, suggestions: created.length, reason: 'no_recipient' });
    return [];
  } catch (error) {
    log.warn('suggestion notification failed', {
      matterId,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return [];
  }
}
