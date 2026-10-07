import { buildContact } from './contact.ts';
import type { TransformContext, TransformedRecord } from './context.ts';
import { splitName } from './values.ts';
import { docId } from '../legacy/snapshot.ts';

/**
 * Other legacy users the data names (board members, assignees, comment authors, mention targets)
 * → contacts tagged `legacy-collaborator` (Legacy migration plan, Mapping). They aren't members and
 * are never invited (D-07). Only their names come across (`people.jsonl`, D-17); a user whose
 * profile is gone has no name, so gets no contact (`MIG_W_PERSON_MISSING`). Someone who is also a
 * referrer keeps the one referrer contact, with the tag added.
 */

export const COLLABORATOR_TAG = 'legacy-collaborator';

export interface CollaboratorsResult {
  /** New contacts, plus referrer contacts that gained the tag (replacing those records). */
  records: TransformedRecord[];
  /** Legacy uid → v2 contact id. */
  contactIds: Map<string, string>;
}

export function mapCollaborators(
  ctx: TransformContext,
  uids: readonly string[],
  referrers: readonly TransformedRecord[],
): CollaboratorsResult {
  const records: TransformedRecord[] = [];
  const contactIds = new Map<string, string>();
  const byKey = new Map(referrers.map((record) => [String(record.data?.['dedupeKey'] ?? ''), record]));
  const tagged = new Map<string, TransformedRecord>();
  for (const uid of [...new Set(uids)].sort()) {
    if (uid === ctx.uid) continue;
    const name = ctx.people.get(uid);
    const legacyPath = `profiles/${uid}`;
    if (!name) {
      ctx.warnings.add('MIG_W_PERSON_MISSING', legacyPath);
      continue;
    }
    const contact = buildContact(ctx, {
      legacyPath,
      kind: 'person',
      ...splitName(name),
      tags: [COLLABORATOR_TAG],
      notes: 'Worked on matters in the legacy app (imported). Not a member of this practice.',
      createdAt: ctx.asOf,
      updatedAt: ctx.asOf,
    });
    const referrer = byKey.get(String(contact.data?.['dedupeKey'] ?? ''));
    if (referrer?.data) {
      const merged = tagged.get(referrer.path) ?? referrer;
      const tags = [...new Set([...((merged.data?.['tags'] as string[]) ?? []), COLLABORATOR_TAG])].sort();
      tagged.set(referrer.path, { ...merged, data: { ...merged.data, tags } });
      contactIds.set(uid, docId(referrer.path));
      continue;
    }
    records.push(contact);
    contactIds.set(uid, docId(contact.path));
  }
  return { records: [...records, ...tagged.values()], contactIds };
}
