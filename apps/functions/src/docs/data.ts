import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';

import {
  buildMergeData,
  DEFAULT_ORG_TIMEZONE,
  dateOnlyAt,
  letterheadPath,
  LetterheadDetailsSchema,
  PartyRoleSchema,
  today as todayIn,
  type GenerateData,
  type MergeMember,
  type MergeSources,
} from '@materia/domain';

import { isDeleted } from '../contacts/shared';
import { matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const toDate = (value: unknown): Date | undefined =>
  value instanceof Date
    ? value
    : value && typeof (value as { toDate?: unknown }).toDate === 'function'
      ? (value as { toDate: () => Date }).toDate()
      : undefined;

/** A member as the merge sees them: name, title, email and default rate (none for someone who left). */
function memberOf(snap: DocumentSnapshot | undefined): MergeMember | undefined {
  const data = snap?.data();
  if (!data || data['status'] !== 'active') return undefined;
  const name = str(data['displayName']);
  if (!name) return undefined;
  return {
    displayName: name,
    ...(str(data['title']) ? { title: String(data['title']) } : {}),
    ...(str(data['email']) ? { email: String(data['email']) } : {}),
    ...(num(data['defaultRateCents']) !== undefined ? { defaultRateCents: Number(data['defaultRateCents']) } : {}),
  };
}

/**
 * Reads everything a matter's merge data needs (INT-06): the org and its letterhead details, the
 * clients, deceased, will-maker and live parties with their contacts, the responsible lawyer and the
 * author (active members only). `matter` is the matter's data, already checked by the caller.
 */
export async function loadMergeSources(
  db: Firestore,
  input: { orgId: string; matterId: string; matter: Data; uid: string; now: Date },
): Promise<MergeSources> {
  const { orgId, matterId, matter } = input;
  const [orgSnap, letterheadSnap, partiesSnap] = await Promise.all([
    db.doc(`orgs/${orgId}`).get(),
    db.doc(letterheadPath(orgId)).get(),
    db.collection(`${matterPath(orgId, matterId)}/parties`).get(),
  ]);
  const org = orgSnap.data() ?? {};
  const timeZone = str(org['timezone']) ?? DEFAULT_ORG_TIMEZONE;
  // In the order they were added, so "{#executors}" lists the first executor first.
  const parties = partiesSnap.docs
    .map((snap) => ({ id: snap.id, data: snap.data() }))
    .filter(({ data }) => !isDeleted(data) && PartyRoleSchema.safeParse(data['role']).success)
    .sort(
      (a, b) =>
        (toDate(a.data['createdAt'])?.getTime() ?? 0) - (toDate(b.data['createdAt'])?.getTime() ?? 0) ||
        a.id.localeCompare(b.id),
    )
    .map(({ data }) => ({
      contactId: String(data['contactId']),
      role: PartyRoleSchema.parse(data['role']),
      ...(str(data['share']) ? { share: String(data['share']) } : {}),
    }));

  const deceased = matter['deceased'] as Data | undefined;
  const testator = matter['testator'] as Data | undefined;
  const clientIds = Array.isArray(matter['clientContactIds']) ? (matter['clientContactIds'] as string[]) : [];
  const contactIds = [
    ...new Set(
      [
        ...clientIds,
        str(deceased?.['contactId']),
        str(testator?.['contactId']),
        ...parties.map((p) => p.contactId),
      ].filter((id): id is string => !!id),
    ),
  ];
  const responsibleUid = str(matter['responsibleUid']);
  const [contactSnaps, memberSnaps] = await Promise.all([
    contactIds.length ? db.getAll(...contactIds.map((id) => db.doc(`orgs/${orgId}/contacts/${id}`))) : [],
    db.getAll(...[responsibleUid ?? input.uid, input.uid].map((uid) => db.doc(`orgs/${orgId}/members/${uid}`))),
  ]);
  const contacts = Object.fromEntries(
    contactSnaps
      .filter((snap) => snap.exists && !isDeleted(snap.data() ?? {}))
      .map((snap) => [snap.id, snap.data() ?? {}]),
  );
  const letterhead = LetterheadDetailsSchema.partial().safeParse(
    Object.fromEntries(
      Object.entries(letterheadSnap.data() ?? {}).filter(([key]) => key in LetterheadDetailsSchema.shape),
    ),
  );
  const created = toDate(matter['createdAt']);
  const fee = (matter['fee'] ?? {}) as Data;
  const estate = (matter['estate'] ?? {}) as Data;
  const facts = (matter['facts'] ?? {}) as Data;
  const lawyer = responsibleUid ? memberOf(memberSnaps[0]) : undefined;
  const author = memberOf(memberSnaps[1]);
  return {
    org: { name: str(org['name']) ?? '', ...(str(org['abn']) ? { abn: String(org['abn']) } : {}) },
    ...(letterhead.success ? { letterhead: letterhead.data } : {}),
    matter: {
      number: String(matter['number'] ?? ''),
      title: String(matter['title'] ?? ''),
      type: matter['type'] as MergeSources['matter']['type'],
      jurisdiction: String(matter['jurisdiction'] ?? ''),
      ...(created ? { openedOn: dateOnlyAt(created, timeZone) } : {}),
      ...(str(matter['externalRef']) ? { externalRef: String(matter['externalRef']) } : {}),
      clientContactIds: clientIds,
      ...(deceased && str(deceased['contactId'])
        ? {
            deceased: {
              contactId: String(deceased['contactId']),
              ...(str(deceased['dateOfDeath']) ? { dateOfDeath: String(deceased['dateOfDeath']) } : {}),
              ...(str(deceased['domicile']) ? { domicile: String(deceased['domicile']) } : {}),
              ...(str(deceased['lastAddress']) ? { lastAddress: String(deceased['lastAddress']) } : {}),
            },
          }
        : {}),
      ...(testator && str(testator['contactId']) ? { testator: { contactId: String(testator['contactId']) } } : {}),
      fee: {
        ...(str(fee['arrangement']) ? { arrangement: String(fee['arrangement']) } : {}),
        ...centsOf(fee, [
          'amountCents',
          'capCents',
          'estimateCents',
          'estimateLowCents',
          'estimateHighCents',
          'rateOverrideCents',
        ]),
      },
      estate: {
        ...centsOf(estate, ['grossValueCents', 'netValueCents']),
        ...(str(estate['grantType']) ? { grantType: String(estate['grantType']) } : {}),
        ...(str(estate['grantDate']) ? { grantDate: String(estate['grantDate']) } : {}),
        ...(str(estate['grantNo']) ? { grantNo: String(estate['grantNo']) } : {}),
      },
      facts: {
        ...(str(facts['willDate']) ? { willDate: String(facts['willDate']) } : {}),
        ...(str(facts['courtFileNo']) ? { courtFileNo: String(facts['courtFileNo']) } : {}),
      },
    },
    contacts,
    parties,
    ...(lawyer ? { lawyer } : {}),
    ...(author ? { author } : {}),
    today: todayIn(timeZone, input.now),
  };
}

function centsOf(data: Data, keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.flatMap((key) => (num(data[key]) !== undefined ? [[key, Number(data[key])]] : [])));
}

/** The merge data for a matter, with what the caller supplied (a body, a recipient) laid over it. */
export function mergeDataFor(sources: MergeSources, supplied: GenerateData | Record<string, unknown> = {}) {
  return { ...buildMergeData(sources), ...supplied };
}
