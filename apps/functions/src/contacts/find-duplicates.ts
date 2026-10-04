import {
  contactDisplayName,
  DUPLICATE_THRESHOLD,
  DuplicateProbeSchema,
  FindDuplicatesInput,
  PERMISSIONS,
  scoreDuplicate,
  type DuplicateCandidate,
  type DuplicateMatch,
  type FindDuplicatesResult,
} from '@materia/domain';

import { contactsPath, isLive } from './shared';
import { defineCallable, type CallableDefinition } from '../core/callable';

/** At most this many matches are offered. */
export const MAX_MATCHES = 5;

/** The fields the scorer and the result read; nothing else is loaded. */
const FIELDS = [
  'kind',
  'givenNames',
  'familyName',
  'preferredName',
  'orgName',
  'abn',
  'dateOfBirth',
  'emails',
  'phones',
  'deletedAt',
  'mergedInto',
] as const;

/** Whether the probe has anything to compare (a name, an ABN, an email or a phone). */
function hasSomething(probe: ReturnType<typeof DuplicateProbeSchema.parse>): boolean {
  const texts = [probe.givenNames, probe.familyName, probe.orgName, probe.abn, ...probe.emails, ...probe.phones];
  return texts.some((text) => !!text?.trim());
}

/**
 * `contacts-findDuplicates` (CORE-01): scores what the create form has typed against the org's
 * live contacts and returns the best matches at or above DUPLICATE_THRESHOLD, best first.
 *
 * It reads every contact in the org with a field mask (the scorer's fields only). That is fine at
 * MVP scale (a practice has hundreds to a few thousand contacts); past that, narrow the candidates
 * first with `dedupeKey` and `search` token queries.
 */
export const findDuplicatesDefinition = {
  name: 'contacts-findDuplicates',
  input: FindDuplicatesInput,
  roles: PERMISSIONS['contact.edit'],
  handler: async ({ input, orgId, db, log }): Promise<FindDuplicatesResult> => {
    if (!hasSomething(input)) return { matches: [] };
    const snapshot = await db
      .collection(contactsPath(orgId))
      .select(...FIELDS)
      .get();
    const matches: DuplicateMatch[] = [];
    for (const doc of snapshot.docs) {
      const data = doc.data() as DuplicateCandidate & Record<string, unknown>;
      if (!isLive(data)) continue;
      const { score, reasons } = scoreDuplicate(input, data);
      if (score < DUPLICATE_THRESHOLD) continue;
      const email = data.emails?.[0]?.address;
      const phone = data.phones?.[0]?.number;
      matches.push({
        contactId: doc.id,
        displayName: contactDisplayName(data),
        score,
        reasons,
        ...(data.dateOfBirth ? { dateOfBirth: data.dateOfBirth } : {}),
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
      });
    }
    matches.sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));
    log.info('duplicates scored', { candidates: snapshot.size, matches: matches.length });
    return { matches: matches.slice(0, MAX_MATCHES) };
  },
} satisfies CallableDefinition<typeof FindDuplicatesInput, FindDuplicatesResult>;

export const findDuplicates = defineCallable(findDuplicatesDefinition);
