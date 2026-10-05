import type { DocumentSnapshot, Firestore, WriteBatch } from 'firebase-admin/firestore';
import * as z from 'zod';

import {
  contactDerivedFields,
  DocIdSchema,
  DomainError,
  MergeContactsInput,
  PERMISSIONS,
  type Contact,
  type MergeContactsResult,
} from '@materia/domain';

import {
  compact,
  contactPath,
  isDeleted,
  matterIdOfParty,
  matterReferenceQueries,
  partyQuery,
  safeCustodyQuery,
  stamp,
} from './shared';
import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';
import type { Log } from '../core/log';
import { defineQueue, enqueue } from '../core/tasks';
import type { Clock } from '../ports';
import { systemClock } from '../ports/container';

/** References re-pointed inside the callable; the rest go to the queue. */
export const REPOINT_IN_CALL = 200;
/** References re-pointed per queued task. */
export const REPOINT_PER_TASK = 400;
/** Writes per batch (Firestore allows 500). */
const BATCH_WRITES = 400;
/** A runaway guard for the task chain: 1000 tasks of 400 is 400k references. */
const MAX_ROUNDS = 1000;

export const CONTINUE_MERGE_QUEUE = 'contacts-continueMerge';

type Data = Record<string, unknown>;

// ---------- merging the contact documents ----------

/** Fields copied from the merged contact when the kept one has no value. */
const FILL_FIELDS = [
  'givenNames',
  'familyName',
  'preferredName',
  'dateOfBirth',
  'dateOfDeath',
  'orgName',
  'abn',
  'referrerMeta',
  'notes',
] as const;

const empty = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && !value.trim());

function unionBy<T>(keep: T[] | undefined, extra: T[] | undefined, key: (item: T) => string): T[] {
  const seen = new Set((keep ?? []).map(key));
  const out = [...(keep ?? [])];
  for (const item of extra ?? []) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

const addressKey = (address: Contact['addresses'][number]) =>
  [address.line1, address.line2 ?? '', address.suburb, address.state, address.postcode]
    .map((part) => part.trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|');

/**
 * The kept contact after a merge: emails, phones, addresses and tags unioned (deduplicated by
 * address and number), empty fields filled from the merged contact, and referrer if either was.
 */
export function mergedContactFields(keep: Partial<Contact>, merge: Partial<Contact>): Partial<Contact> {
  const patch: Partial<Contact> = {
    emails: unionBy(keep.emails, merge.emails, (email) => email.address.toLowerCase()),
    phones: unionBy(keep.phones, merge.phones, (phone) => phone.number),
    addresses: unionBy(keep.addresses, merge.addresses, addressKey),
    tags: unionBy(keep.tags, merge.tags, (tag) => tag.toLowerCase()),
    isReferrer: !!keep.isReferrer || !!merge.isReferrer,
  };
  for (const field of FILL_FIELDS) {
    if (empty(keep[field]) && !empty(merge[field])) (patch as Data)[field] = merge[field];
  }
  return patch;
}

// ---------- re-pointing references ----------

export interface RepointContext {
  db: Firestore;
  orgId: string;
  keepId: string;
  mergeId: string;
  uid: string;
  requestId: string;
  clock: Clock;
  log: Log;
}

/** Queued writes, committed in batches of BATCH_WRITES. */
class Writes {
  private batches: WriteBatch[] = [];
  private count = 0;
  constructor(private readonly db: Firestore) {}
  add(fn: (batch: WriteBatch) => void) {
    if (this.count % BATCH_WRITES === 0) this.batches.push(this.db.batch());
    fn(this.batches.at(-1) as WriteBatch);
    this.count++;
  }
  async commit() {
    for (const batch of this.batches) await batch.commit();
  }
}

/** A matter's fields with `from` replaced by `to` (client ids de-duplicated), or null if it has none. */
export function repointMatter(matter: Data, from: string, to: string): Data | null {
  const patch: Data = {};
  const clients = matter['clientContactIds'];
  if (Array.isArray(clients) && clients.includes(from)) {
    patch['clientContactIds'] = [...new Set(clients.map((id) => (id === from ? to : id)))];
  }
  if (matter['referrerContactId'] === from) patch['referrerContactId'] = to;
  for (const field of ['deceased', 'testator']) {
    const value = matter[field] as Data | undefined;
    if (value?.['contactId'] === from) patch[field] = { ...value, contactId: to };
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * Re-points up to `limit` documents from `mergeId` to `keepId`: party rows (collection group),
 * matters (client, referrer, deceased, testator) and safe custody packets. Each pass re-queries,
 * and a re-pointed document no longer matches, so passes need no cursor and a re-run after a
 * failure picks up where it stopped. `more` is true when the budget ran out (there may be more).
 *
 * Both contacts on the same matter: the re-pointed party row is kept, so a person who was
 * executor (one record) and beneficiary (the other) keeps both roles. A row that would repeat a
 * role the kept contact already has on that matter is soft-deleted as well.
 */
export async function repointPage(ctx: RepointContext, limit: number): Promise<{ repointed: number; more: boolean }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await repointPageOnce(ctx, limit);
    } catch (error) {
      // A matter changed between the read and its guarded write (a trigger such as
      // matters-denormalise, or a person editing it): read again and re-point what is left.
      if (!isFailedPrecondition(error) || attempt >= REPOINT_ATTEMPTS) throw error;
      ctx.log.warn('a matter changed while re-pointing, retrying', {
        attempt,
        keepId: ctx.keepId,
        mergeId: ctx.mergeId,
      });
    }
  }
}

/** Attempts per page when a matter changes under the re-pointing (see `repointPage`). */
const REPOINT_ATTEMPTS = 3;

/** gRPC FAILED_PRECONDITION: a write's `lastUpdateTime` precondition no longer held. */
const isFailedPrecondition = (error: unknown) => (error as { code?: unknown } | null)?.code === 9;

async function repointPageOnce(ctx: RepointContext, limit: number): Promise<{ repointed: number; more: boolean }> {
  const { db, orgId, keepId, mergeId } = ctx;
  const now = ctx.clock.now();
  const meta = stamp(ctx.uid, now, ctx.requestId);
  const writes = new Writes(db);
  let count = 0;

  // Party rows.
  const parties = await partyQuery(db, orgId, mergeId).limit(limit).get();
  const keepRoles = new Map<string, Set<string>>();
  for (const party of parties.docs) {
    const matterId = matterIdOfParty(party.ref.path, orgId);
    if (!matterId) continue; // Not this org's (the orgId field says otherwise): never touch it.
    let roles = keepRoles.get(matterId);
    if (!roles) {
      const existing = await db
        .collection(`orgs/${orgId}/matters/${matterId}/parties`)
        .where('contactId', '==', keepId)
        .get();
      roles = new Set(existing.docs.filter((doc) => !isDeleted(doc.data())).map((doc) => String(doc.get('role'))));
      keepRoles.set(matterId, roles);
    }
    const role = String(party.get('role'));
    const repeat = roles.has(role) && !isDeleted(party.data());
    roles.add(role);
    writes.add((batch) =>
      batch.update(party.ref, {
        contactId: keepId,
        ...meta,
        ...(repeat ? { deletedAt: now, deletedBy: ctx.uid } : {}),
      }),
    );
    count++;
  }

  // Matters: one patch per matter, however many of its fields point at the merged contact.
  const matters = new Map<string, DocumentSnapshot>();
  for (const { query } of matterReferenceQueries(db, orgId, mergeId)) {
    if (count + matters.size >= limit) break;
    const found = await query.limit(limit - count - matters.size).get();
    for (const doc of found.docs) if (count + matters.size < limit) matters.set(doc.ref.path, doc);
  }
  for (const matter of matters.values()) {
    const patch = repointMatter(matter.data() as Data, mergeId, keepId);
    if (!patch) continue;
    // Guard against a concurrent edit of the same array: the batch fails and the page is retried.
    const precondition = matter.updateTime ? { lastUpdateTime: matter.updateTime } : undefined;
    writes.add((batch) =>
      precondition
        ? batch.update(matter.ref, { ...patch, ...meta }, precondition)
        : batch.update(matter.ref, { ...patch, ...meta }),
    );
    count++;
  }

  // Safe custody packets.
  if (count < limit) {
    const packets = await safeCustodyQuery(db, orgId, mergeId)
      .limit(limit - count)
      .get();
    for (const packet of packets.docs) {
      writes.add((batch) => batch.update(packet.ref, { testatorContactId: keepId, ...meta }));
      count++;
    }
  }

  await writes.commit();
  ctx.log.info('references re-pointed', { repointed: count, keepId, mergeId });
  return { repointed: count, more: count >= limit };
}

// ---------- the callable ----------

export const ContinueMergeTask = z.object({
  orgId: DocIdSchema,
  keepId: DocIdSchema,
  mergeId: DocIdSchema,
  uid: DocIdSchema,
  requestId: z.string().min(1),
  round: z.number().int().min(1),
});
export type ContinueMergeTask = z.infer<typeof ContinueMergeTask>;

/** Queues the next page of a large merge (one task per round, deduplicated). */
export function enqueueContinueMerge(task: ContinueMergeTask): Promise<void> {
  return enqueue(CONTINUE_MERGE_QUEUE, task, {
    dedupeKey: `${CONTINUE_MERGE_QUEUE}/${task.orgId}/${task.mergeId}/${task.requestId}/${task.round}`,
  });
}

/**
 * Marks `mergeId` as merged into `keepId` and folds its details into `keepId`, in a transaction.
 * Returns false when this already happened (a re-run), so only the re-pointing runs again.
 */
async function mergeDocuments(ctx: RepointContext): Promise<boolean> {
  const { db, orgId, keepId, mergeId, uid, requestId } = ctx;
  const keepRef = db.doc(contactPath(orgId, keepId));
  const mergeRef = db.doc(contactPath(orgId, mergeId));
  return db.runTransaction(async (tx) => {
    const [keep, merge] = [await tx.get(keepRef), await tx.get(mergeRef)];
    const keepData = keep.data() as (Partial<Contact> & Data) | undefined;
    const mergeData = merge.data() as (Partial<Contact> & Data) | undefined;
    if (!keepData || isDeleted(keepData) || keepData.mergedInto) {
      throw new DomainError('NOT_FOUND', 'The contact to keep was not found', { contactId: keepId });
    }
    if (!mergeData) throw new DomainError('NOT_FOUND', 'The contact to merge was not found', { contactId: mergeId });
    if (mergeData.mergedInto === keepId) return false;
    if (mergeData.mergedInto || isDeleted(mergeData)) {
      throw new DomainError('FAILED_PRECONDITION', 'That contact was already merged or deleted', {
        reason: 'already_merged',
        contactId: mergeId,
      });
    }
    if (keepData.kind !== mergeData.kind) {
      throw new DomainError('FAILED_PRECONDITION', 'A person cannot be merged with an organisation', {
        reason: 'kind_mismatch',
      });
    }
    const now = ctx.clock.now();
    const fields = mergedContactFields(keepData, mergeData);
    tx.update(
      keepRef,
      compact({ ...fields, ...contactDerivedFields({ ...keepData, ...fields }), ...stamp(uid, now, requestId) }),
    );
    tx.update(mergeRef, { mergedInto: keepId, deletedAt: now, deletedBy: uid, ...stamp(uid, now, requestId) });
    return true;
  });
}

/**
 * `contacts-merge` (CORE-01, owner and admin). `mergeId` becomes a tombstone (`mergedInto`,
 * soft-deleted) and its details fold into `keepId`; then every reference in the org is re-pointed.
 * Up to REPOINT_IN_CALL references are re-pointed in the call; past that the rest continue in
 * `contacts-continueMerge` tasks and the result says `queued: true`. Safe to re-run: a repeat
 * with the same requestId replays the result, and a new call for the same pair resumes the
 * re-pointing.
 */
export const mergeDefinition = {
  name: 'contacts-merge',
  input: MergeContactsInput,
  roles: PERMISSIONS['contact.merge'],
  idempotent: true,
  timeoutSeconds: 300,
  handler: async (ctx): Promise<MergeContactsResult> => {
    const { input, orgId, uid, requestId, db, clock, log } = ctx;
    const repoint: RepointContext = {
      db,
      orgId,
      keepId: input.keepId,
      mergeId: input.mergeId,
      uid,
      requestId,
      clock,
      log,
    };
    const merged = await mergeDocuments(repoint);
    const { repointed, more } = await repointPage(repoint, REPOINT_IN_CALL);
    if (more)
      await enqueueContinueMerge({ orgId, keepId: input.keepId, mergeId: input.mergeId, uid, requestId, round: 1 });
    await audit(ctx, {
      action: 'contact.merged',
      entity: { path: contactPath(orgId, input.keepId) },
      summary: `Contact ${input.mergeId} merged into ${input.keepId}`,
      data: { keepId: input.keepId, mergeId: input.mergeId, repointed, queued: more, resumed: !merged },
    });
    return { repointed, queued: more };
  },
} satisfies CallableDefinition<typeof MergeContactsInput, MergeContactsResult>;

export const merge = defineCallable(mergeDefinition);

// ---------- the continuation queue ----------

/** One queued page of a large merge: re-points the next REPOINT_PER_TASK and queues the next round. */
export async function continueMerge(
  task: ContinueMergeTask,
  deps: { db: Firestore; log: Log; clock?: Clock; enqueueNext?: (task: ContinueMergeTask) => Promise<void> },
): Promise<{ repointed: number; more: boolean }> {
  const result = await repointPage(
    { ...task, db: deps.db, clock: deps.clock ?? systemClock, log: deps.log },
    REPOINT_PER_TASK,
  );
  if (!result.more) {
    deps.log.info('merge complete', { keepId: task.keepId, mergeId: task.mergeId, rounds: task.round });
  } else if (task.round >= MAX_ROUNDS) {
    deps.log.error('merge stopped: too many rounds', { keepId: task.keepId, mergeId: task.mergeId });
  } else {
    await (deps.enqueueNext ?? enqueueContinueMerge)({ ...task, round: task.round + 1 });
  }
  return result;
}

/** `contacts-continueMerge`: the Cloud Tasks queue behind large merges. */
export const continueMergeQueue = defineQueue({
  name: CONTINUE_MERGE_QUEUE,
  input: ContinueMergeTask,
  retry: { maxAttempts: 5 },
  handler: async (task, { db, log }) => void (await continueMerge(task, { db, log })),
});
