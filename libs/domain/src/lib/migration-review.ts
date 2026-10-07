import * as z from 'zod';

/**
 * The migration review (MIG-08, D-22): the records the legacy migration loaded with `needsReview`
 * codes (MIG-03's transform, MIG-06's load and MIG-09's enrichment), and how each is put right.
 * A fix goes through the app's normal paths (renaming the matter, changing its client, stage or
 * fee, uploading the file); the person can also mark a code reviewed as it stands. Either way the
 * code moves from `needsReview` to `reviewed`, so progress is reviewed codes over all codes.
 */

/** What a code is on: the record's collection, the org itself or a member. */
export const MIGRATION_REVIEW_ENTITIES = ['matter', 'contact', 'org', 'member', 'document'] as const;
export type MigrationReviewEntity = (typeof MIGRATION_REVIEW_ENTITIES)[number];

/**
 * How the queue offers to fix a code:
 * - `rename-matter` / `rename-contact`: a name field on the row;
 * - `matter`: open the matter at `tab` (its client, stage, fee or closing is changed there);
 * - `org-name`: the practice's name, confirmed on the row or changed in Settings → Practice;
 * - `team`: Settings → Team and roles (a member's budgets);
 * - `document`: the document, to upload the file again.
 */
export type MigrationReviewFix = 'rename-matter' | 'rename-contact' | 'matter' | 'org-name' | 'team' | 'document';

export interface MigrationReviewCodeInfo {
  entity: MigrationReviewEntity;
  /** A short name for the filter and the row. */
  label: string;
  /** What happened and what to check, in a sentence or two. */
  help: string;
  fix: MigrationReviewFix;
  /** The matter tab a `matter` fix opens. */
  tab?: 'overview' | 'parties' | 'time';
  /**
   * Fields whose change by a person clears the code (it moves to `reviewed`): the record was put
   * right elsewhere in the app. Empty for codes only a review clears.
   */
  clearedBy: readonly string[];
}

/**
 * Every review code, in the queue's order. The transform's codes are MIG-03's `REVIEW_CODES`
 * (`tools/migration/src/transform/context.ts`, D-19); the `MIG_W_*` codes on documents are the
 * load's for a file it couldn't bring (D-20) and the enrichment's for a file Clerk can't read (D-21).
 */
export const MIGRATION_REVIEW_CODES = {
  title_missing: {
    entity: 'matter',
    label: 'No title',
    help: 'The card had no title, so the matter is “Untitled matter (imported)”. Give it a title.',
    fix: 'rename-matter',
    clearedBy: ['title'],
  },
  client_placeholder: {
    entity: 'matter',
    label: 'Client to choose',
    help: 'The card’s title named no one, so the client is a placeholder contact. Choose the real client.',
    fix: 'matter',
    tab: 'parties',
    clearedBy: ['clientContactIds'],
  },
  client_from_title: {
    entity: 'matter',
    label: 'Client from the title',
    help: 'The client contact was made from the card’s title. Check it’s the right person, spelt right.',
    fix: 'matter',
    tab: 'parties',
    clearedBy: ['clientContactIds'],
  },
  swimlane_unknown: {
    entity: 'matter',
    label: 'Stage unknown',
    help: 'The card was in a column the board no longer had, so the matter starts at its first stage.',
    fix: 'matter',
    tab: 'overview',
    clearedBy: ['stageId', 'status'],
  },
  fee_type_missing: {
    entity: 'matter',
    label: 'No fee arrangement',
    help: 'The card had no billing type, so the fee is hourly with no estimate. Set the arrangement.',
    fix: 'matter',
    tab: 'overview',
    clearedBy: ['fee'],
  },
  fee_amount_missing: {
    entity: 'matter',
    label: 'Fee amount missing',
    help: 'The fixed or capped fee came across without its amount. Enter it.',
    fix: 'matter',
    tab: 'overview',
    clearedBy: ['fee'],
  },
  fee_conditional_terms: {
    entity: 'matter',
    label: 'No-win terms to complete',
    help: 'A conditional fee needs its uplift and condition, which the old system never held.',
    fix: 'matter',
    tab: 'overview',
    clearedBy: ['fee'],
  },
  fee_disbursements: {
    entity: 'matter',
    label: 'Disbursements to record',
    help: 'The card noted disbursements, kept in a note on the matter. Record them as disbursements.',
    fix: 'matter',
    tab: 'time',
    clearedBy: [],
  },
  closed_without_closing_record: {
    entity: 'matter',
    label: 'Closed without a closing record',
    help: 'Closed in the old system, so it has no closing record. Check it was finished.',
    fix: 'matter',
    tab: 'overview',
    clearedBy: ['closing'],
  },
  referrer_unnamed: {
    entity: 'contact',
    label: 'Referrer without a name',
    help: 'A referrer came across with no name, as “Unnamed referrer (imported)”. Name them.',
    fix: 'rename-contact',
    clearedBy: ['givenNames', 'familyName', 'preferredName', 'orgName'],
  },
  org_name_unconfirmed: {
    entity: 'org',
    label: 'Practice name to confirm',
    help: 'The practice’s name came from the old company name. Confirm it or change it.',
    fix: 'org-name',
    clearedBy: ['name'],
  },
  budgets_imported: {
    entity: 'member',
    label: 'Budgets brought across',
    help: 'Billing budgets came across from the old profile. Check the amounts and years.',
    fix: 'team',
    clearedBy: ['budgets'],
  },
  MIG_W_ATTACHMENT_OBJECT_MISSING: {
    entity: 'document',
    label: 'File missing',
    help: 'The old system had lost this file, so the document has no file. Upload it if you have it.',
    fix: 'document',
    clearedBy: ['version'],
  },
  MIG_W_ATTACHMENT_NOT_COPIED: {
    entity: 'document',
    label: 'File not copied',
    help: 'The file couldn’t be copied or checked, so the document has no file. Upload it again.',
    fix: 'document',
    clearedBy: ['version'],
  },
  MIG_W_DOCUMENT_UNREADABLE: {
    entity: 'document',
    label: 'Clerk can’t read it',
    help: 'The file is encrypted, damaged or an email file, so Clerk can’t read it. Upload a readable copy.',
    fix: 'document',
    clearedBy: ['version'],
  },
} as const satisfies Record<string, MigrationReviewCodeInfo>;

export type MigrationReviewCode = keyof typeof MIGRATION_REVIEW_CODES;
export const MIGRATION_REVIEW_CODE_LIST = Object.keys(MIGRATION_REVIEW_CODES) as MigrationReviewCode[];
export const MigrationReviewCodeSchema = z.enum(MIGRATION_REVIEW_CODE_LIST as [MigrationReviewCode]);

export function isMigrationReviewCode(code: unknown): code is MigrationReviewCode {
  return typeof code === 'string' && Object.hasOwn(MIGRATION_REVIEW_CODES, code);
}

export function migrationReviewCodeInfo(code: MigrationReviewCode): MigrationReviewCodeInfo {
  return MIGRATION_REVIEW_CODES[code];
}

/** The org's collection each entity's records are in (`org` is the org document itself). */
export const MIGRATION_REVIEW_COLLECTIONS: Record<MigrationReviewEntity, string | null> = {
  matter: 'matters',
  contact: 'contacts',
  member: 'members',
  document: 'documents',
  org: null,
};

/** The entity a record's path is in, or null for a path the review doesn't cover. */
export function migrationReviewEntityOf(orgId: string, path: string): MigrationReviewEntity | null {
  const parts = path.split('/');
  if (parts[0] !== 'orgs' || parts[1] !== orgId || parts.some((part) => !part)) return null;
  if (parts.length === 2) return 'org';
  if (parts.length === 4) {
    const collection = parts[2];
    if (collection === 'matters') return 'matter';
    if (collection === 'contacts') return 'contact';
    if (collection === 'members') return 'member';
    return null;
  }
  if (parts.length === 6 && parts[2] === 'matters' && parts[4] === 'documents') return 'document';
  return null;
}

type Data = Record<string, unknown>;

const codesOf = (data: Data | undefined, field: 'needsReview' | 'reviewed'): string[] =>
  Array.isArray(data?.[field])
    ? (data[field] as unknown[]).filter((code): code is string => typeof code === 'string')
    : [];

/** A record's open review codes. */
export const openReviewCodes = (data: Data | undefined) => codesOf(data, 'needsReview');
/** A record's reviewed codes. */
export const reviewedCodes = (data: Data | undefined) => codesOf(data, 'reviewed');

/** Structural equality for stored values (Timestamps compare by `isEqual`). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const equal = (a as { isEqual?: (other: unknown) => boolean } | null)?.isEqual;
  if (typeof equal === 'function') return equal.call(a, b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => same((a as Data)[key], (b as Data)[key]));
}

const live = (data: Data | undefined) => !data?.['deletedAt'] && !data?.['mergedInto'];

/**
 * The open codes a person's edit put right: a code whose `clearedBy` field changed, or every code
 * once the record is deleted or merged away (nothing is left to review). For the triggers, which
 * skip the migration's own writes (`isMigrationWrite`) and creates.
 */
export function reviewCodesFixedBy(before: Data | undefined, after: Data | undefined): string[] {
  if (!before || !after) return [];
  const open = openReviewCodes(after);
  if (!open.length) return [];
  if (live(before) && !live(after)) return open;
  return open.filter((code) => {
    if (!isMigrationReviewCode(code)) return false;
    return MIGRATION_REVIEW_CODES[code].clearedBy.some((field) => !same(before[field], after[field]));
  });
}

/**
 * The fields that move `codes` from a record's `needsReview` to its `reviewed` (null when none of
 * them is open). `needsReview` is removed once empty, which `deleteField` stands for.
 */
export function reviewPatch<D>(
  data: Data | undefined,
  codes: readonly string[],
  deleteField: D,
): { needsReview: string[] | D; reviewed: string[] } | null {
  const open = openReviewCodes(data);
  const moving = open.filter((code) => codes.includes(code));
  if (!moving.length) return null;
  const remaining = open.filter((code) => !moving.includes(code));
  const reviewed = [...new Set([...reviewedCodes(data), ...moving])];
  return { needsReview: remaining.length ? remaining : deleteField, reviewed };
}

/** Reviewed over all codes, as a whole percentage (rounded down, so 100 means none open). */
export function migrationReviewPercent(open: number, reviewed: number): number {
  const total = open + reviewed;
  if (!total) return 100;
  return Math.floor((reviewed / total) * 100);
}

// ---------- callables ----------

export const MIGRATION_CALLABLES = {
  /** The queue: counts by code, and the records with a code open. */
  review: 'migration-review',
  /** Mark codes reviewed as they stand, for some records or every one with a code. */
  resolve: 'migration-resolveReview',
} as const;

/** The most records the queue lists at once (fixing them brings in the next ones). */
export const MIGRATION_REVIEW_PAGE = 200;
/** The most records one "Mark reviewed" names. */
export const MIGRATION_RESOLVE_MAX = 500;

/** `migration-review` (owners and admins): `limit: 0` returns the counts only (Today's card). */
export const MigrationReviewInput = z
  .object({
    code: MigrationReviewCodeSchema.optional(),
    limit: z.number().int().min(0).max(MIGRATION_REVIEW_PAGE).optional(),
  })
  .strict();
export type MigrationReviewInput = z.input<typeof MigrationReviewInput>;

export interface MigrationReviewItem {
  /** The record's path: `orgs/{orgId}`, `orgs/{orgId}/{collection}/{id}` or a matter's document. */
  path: string;
  entity: MigrationReviewEntity;
  id: string;
  /** The matter a matter or document belongs to. */
  matterId?: string;
  /** The record's name: the matter's title, the contact's or member's name, the file's. */
  title: string;
  /** The matter number, or the document's matter number. */
  detail?: string;
  /** Its open codes. */
  codes: MigrationReviewCode[];
  /** An archived matter is read-only: it can be marked reviewed but not changed. */
  readOnly?: boolean;
}

export interface MigrationReviewCount {
  code: MigrationReviewCode;
  open: number;
  reviewed: number;
}

export interface MigrationReviewResult {
  /** Every code, in the catalogue's order. */
  codes: MigrationReviewCount[];
  open: number;
  reviewed: number;
  percent: number;
  /** The records with the code asked for (or any) open, up to the limit. */
  items: MigrationReviewItem[];
  /** More records than `items` have the code open. */
  more: boolean;
  /** When the review was finished (no code open), as an ISO instant; null while it isn't. */
  reviewedAt: string | null;
}

export const ResolveMigrationReviewInput = z
  .object({
    requestId: z.uuid(),
    /** These records' codes. */
    items: z
      .array(z.object({ path: z.string().min(1).max(1500), code: MigrationReviewCodeSchema }).strict())
      .min(1)
      .max(MIGRATION_RESOLVE_MAX)
      .optional(),
    /** Every record with this code open ("Mark all reviewed"). */
    code: MigrationReviewCodeSchema.optional(),
  })
  .strict()
  .refine((input) => !!input.items !== !!input.code, { message: 'Name the records or a code', path: ['items'] });
export type ResolveMigrationReviewInput = z.input<typeof ResolveMigrationReviewInput>;

export interface ResolveMigrationReviewResult {
  /** Codes moved to reviewed. */
  resolved: number;
  /** Named codes already reviewed or gone (fixed elsewhere, or the record deleted). */
  skipped: number;
  open: number;
  reviewed: number;
  percent: number;
  reviewedAt: string | null;
}
