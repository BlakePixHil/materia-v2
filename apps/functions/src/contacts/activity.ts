import { FieldPath, Filter, Timestamp, type Firestore } from 'firebase-admin/firestore';

import {
  can,
  contactActivityFields,
  contactDisplayName,
  ContactActivityInput,
  DomainError,
  matterIsLive,
  PartyRoleSchema,
  PERMISSIONS,
  type ContactActivityKind,
  type ContactActivityLine,
  type ContactActivityResult,
  type Contact,
  type PartyRole,
} from '@materia/domain';

import { contactPath } from './shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

/**
 * A contact's Activity (CORE-01a), read from the audit log (FND-18) when the contact is opened:
 * the contact's own writes (added, edits by detail, deleted, restored), merges, and the matters it
 * was added to, re-roled on or removed from. Reading the log keeps the whole history (nothing to
 * project or backfill) and checks each matter's privilege as it is now, not as it was.
 */

/** One audit entry: its id and data. */
export interface AuditDoc {
  id: string;
  data: Data;
}

/** A line before its matter and other contact are looked up. */
interface Candidate {
  /** A write and its semantic entry (same request, same document) share it; see SAME_REQUEST_MS. */
  key: string;
  semantic: boolean;
  line: Omit<ContactActivityLine, 'matter' | 'other'>;
  matterId?: string;
  otherId?: string;
}

/** What a line adds to the entry's id, time and actor. */
interface CandidateExtra {
  matterId?: string;
  otherId?: string;
  line?: Pick<ContactActivityLine, 'fields' | 'role' | 'previousRole'>;
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const role = (value: unknown): PartyRole | undefined => {
  const parsed = PartyRoleSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const toIso = (value: unknown): string => {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : new Date(0).toISOString();
};

function actorOf(actor: unknown): string {
  if (actor === 'system' || actor === 'clerk') return actor;
  return text((actor as { uid?: unknown } | undefined)?.uid) ?? 'system';
}

const PARTY_ACTIONS: Readonly<Record<string, ContactActivityKind>> = {
  'matter.party_added': 'party_added',
  'matter.party_updated': 'party_updated',
  'matter.party_removed': 'party_removed',
};

/**
 * What an audit entry says about the contact, or null when it isn't one of its Activity lines:
 * - its own document: `create`, `update` (by detail group; a merge's `mergedInto` reads as merged
 *   away), `soft_delete`, `restore`, `delete`, and `contact.merged` on the contact kept;
 * - its party rows: `matter.party_added`/`_updated`/`_removed` from the parties callables, and
 *   the `parties` `create` writes intake makes without one (the same line when both exist).
 */
export function candidateFor(entry: AuditDoc, orgId: string, contactId: string): Candidate | null {
  const { data } = entry;
  const action = text(data['action']);
  const entity = (data['entity'] ?? {}) as { path?: string; collection?: string; matterId?: string };
  if (!action || !entity.path) return null;
  const semantic = action.includes('.');
  const requestId = text(data['requestId']);
  const key = requestId ? `${requestId}|${entity.path}` : `entry|${entry.id}`;
  const base = { id: entry.id, at: toIso(data['at']), actorUid: actorOf(data['actor']) };
  const details = (data['data'] ?? {}) as Data;
  const after = (data['after'] ?? {}) as Data;
  const changed = Array.isArray(data['changedFields']) ? (data['changedFields'] as string[]) : [];
  const make = (kind: ContactActivityKind, extra: CandidateExtra = {}): Candidate => {
    const { line, ...refs } = extra;
    return { key, semantic, line: { ...base, kind, ...line }, ...refs };
  };

  if (entity.path === contactPath(orgId, contactId)) {
    if (semantic) {
      // A re-run of a merge (`resumed`) only re-points what is left: the merge itself is one line.
      if (action !== 'contact.merged' || details['keepId'] !== contactId || details['resumed'] === true) return null;
      const mergeId = text(details['mergeId']);
      return make('merged_in', mergeId ? { otherId: mergeId } : {});
    }
    const mergedInto = text(after['mergedInto']);
    if (changed.includes('mergedInto') && mergedInto) return make('merged_away', { otherId: mergedInto });
    if (action === 'create') return make('created');
    if (action === 'soft_delete' || action === 'delete') return make('deleted');
    if (action === 'restore') return make('restored');
    if (action === 'update') {
      const fields = contactActivityFields(changed);
      return fields.length ? make('updated', { line: { fields } }) : null;
    }
    return null;
  }

  const partyKind = PARTY_ACTIONS[action];
  if (partyKind) {
    const matterId = text(details['matterId']) ?? entity.matterId;
    const held = role(details['role']);
    if (details['contactId'] !== contactId || !matterId || !held) return null;
    const previous = role(details['previousRole']);
    if (partyKind === 'party_updated' && previous && previous !== held) {
      return make('party_role_changed', { matterId, line: { role: held, previousRole: previous } });
    }
    return make(partyKind, { matterId, line: { role: held } });
  }

  if (action === 'create' && entity.collection === 'parties' && after['contactId'] === contactId) {
    const held = role(after['role']);
    const matterId = entity.matterId ?? text(after['matterId']);
    return held && matterId ? make('party_added', { matterId, line: { role: held } }) : null;
  }
  return null;
}

// ---------- paging ----------

interface Cursor {
  s: number;
  n: number;
  id: string;
}

export const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');

export function decodeCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof parsed.s === 'number' && typeof parsed.n === 'number' && typeof parsed.id === 'string') {
      return { s: parsed.s, n: parsed.n, id: parsed.id };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new DomainError('INVALID_ARGUMENT', 'Invalid cursor', { fields: { cursor: ['Invalid cursor'] } });
}

/** How far apart a callable's write and its semantic entry can be and still be one event. */
export const SAME_REQUEST_MS = 10_000;

/** Entries read per round, and the most rounds one call reads before handing back a cursor. */
export const ACTIVITY_BATCH = 50;
export const ACTIVITY_MAX_ROUNDS = 4;

/** What building a page needs: the audit entries after a cursor, and documents by path. */
export interface ActivitySource {
  /** Up to `size` entries about the contact, newest first, after `cursor`, each with its cursor. */
  read(cursor: Cursor | null, size: number): Promise<{ entry: AuditDoc; cursor: Cursor }[]>;
  /** The documents at these paths (undefined where missing). */
  getAll(paths: readonly string[]): Promise<(Data | undefined)[]>;
}

/** A line while a page is built: its event key, whether a semantic entry made it, and its time. */
interface PageLine {
  key: string;
  semantic: boolean;
  at: number;
  line: ContactActivityLine;
}

/**
 * One page of a contact's Activity: reads ACTIVITY_BATCH entries at a time (up to
 * ACTIVITY_MAX_ROUNDS) until it has `limit` lines, keeping one line per event and leaving out
 * lines about matters that are deleted, destroyed, or privileged for a caller without
 * `privileged.view`.
 *
 * One event, one line: a callable's semantic entry and the writes it explains (same `requestId`
 * and document, within SAME_REQUEST_MS) make one line, the semantic one, which says more (a role
 * change, a merge). The time limit matters because a later client edit keeps the document's old
 * `_requestId`, so it shares the key but is an event of its own. Once the page is full it reads on
 * through the rest of the batch while entries are that close, folding in the other half of an
 * event it already listed, so an event never straddles two pages.
 */
export async function contactActivityPage(
  source: ActivitySource,
  options: { orgId: string; contactId: string; limit: number; cursor: Cursor | null; canSeePrivileged: boolean },
): Promise<ContactActivityResult> {
  const { orgId, contactId, limit } = options;
  const matters = new Map<string, Data | undefined>();
  const contacts = new Map<string, Data | undefined>();
  const lines: PageLine[] = [];
  let cursor = options.cursor;
  const page = (next: Cursor | null): ContactActivityResult => ({
    lines: lines.map((l) => l.line),
    nextCursor: next ? encodeCursor(next) : null,
  });

  const load = async (cache: Map<string, Data | undefined>, ids: string[], path: (id: string) => string) => {
    const missing = [...new Set(ids)].filter((id) => !cache.has(id));
    if (!missing.length) return;
    const docs = await source.getAll(missing.map(path));
    missing.forEach((id, i) => cache.set(id, docs[i]));
  };

  /** The line for a candidate, or null when its matter is gone or hidden from the caller. */
  const lineFor = (candidate: Candidate): ContactActivityLine | null => {
    const line: ContactActivityLine = { ...candidate.line };
    if (candidate.matterId) {
      const matter = matters.get(candidate.matterId);
      if (!matterIsLive(matter)) return null;
      if (matter?.['privileged'] === true && !options.canSeePrivileged) return null;
      line.matter = {
        id: candidate.matterId,
        number: text(matter?.['number']) ?? null,
        title: text(matter?.['title']) ?? 'Untitled matter',
      };
    }
    if (candidate.otherId) {
      const other = contacts.get(candidate.otherId);
      if (other) line.other = { id: candidate.otherId, name: contactDisplayName(other as Partial<Contact>) };
    }
    return line;
  };

  /** Folds a line into the other half of its event already listed; false when it is a new event. */
  const fold = (candidate: Candidate, line: ContactActivityLine, at: number): boolean => {
    const sameEvent = (l: PageLine) =>
      l.key === candidate.key && l.semantic !== candidate.semantic && Math.abs(l.at - at) <= SAME_REQUEST_MS;
    const partner = lines.findIndex(sameEvent);
    if (partner < 0) return false;
    if (candidate.semantic) {
      // The semantic line takes the place of the first of its writes; the others go.
      const rest = lines.slice(partner + 1).filter((l) => !sameEvent(l));
      lines.splice(partner, lines.length - partner, { key: candidate.key, semantic: true, at, line }, ...rest);
    }
    return true;
  };

  let oldest: number | null = null;
  for (let round = 0; round < ACTIVITY_MAX_ROUNDS; round++) {
    const batch = await source.read(cursor, ACTIVITY_BATCH);
    const candidates = batch.map(({ entry }) => candidateFor(entry, orgId, contactId));
    await load(
      matters,
      candidates.flatMap((c) => c?.matterId ?? []),
      (id) => matterPath(orgId, id),
    );
    await load(
      contacts,
      candidates.flatMap((c) => c?.otherId ?? []),
      (id) => contactPath(orgId, id),
    );
    for (const [i, { entry, cursor: next }] of batch.entries()) {
      const candidate = candidates[i];
      const line = candidate ? lineFor(candidate) : null;
      const at = Date.parse(line?.at ?? toIso(entry.data['at']));
      if (oldest !== null) {
        // The page is full: read on only to fold in the rest of an event already listed.
        if (oldest - at > SAME_REQUEST_MS) return page(cursor);
        if (candidate && line && !fold(candidate, line, at)) return page(cursor);
        cursor = next;
        continue;
      }
      cursor = next;
      if (!candidate || !line || fold(candidate, line, at)) continue;
      lines.push({ key: candidate.key, semantic: candidate.semantic, at, line });
      if (lines.length >= limit) oldest = at;
    }
    if (batch.length < ACTIVITY_BATCH) return page(null);
    if (oldest !== null) return page(cursor);
  }
  return page(cursor);
}

/** The audit entries about a contact: its own document, and party entries naming it. */
export function contactAuditQuery(db: Firestore, orgId: string, contactId: string) {
  return db
    .collection(`orgs/${orgId}/audit`)
    .where(
      Filter.or(
        Filter.where('entity.path', '==', contactPath(orgId, contactId)),
        Filter.where('data.contactId', '==', contactId),
        Filter.where('after.contactId', '==', contactId),
      ),
    )
    .orderBy('at', 'desc')
    .orderBy(FieldPath.documentId(), 'desc');
}

function firestoreSource(db: Firestore, orgId: string, contactId: string): ActivitySource {
  return {
    read: async (cursor, size) => {
      let query = contactAuditQuery(db, orgId, contactId);
      if (cursor) query = query.startAfter(new Timestamp(cursor.s, cursor.n), cursor.id);
      const snap = await query.limit(size).get();
      return snap.docs.map((doc) => {
        const at = doc.get('at');
        const stamp = at instanceof Timestamp ? at : Timestamp.fromMillis(0);
        return {
          entry: { id: doc.id, data: doc.data() as Data },
          cursor: { s: stamp.seconds, n: stamp.nanoseconds, id: doc.id },
        };
      });
    },
    getAll: async (paths) => {
      if (!paths.length) return [];
      const snaps = await db.getAll(...paths.map((path) => db.doc(path)));
      return snaps.map((snap) => snap.data() as Data | undefined);
    },
  };
}

/**
 * `contacts-activity` (CORE-01a, every role): one page of a contact's Activity, newest first.
 * Lines about a matter the caller can't see (privileged without `privileged.view`, deleted or
 * destroyed) are left out; the rest name the matter. NOT_FOUND for a contact not in the org.
 */
export const activityDefinition = {
  name: 'contacts-activity',
  input: ContactActivityInput,
  roles: PERMISSIONS['matter.view'],
  handler: async ({ input, orgId, role, db }): Promise<ContactActivityResult> => {
    const contact = await db.doc(contactPath(orgId, input.contactId)).get();
    if (!contact.exists) throw new DomainError('NOT_FOUND', 'Contact not found', { contactId: input.contactId });
    return contactActivityPage(firestoreSource(db, orgId, input.contactId), {
      orgId,
      contactId: input.contactId,
      limit: input.limit,
      cursor: input.cursor ? decodeCursor(input.cursor) : null,
      canSeePrivileged: can(role, 'privileged.view'),
    });
  },
} satisfies CallableDefinition<typeof ContactActivityInput, ContactActivityResult>;

/** `contacts-activity`. */
export const activity = defineCallable(activityDefinition);
