import { FieldValue, type DocumentSnapshot, type Firestore, type Query } from 'firebase-admin/firestore';

import {
  contactDisplayName,
  DomainError,
  isMigrationReviewCode,
  MIGRATION_CALLABLES,
  MIGRATION_REVIEW_CODE_LIST,
  MIGRATION_REVIEW_CODES,
  MIGRATION_REVIEW_COLLECTIONS,
  MIGRATION_REVIEW_PAGE,
  migrationReviewEntityOf,
  migrationReviewPercent,
  MigrationReviewInput,
  openReviewCodes,
  PERMISSIONS,
  ResolveMigrationReviewInput,
  reviewedCodes,
  reviewPatch,
  type MigrationReviewCode,
  type MigrationReviewCount,
  type MigrationReviewItem,
  type MigrationReviewResult,
  type ResolveMigrationReviewResult,
} from '@materia/domain';

import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';

type Data = Record<string, unknown>;
type Field = 'needsReview' | 'reviewed';

/** Records resolved at once (each in its own transaction, so a trigger's write isn't lost). */
const RESOLVE_CONCURRENCY = 20;
/** "Mark all reviewed" works through a code this many records at a time… */
const RESOLVE_PAGE = 200;
/** …for at most this many pages (10,000 records; Tristan's practice has a few hundred matters). */
const RESOLVE_MAX_PAGES = 50;

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const millis = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  const toMillis = (value as { toMillis?: () => number } | undefined)?.toMillis;
  return typeof toMillis === 'function' ? toMillis.call(value) : 0;
};

/** The records with `code` in `field`; null for the org's own code, read from the org document. */
function codeQuery(db: Firestore, orgId: string, code: MigrationReviewCode, field: Field): Query | null {
  const { entity } = MIGRATION_REVIEW_CODES[code];
  if (entity === 'org') return null;
  if (entity === 'document') {
    return db.collectionGroup('documents').where('orgId', '==', orgId).where(field, 'array-contains', code);
  }
  return db.collection(`orgs/${orgId}/${MIGRATION_REVIEW_COLLECTIONS[entity]}`).where(field, 'array-contains', code);
}

async function countOf(db: Firestore, orgId: string, org: Data | undefined, code: MigrationReviewCode, field: Field) {
  const query = codeQuery(db, orgId, code, field);
  if (!query) return (field === 'needsReview' ? openReviewCodes(org) : reviewedCodes(org)).includes(code) ? 1 : 0;
  return (await query.count().get()).data().count;
}

/** Open and reviewed counts for every code (count aggregations, so cheap however many records). */
export async function reviewCounts(db: Firestore, orgId: string) {
  const org = (await db.doc(`orgs/${orgId}`).get()).data();
  const codes: MigrationReviewCount[] = await Promise.all(
    MIGRATION_REVIEW_CODE_LIST.map(async (code) => {
      const [open, reviewed] = await Promise.all([
        countOf(db, orgId, org, code, 'needsReview'),
        countOf(db, orgId, org, code, 'reviewed'),
      ]);
      return { code, open, reviewed };
    }),
  );
  const open = codes.reduce((sum, count) => sum + count.open, 0);
  const reviewed = codes.reduce((sum, count) => sum + count.reviewed, 0);
  return { org, codes, open, reviewed, percent: migrationReviewPercent(open, reviewed) };
}

/** One queue row from a record with a code open. */
export function reviewItem(orgId: string, path: string, data: Data): MigrationReviewItem | null {
  const entity = migrationReviewEntityOf(orgId, path);
  if (!entity) return null;
  const id = path.split('/').at(-1) as string;
  const codes = openReviewCodes(data).filter(isMigrationReviewCode);
  if (!codes.length) return null;
  const base = { path, entity, id, codes };
  switch (entity) {
    case 'matter': {
      const readOnly = data['status'] === 'archived' || !!data['destroyedAt'];
      return {
        ...base,
        matterId: id,
        title: text(data['title']) || 'Untitled matter',
        ...(text(data['number']) ? { detail: text(data['number']) } : {}),
        ...(readOnly ? { readOnly } : {}),
      };
    }
    case 'document':
      return { ...base, matterId: path.split('/')[3] as string, title: text(data['name']) || 'Untitled document' };
    case 'contact':
      return { ...base, title: contactDisplayName(data) };
    case 'member':
      return { ...base, title: text(data['displayName']) || id };
    case 'org':
      return { ...base, title: text(data['name']) };
  }
}

/** The records with `code` (or any code) open, merged by record, up to `limit`. */
async function reviewItems(
  db: Firestore,
  orgId: string,
  org: Data | undefined,
  code: MigrationReviewCode | undefined,
  limit: number,
): Promise<{ items: MigrationReviewItem[]; more: boolean }> {
  const found = new Map<string, MigrationReviewItem>();
  for (const each of code ? [code] : MIGRATION_REVIEW_CODE_LIST) {
    if (found.size > limit) break;
    const query = codeQuery(db, orgId, each, 'needsReview');
    const rows: { path: string; data: Data }[] = query
      ? (await query.limit(limit + 1).get()).docs.map((doc) => ({ path: doc.ref.path, data: doc.data() }))
      : openReviewCodes(org).includes(each)
        ? [{ path: `orgs/${orgId}`, data: org ?? {} }]
        : [];
    for (const row of rows) {
      if (found.has(row.path)) continue;
      const item = reviewItem(orgId, row.path, row.data);
      if (item) found.set(row.path, item);
    }
  }
  const items = [...found.values()];
  return { items: items.slice(0, limit), more: items.length > limit };
}

interface RunRow {
  ref: DocumentSnapshot['ref'];
  status: unknown;
  startedAt: number;
  reviewedAt: unknown;
}

/** The org's migration runs (a handful: rehearsals, the cutover and its deltas). */
async function runsOf(db: Firestore, orgId: string): Promise<RunRow[]> {
  const snap = await db.collection(`orgs/${orgId}/migrations`).get();
  return snap.docs.map((doc) => ({
    ref: doc.ref,
    status: doc.get('status'),
    startedAt: millis(doc.get('startedAt')),
    reviewedAt: doc.get('reviewedAt'),
  }));
}

const latestOf = (runs: readonly RunRow[]) =>
  runs.reduce<RunRow | undefined>(
    (latest, run) => (!latest || run.startedAt > latest.startedAt ? run : latest),
    undefined,
  );

/**
 * When nothing is left open, the import counts as reviewed: each succeeded run without a
 * `reviewedAt` gets one. Returns the latest succeeded run's `reviewedAt`, or null.
 */
async function markReviewed(runs: RunRow[], uid: string, now: Date, open: number): Promise<string | null> {
  const succeeded = runs.filter((run) => run.status === 'succeeded');
  if (open === 0) {
    for (const run of succeeded.filter((each) => !each.reviewedAt)) {
      await run.ref.update({ reviewedAt: now, reviewedBy: uid });
      run.reviewedAt = now;
    }
  }
  const at = latestOf(succeeded)?.reviewedAt;
  return at ? new Date(millis(at)).toISOString() : null;
}

/**
 * `migration-review` (MIG-08; owners and admins): the review queue. Open and reviewed counts for
 * every code, the records with the code asked for (or any) open, and progress. Once no code is
 * open, the migration's runs are stamped reviewed.
 */
export const reviewDefinition = {
  name: MIGRATION_CALLABLES.review,
  input: MigrationReviewInput,
  roles: PERMISSIONS['org.settings'],
  handler: async (ctx): Promise<MigrationReviewResult> => {
    const { input, orgId, uid, db, clock } = ctx;
    const counts = await reviewCounts(db, orgId);
    const limit = input.limit ?? MIGRATION_REVIEW_PAGE;
    const { items, more } = limit
      ? await reviewItems(db, orgId, counts.org, input.code, limit)
      : { items: [], more: counts.open > 0 };
    const reviewedAt = await markReviewed(await runsOf(db, orgId), uid, clock.now(), counts.open);
    return {
      codes: counts.codes,
      open: counts.open,
      reviewed: counts.reviewed,
      percent: counts.percent,
      items,
      more,
      reviewedAt,
    };
  },
} satisfies CallableDefinition<typeof MigrationReviewInput, MigrationReviewResult>;

/** Moves `codes` to reviewed on one record, re-read in a transaction. Returns how many moved. */
async function resolveRecord(db: Firestore, path: string, codes: readonly string[]): Promise<number> {
  const ref = db.doc(path);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 0;
    const data = snap.data() as Data;
    const patch = reviewPatch(data, codes, FieldValue.delete());
    if (!patch) return 0;
    tx.update(ref, patch);
    return openReviewCodes(data).filter((code) => codes.includes(code)).length;
  });
}

async function resolveAll(db: Firestore, byPath: Map<string, string[]>): Promise<number> {
  const entries = [...byPath.entries()];
  let resolved = 0;
  for (let i = 0; i < entries.length; i += RESOLVE_CONCURRENCY) {
    const moved = await Promise.all(
      entries.slice(i, i + RESOLVE_CONCURRENCY).map(([path, codes]) => resolveRecord(db, path, codes)),
    );
    resolved += moved.reduce((sum, n) => sum + n, 0);
  }
  return resolved;
}

/** The records with `code` open, a page at a time, until none is left (each page resolves them). */
async function resolveCode(db: Firestore, orgId: string, code: MigrationReviewCode): Promise<number> {
  const query = codeQuery(db, orgId, code, 'needsReview');
  if (!query) return resolveAll(db, new Map([[`orgs/${orgId}`, [code]]]));
  let resolved = 0;
  for (let page = 0; page < RESOLVE_MAX_PAGES; page += 1) {
    const snap = await query.limit(RESOLVE_PAGE).get();
    if (snap.empty) break;
    const moved = await resolveAll(db, new Map(snap.docs.map((doc: DocumentSnapshot) => [doc.ref.path, [code]])));
    resolved += moved;
    // Nothing moved: the page is records another write is changing; leave them to the next call.
    if (!moved) break;
  }
  return resolved;
}

/**
 * `migration-resolveReview` (MIG-08; owners and admins; idempotent): "Looks right" on records
 * (their named codes), or "Mark all reviewed" for every record with a code. The codes move from
 * `needsReview` to `reviewed`; codes already gone (put right elsewhere) are skipped. The record's
 * `updatedAt` is left alone: a review isn't an edit, so a later delta load still updates it (and
 * keeps the review, D-22). Audited once per call.
 */
export const resolveReviewDefinition = {
  name: MIGRATION_CALLABLES.resolve,
  input: ResolveMigrationReviewInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  handler: async (ctx): Promise<ResolveMigrationReviewResult> => {
    const { input, orgId, uid, db, clock, log } = ctx;
    let named = 0;
    let resolved: number;
    if (input.items) {
      const byPath = new Map<string, string[]>();
      for (const item of input.items) {
        const entity = migrationReviewEntityOf(orgId, item.path);
        if (!entity || MIGRATION_REVIEW_CODES[item.code].entity !== entity) {
          throw new DomainError('INVALID_ARGUMENT', 'That record doesn’t take that review code', { path: item.path });
        }
        const codes = byPath.get(item.path) ?? [];
        if (!codes.includes(item.code)) codes.push(item.code);
        byPath.set(item.path, codes);
      }
      named = [...byPath.values()].reduce((sum, codes) => sum + codes.length, 0);
      resolved = await resolveAll(db, byPath);
    } else {
      resolved = await resolveCode(db, orgId, input.code as MigrationReviewCode);
      named = resolved;
    }

    const counts = await reviewCounts(db, orgId);
    const runs = await runsOf(db, orgId);
    const reviewedAt = await markReviewed(runs, uid, clock.now(), counts.open);
    if (resolved) {
      const codes = input.code ? [input.code] : [...new Set(input.items?.map((item) => item.code))];
      await audit(ctx, {
        action: 'migration.reviewed',
        entity: { path: latestOf(runs)?.ref.path ?? `orgs/${orgId}/migrations/review` },
        summary: `${resolved} migration review ${resolved === 1 ? 'code' : 'codes'} marked reviewed`,
        data: { resolved, codes, all: !!input.code, open: counts.open },
      });
    }
    log.info('migration review resolved', { resolved, open: counts.open });
    return {
      resolved,
      skipped: Math.max(0, named - resolved),
      open: counts.open,
      reviewed: counts.reviewed,
      percent: counts.percent,
      reviewedAt,
    };
  },
} satisfies CallableDefinition<typeof ResolveMigrationReviewInput, ResolveMigrationReviewResult>;

export const review = defineCallable(reviewDefinition);
export const resolveReview = defineCallable(resolveReviewDefinition);
