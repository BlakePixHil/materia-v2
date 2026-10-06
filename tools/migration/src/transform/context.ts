import { domain } from '../domain.ts';
import type { MappingProfile } from '../profile.ts';

/**
 * What every mapper (MIG-03) shares: the run, the target org, the profile, the reference time and
 * the warnings collector. Mappers are pure: they read their legacy records and this context and
 * return v2 records, and the only thing they change is the warnings they add.
 */

/** The deterministic id namespace: `deterministicId('mig', legacyPath)` (FND-13). */
export const MIG_NAMESPACE = 'mig';

/**
 * The v2 id of a legacy record: its path, or its path and a `#part` for a record the transform
 * derives from it (`workflows/w/cards/c#client`). The same key always gives the same id.
 */
export function migId(key: string): string {
  return domain.deterministicId(MIG_NAMESPACE, key);
}

/**
 * Stable warning codes and what each means. The report counts every code (zero included) and
 * lists the legacy paths that raised it, never their content.
 */
export const WARNINGS = {
  MIG_W_DATE_INVALID:
    'A date could not be read. Instants use the export time instead; due and billing dates are left unset',
  MIG_W_UPDATED_BEFORE_CREATED: 'The record says it was updated before it was created; updatedAt is set to createdAt',
  MIG_W_ASSIGNEE_FOREIGN: 'The card was assigned to someone else; the user is responsible now',
  MIG_W_SWIMLANE_UNKNOWN: "The card's column isn't on the board any more, or the profile doesn't map it",
  MIG_W_LABEL_UNKNOWN: 'A label id the board no longer defines was dropped',
  MIG_W_PRIORITY_UNKNOWN: 'A priority outside 0 to 3 was read as none',
  MIG_W_REFERRER_MISSING: 'The card names a referrer that is not exported',
  MIG_W_REFERRER_NO_TIMESTAMPS: 'The referrer has no dates, so the export time is used',
  MIG_W_REFERRER_UNNAMED: 'The referrer has neither a name nor a company',
  MIG_W_PHONE_INVALID: "A phone number isn't a valid number; it is kept in the contact's notes",
  MIG_W_EMAIL_INVALID: "An email address isn't valid; it is kept in the contact's notes",
  MIG_W_ADDRESS_UNPARSED: "An address couldn't be split into its parts; it is kept in the contact's notes",
  MIG_W_LINK_DROPPED: "A linked card isn't migrated as a matter (another board, or deleted), so the link is dropped",
  MIG_W_FEE_TYPE_MISSING: 'The card has no billing type: hourly with no estimate, for review',
  MIG_W_FEE_TYPE_UNKNOWN: 'The billing type is not one the legacy app had: hourly with no estimate, for review',
  MIG_W_FEE_FOLIO: 'Billed by folio in legacy: hourly in v2, with a note (D-06)',
  MIG_W_FEE_DISBURSEMENTS:
    'The legacy fee recorded disbursements; they are kept on the matter for review, not as records',
  MIG_W_CALENDAR_EVENTS_EXIST: "A checklist item had a calendar event, which is still in the user's calendar",
  MIG_W_HTML_UNSAFE_REMOVED: 'Rich text held scripts, styles, frames or similar, which were removed',
  MIG_W_REMOTE_IMAGE_DROPPED: 'Rich text loaded an image from the web (a tracking pixel, say), which was dropped',
  MIG_W_INLINE_IMAGE_EXTRACTED: 'An image embedded in a description became a document on the matter',
  MIG_W_NOTE_TRUNCATED: "Text longer than a note's limit was cut",
  MIG_W_TEXT_TRUNCATED: 'A title, name or group longer than v2 allows was cut',
  MIG_W_UNTITLED: 'A record had no title, so a placeholder title is used',
  MIG_W_ATTACHMENT_OBJECT_MISSING:
    "The attachment's file is not in legacy Storage; the document is kept, with nothing to copy",
  MIG_W_ATTACHMENT_SIZE_MISMATCH: "The attachment's recorded size differs from its file's; the file's size is used",
  MIG_W_ATTACHMENT_OVERSIZE: 'The file is over the 25 MB legacy limit; it still migrates',
  MIG_W_ATTACHMENT_DOWNLOAD_ONLY:
    'A type v2 uploads refuse (svg, gif, bmp): it migrates as a download-only file (D-13)',
  MIG_W_ATTACHMENT_TYPE_FROM_EXTENSION: 'The attachment had no content type, so it comes from the file extension',
  MIG_W_ATTACHMENT_NOT_MIGRATED:
    'A file or embedded image on a card that becomes a personal task has no matter to go on, so it is not migrated',
  MIG_W_TEMPLATE_ID_MISMATCH: "The checklist template's id field differs from its document id; the document id is used",
  MIG_W_TEMPLATE_TRUNCATED: 'A checklist template had more items than v2 allows; the rest were dropped',
  MIG_W_TEMPLATE_EMPTY: 'A checklist template had no items, so it is not migrated',
  MIG_W_CHECKLIST_TRUNCATED: "A card's checklist had more items than a personal task holds; the rest were dropped",
  MIG_W_BUDGET_ROLLED_OVER:
    "The profile's budget year is before the current one, so this year has no budget (legacy rollover)",
  MIG_W_BUDGET_MISSING: 'The profile has no financial year budgets (older profiles)',
  MIG_W_BUDGET_YEAR_MISSING: 'A budget has no financial year, so it is read as the current one',
  MIG_W_ORG_NAME_UNCONFIRMED: 'The org name comes from the legacy company name; the user confirms it at cutover (D-09)',
  MIG_W_MATTER_REFERENCE_DUPLICATE:
    'A matter reference repeats, so a new number is allocated (it stays the external reference)',
  MIG_W_PERSON_MISSING: 'A referenced user has no legacy profile, so their name is unknown',
  MIG_W_NON_PRIME_WORKSPACE: 'A non-prime workspace is listed in the report, not migrated',
  MIG_W_INTEGRATION_NOT_MIGRATED: 'A legacy integration is not migrated; the user reconnects it',
} as const;
export type WarningCode = keyof typeof WARNINGS;
export const WARNING_CODES = Object.keys(WARNINGS) as WarningCode[];

/**
 * Why a migrated record needs the user's eye (`needsReview[]`, the MIG-08 review queue). Matters
 * carry most of them; contacts, tasks and the org the rest.
 */
export const REVIEW_CODES = [
  'title_missing',
  'client_from_title',
  'client_placeholder',
  'swimlane_unknown',
  'fee_type_missing',
  'fee_amount_missing',
  'fee_conditional_terms',
  'fee_disbursements',
  'closed_without_closing_record',
  'referrer_unnamed',
  'org_name_unconfirmed',
  'budgets_imported',
] as const;
export type ReviewCode = (typeof REVIEW_CODES)[number];

export class Warnings {
  private readonly byCode = new Map<WarningCode, Set<string>>();

  add(code: WarningCode, legacyPath: string): void {
    const paths = this.byCode.get(code) ?? new Set<string>();
    paths.add(legacyPath);
    this.byCode.set(code, paths);
  }

  /** Every code, zero counts included, with its sorted legacy paths. */
  summary(): Record<WarningCode, { count: number; meaning: string; paths: string[] }> {
    return Object.fromEntries(
      WARNING_CODES.map((code) => {
        const paths = [...(this.byCode.get(code) ?? [])].sort();
        return [code, { count: paths.length, meaning: WARNINGS[code], paths }];
      }),
    ) as Record<WarningCode, { count: number; meaning: string; paths: string[] }>;
  }

  has(code: WarningCode, legacyPath: string): boolean {
    return this.byCode.get(code)?.has(legacyPath) ?? false;
  }
}

export interface TransformContext {
  runId: string;
  /** The migrated user's uid, the same in legacy and v2 (D-16). */
  uid: string;
  orgId: string;
  profile: MappingProfile;
  timeZone: string;
  /**
   * The export's readTime. It stands in for the load time wherever a value is missing or invalid,
   * and decides the current financial year, so re-running a run gives the same bytes. The load
   * (MIG-06) stamps its own `migration.loadedAt`.
   */
  asOf: Date;
  /** Other legacy users the data names: their name, or null when their profile is gone. */
  people: ReadonlyMap<string, string | null>;
  /** Uids that are members of the v2 org: mentions of them stay mentions. */
  members: ReadonlySet<string>;
  warnings: Warnings;
}

/** The name of a referenced user: the subject's own, a person's from `people.jsonl`, or null. */
export function personName(ctx: TransformContext, uid: string, subjectName: string): string | null {
  if (uid === ctx.uid) return subjectName;
  return ctx.people.get(uid) ?? null;
}

export interface MetaInput {
  legacyPath: string;
  createdAt: Date;
  updatedAt: Date;
  /** Who the v2 record names as its writer: the user, or `migration` for someone who isn't a member. */
  by: string;
  needsReview?: readonly ReviewCode[];
}

/** The system actor for records written on behalf of someone who isn't a v2 member. */
export const MIGRATION_ACTOR = 'migration';

/** The fields every migrated document carries (MetaShape and MigrationMetaShape in libs/domain). */
export function migratedMeta(ctx: TransformContext, input: MetaInput): Record<string, unknown> {
  const review = [...new Set(input.needsReview ?? [])];
  return {
    createdAt: input.createdAt,
    createdBy: input.by,
    updatedAt: input.updatedAt,
    updatedBy: input.by,
    schemaVersion: 1,
    migration: { runId: ctx.runId, legacyPath: input.legacyPath, loadedAt: ctx.asOf },
    ...(review.length ? { needsReview: review } : {}),
  };
}

/** The same for server-only documents the schemas don't stamp (counters, number reservations). */
export function plainMeta(ctx: TransformContext): Record<string, unknown> {
  return {
    createdAt: ctx.asOf,
    createdBy: MIGRATION_ACTOR,
    updatedAt: ctx.asOf,
    updatedBy: MIGRATION_ACTOR,
    schemaVersion: 1,
  };
}

/** Text cut to `max` characters, with a warning when it had to be. */
export function fit(ctx: TransformContext, text: string, max: number, legacyPath: string): string {
  if (text.length <= max) return text;
  ctx.warnings.add('MIG_W_TEXT_TRUNCATED', legacyPath);
  return cutAt(text, max).trimEnd();
}

/** The first `max` UTF-16 units of `text`, without half of a surrogate pair (an emoji) at the end. */
export function cutAt(text: string, max: number): string {
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** One output record: a v2 document (or a file to copy), where it goes and where it came from. */
export interface TransformedRecord {
  entity: EntityName;
  /** The v2 path: `orgs/{O}/matters/{M}`. */
  path: string;
  /** The legacy record it came from (a path, or a path and `#part`). */
  legacyPath: string;
  /** The v2 document; absent for a file-only record (the avatar). */
  data?: Record<string, unknown>;
  /** A file MIG-05 copies into v2 Storage. */
  copy?: CopyPlan;
}

/**
 * A file MIG-05 copies into v2 Storage (its contract: `tools/migration/src/files/contract.ts`): the
 * legacy object by name, or bytes the transform extracted. The version it becomes takes its upload
 * time and uploader from the document's `createdAt` and `createdBy`.
 */
export interface CopyPlan {
  /** The legacy object name; absent when the object is missing (or for extracted bytes). */
  source?: string;
  /** Bytes the transform extracted (an image embedded in a description), base64. */
  content?: { encoding: 'base64'; data: string; sha256: string };
  target: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  md5Hash?: string;
  crc32c?: string;
  generation?: string;
  /** Served as a download only, never inline (svg, gif and bmp, D-13). */
  downloadOnly?: boolean;
}

/** The transformed files, `transformed/{entity}.jsonl`, in the order a load writes them. */
export const ENTITIES = [
  'orgs',
  'users',
  'members',
  'counters',
  'contacts',
  'matters',
  'parties',
  'matter-numbers',
  'tasks',
  'personal-tasks',
  'notes',
  'activity',
  'documents',
  'checklist-templates',
  'avatars',
] as const;
export type EntityName = (typeof ENTITIES)[number];
