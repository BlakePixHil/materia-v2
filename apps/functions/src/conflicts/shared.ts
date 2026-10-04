import type { Firestore } from 'firebase-admin/firestore';

import {
  adversePair,
  CONFLICT_HIT_THRESHOLD,
  ConflictCheck,
  ConflictSubjectSchema,
  contactDisplayName,
  MAX_HITS_PER_SUBJECT,
  MatterStatusSchema,
  MatterTypeSchema,
  PartyRoleSchema,
  PRIVILEGED_MATTER_TITLE,
  scoreDuplicate,
  subjectProbe,
  type ConflictHit,
  type ConflictHitMatter,
  type ConflictSubject,
  type DuplicateCandidate,
  type DuplicateReason,
} from '@materia/domain';

import { DUPLICATE_SCAN_FIELDS } from '../contacts/find-duplicates';
import { compact, contactsPath, isDeleted, partyQuery } from '../contacts/shared';
import { matterPath } from '../matters/shared';

/** Shared helpers for the conflict functions (CORE-02). */

export const conflictChecksPath = (orgId: string) => `orgs/${orgId}/conflictChecks`;

type Data = Record<string, unknown>;
type Subject = ReturnType<typeof ConflictSubjectSchema.parse>;

/** How many `mergedInto` hops are followed before a chain is treated as broken. */
const MAX_MERGE_HOPS = 5;

export interface ConflictScanOptions {
  /** The matter being checked: its own party rows are not reported. */
  excludeMatterId?: string | undefined;
  /** Mark adverse roles (the `conflicts.enforced` flag). */
  adverse: boolean;
}

interface Candidate {
  score: number;
  reasons: DuplicateReason[];
  via?: string;
  self?: boolean;
}

/**
 * Scores each subject against every contact in the org (one field-masked read, as
 * `contacts-findDuplicates` does) and reports, for each contact at or above CONFLICT_HIT_THRESHOLD,
 * the matters it is a party on. Soft-deleted contacts are skipped; a hit on a merge tombstone is
 * reported as the contact it was merged into (`viaMergedContactId`). The subject's own `contactId`
 * is reported as `self` (score 1) when it is on other matters. Party rows of every matter count,
 * closed, archived and soft-deleted ones included; removed (soft-deleted) party rows don't.
 * Hits are sorted best first.
 */
export async function findConflictHits(
  db: Firestore,
  orgId: string,
  subjectsInput: readonly ConflictSubject[],
  options: ConflictScanOptions,
): Promise<ConflictHit[]> {
  const subjects: Subject[] = subjectsInput.map((subject) => ConflictSubjectSchema.parse(subject));
  const snapshot = await db
    .collection(contactsPath(orgId))
    .select(...DUPLICATE_SCAN_FIELDS)
    .get();
  const contacts = new Map<string, Data>(snapshot.docs.map((doc) => [doc.id, doc.data()]));

  // Tombstones by the contact they were merged into: their leftover party rows count too.
  const tombstones = new Map<string, string[]>();
  for (const [id, data] of contacts) {
    const into = data['mergedInto'];
    if (typeof into === 'string' && into) tombstones.set(into, [...(tombstones.get(into) ?? []), id]);
  }

  /** The live contact an id ends up at, following `mergedInto`; null when deleted or missing. */
  const resolve = (id: string): string | null => {
    let current = id;
    for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
      const data = contacts.get(current);
      if (!data || isDeleted(data)) return null;
      const into = data['mergedInto'];
      if (typeof into !== 'string' || !into) return current;
      current = into;
    }
    return null;
  };

  const perSubject = subjects.map((subject) => {
    const candidates = new Map<string, Candidate>();
    const selfId = subject.contactId ? resolve(subject.contactId) : null;
    if (selfId) {
      candidates.set(selfId, {
        score: 1,
        reasons: [],
        self: true,
        ...(selfId !== subject.contactId && subject.contactId ? { via: subject.contactId } : {}),
      });
    }
    const probe = subjectProbe(subject);
    for (const [id, data] of contacts) {
      if (id === subject.contactId || isDeleted(data)) continue;
      const { score, reasons } = scoreDuplicate(probe, data as unknown as DuplicateCandidate);
      if (score < CONFLICT_HIT_THRESHOLD) continue;
      const target = resolve(id);
      if (!target || target === selfId) continue;
      const existing = candidates.get(target);
      if (existing && existing.score >= score) continue;
      candidates.set(target, { score, reasons, ...(target !== id ? { via: id } : {}) });
    }
    const ranked = [...candidates.entries()].sort(([, a], [, b]) => b.score - a.score);
    // The self entry always stays; fuzzy hits are capped.
    return ranked.filter(([, c], index) => c.self || index < MAX_HITS_PER_SUBJECT + (selfId ? 1 : 0));
  });

  // Party rows of every hit contact (and of its tombstones), then their matters, once each.
  const hitIds = [...new Set(perSubject.flatMap((ranked) => ranked.map(([id]) => id)))];
  const partyRows = new Map<string, { matterId: string; role: string }[]>();
  await Promise.all(
    hitIds.map(async (id) => {
      const ids = [id, ...(tombstones.get(id) ?? [])];
      const snaps = await Promise.all(ids.map((contactId) => partyQuery(db, orgId, contactId).get()));
      const rows: { matterId: string; role: string }[] = [];
      for (const snap of snaps) {
        for (const doc of snap.docs) {
          const party = doc.data();
          const matterId = typeof party['matterId'] === 'string' ? party['matterId'] : doc.ref.parent.parent?.id;
          if (!matterId || matterId === options.excludeMatterId || isDeleted(party)) continue;
          rows.push({ matterId, role: String(party['role']) });
        }
      }
      partyRows.set(id, rows);
    }),
  );
  const matterIds = [...new Set([...partyRows.values()].flat().map((row) => row.matterId))];
  const matterSnaps = matterIds.length
    ? await db.getAll(...matterIds.map((matterId) => db.doc(matterPath(orgId, matterId))))
    : [];
  const matters = new Map<string, Data>(
    matterSnaps.filter((snap) => snap.exists).map((snap) => [snap.id, snap.data() as Data]),
  );

  const hits: ConflictHit[] = [];
  perSubject.forEach((ranked, subjectIndex) => {
    const subject = subjects[subjectIndex] as Subject;
    for (const [contactId, candidate] of ranked) {
      const hitMatters: ConflictHitMatter[] = [];
      const seen = new Set<string>();
      for (const row of partyRows.get(contactId) ?? []) {
        const matter = matters.get(row.matterId);
        const role = PartyRoleSchema.safeParse(row.role);
        const status = MatterStatusSchema.safeParse(matter?.['status']);
        const type = MatterTypeSchema.safeParse(matter?.['type']);
        if (!matter || !role.success || !status.success || !type.success) continue;
        const key = `${row.matterId}|${role.data}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const privileged = matter['privileged'] === true;
        const pair = options.adverse ? adversePair(subject.role, role.data, type.data) : undefined;
        hitMatters.push({
          matterId: row.matterId,
          number: typeof matter['number'] === 'string' ? matter['number'] : '',
          title: privileged ? PRIVILEGED_MATTER_TITLE : typeof matter['title'] === 'string' ? matter['title'] : '',
          status: status.data,
          type: type.data,
          role: role.data,
          ...(pair ? { adverse: pair.label } : {}),
          ...(isDeleted(matter) ? { deleted: true } : {}),
          ...(privileged ? { privileged: true } : {}),
        });
      }
      // "This person" is only worth reporting when they are on other matters.
      if (candidate.self && !hitMatters.length) continue;
      hitMatters.sort((a, b) => a.number.localeCompare(b.number) || a.role.localeCompare(b.role));
      hits.push({
        subject: subjectIndex,
        contactId,
        displayName: contactDisplayName((contacts.get(contactId) ?? {}) as never),
        score: candidate.score,
        reasons: candidate.reasons,
        ...(candidate.via ? { viaMergedContactId: candidate.via } : {}),
        ...(candidate.self ? { self: true } : {}),
        matters: hitMatters,
      });
    }
  });
  return hits.sort((a, b) => b.score - a.score || a.subject - b.subject || a.displayName.localeCompare(b.displayName));
}

export interface StoreCheckInput {
  subjects: readonly ConflictSubject[];
  hits: ConflictHit[];
  excludeMatterId?: string | undefined;
  adverseRolesChecked: boolean;
  ranBy: string;
  now: Date;
}

/** Writes `orgs/{orgId}/conflictChecks/{id}` (schema-checked) and returns its id. */
export async function storeConflictCheck(db: Firestore, orgId: string, input: StoreCheckInput): Promise<string> {
  const ref = db.collection(conflictChecksPath(orgId)).doc();
  const data = ConflictCheck.schema.parse(
    compact({
      subjects: input.subjects.map((subject) => ConflictSubjectSchema.parse(subject)),
      hits: input.hits,
      excludeMatterId: input.excludeMatterId,
      ranAt: input.now,
      ranBy: input.ranBy,
      adverseRolesChecked: input.adverseRolesChecked,
      createdAt: input.now,
      createdBy: input.ranBy,
      updatedAt: input.now,
      updatedBy: input.ranBy,
      schemaVersion: ConflictCheck.version,
    }),
  );
  await ref.create(stripUndefinedDeep(data));
  return ref.id;
}

/** The Admin SDK rejects undefined values anywhere in a document (zod output can carry them). */
function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefinedDeep) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Data)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, stripUndefinedDeep(v)]),
    ) as T;
  }
  return value;
}
