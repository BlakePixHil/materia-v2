import * as z from 'zod';

import { DateOnlySchema } from '../values/date-only';
import { CentsSchema } from '../values/money';

/** An instant. Firestore Timestamps become JS Dates in the converters (ADR-008). */
export const InstantSchema = z.date();

/** A user id, or the system actors that write on behalf of no user. */
export const ActorSchema = z.string().min(1);

/** Document ids and uids: non-empty, no path separators. */
export const DocIdSchema = z
  .string()
  .min(1)
  .max(1500)
  .regex(/^[^/]+$/, { message: 'Ids cannot contain "/"' });

export const NonEmptyString = z.string().trim().min(1);

/** A denormalised `search` field (ADR-013): prefix tokens kept by a trigger (`searchTokens`). */
export const SearchTokensSchema = z.array(z.string().min(1)).max(200);

/** Fields every document carries (Architecture & ADRs, cross-cutting conventions). */
export const MetaShape = {
  createdAt: InstantSchema,
  createdBy: ActorSchema,
  updatedAt: InstantSchema,
  updatedBy: ActorSchema,
  schemaVersion: z.number().int().min(1),
  /** The callable request that made the last write; the audit trigger links the entry to it (FND-18). */
  _requestId: z.string().optional(),
};

/**
 * Soft-delete fields, for deletable entities. `null` means live, like a missing field: matters
 * store `deletedAt: null` while live so lists can query `where('deletedAt', '==', null)` (CORE-03),
 * and a restore writes `null` back.
 */
export const SoftDeleteShape = {
  deletedAt: InstantSchema.nullable().optional(),
  deletedBy: ActorSchema.nullable().optional(),
};

/** Present on documents loaded by the legacy migration (Legacy migration plan). */
export const MigrationMetaShape = {
  migration: z.object({ runId: NonEmptyString, legacyPath: NonEmptyString, loadedAt: InstantSchema }).optional(),
  needsReview: z.array(z.string()).optional(),
};

export const META_KEYS = ['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'schemaVersion'] as const;
export const SERVER_KEYS = [...META_KEYS, '_requestId', 'deletedAt', 'deletedBy', 'migration'] as const;

/**
 * Builds the four exports for an entity from its field shape:
 * - schema: the Firestore shape, with common meta fields (and soft-delete fields when deletable);
 * - create: the input for create callables (no meta, no server-owned fields);
 * - update: a partial, whitelisted subset of the create fields.
 */
type CreateShape<T extends z.ZodRawShape, K extends PropertyKey> = Omit<T, K>;
type UpdateShape<T extends z.ZodRawShape, N extends PropertyKey, K extends PropertyKey> = {
  [P in Exclude<N, K> & keyof T]: z.ZodOptional<T[P]>;
};

export function withMeta<
  T extends z.ZodRawShape,
  K extends keyof T & string = never,
  N extends keyof T & string = keyof T & string,
>(
  shape: T,
  options: {
    path: string;
    version?: number;
    softDelete?: boolean;
    migratable?: boolean;
    /** Fields set by the server only (counters, denormalised fields): excluded from create/update. */
    serverOwned?: readonly K[];
    /** Fields that may be changed after creation. Defaults to every create field. */
    updatable?: readonly N[];
  },
) {
  const fullShape = {
    ...shape,
    ...MetaShape,
    ...(options.softDelete ? SoftDeleteShape : {}),
    ...(options.migratable === false ? {} : MigrationMetaShape),
  };
  const serverOwned = new Set<string>(options.serverOwned ?? []);
  const createKeys = Object.keys(shape).filter((key) => !serverOwned.has(key));
  const updateKeys = ((options.updatable as readonly string[] | undefined) ?? createKeys).filter(
    (key) => !serverOwned.has(key),
  );
  const pickShape = (keys: string[]): z.ZodRawShape =>
    Object.fromEntries(keys.map((key) => [key, shape[key]])) as z.ZodRawShape;

  const schema = z.object(fullShape as T & typeof MetaShape).strict();
  const create = z.object(pickShape(createKeys)).strict() as unknown as z.ZodObject<CreateShape<T, K>, z.core.$strict>;
  const update = z.object(pickShape(updateKeys)).partial().strict() as unknown as z.ZodObject<
    UpdateShape<T, N, K>,
    z.core.$strict
  >;
  return { schema, create, update, version: options.version ?? 1, path: options.path };
}

/** The longest quote a citation keeps (the API's `cited_text` is cut to this). */
export const CITATION_QUOTE_MAX = 2000;

/** The matter records a `record` citation can point at (briefs and insights cite these, AI-05). */
export const CITATION_RECORD_COLLECTIONS = [
  'matter',
  'deadlines',
  'events',
  'tasks',
  'timeEntries',
  'notes',
  'parties',
  'metrics',
] as const;
export const CitationRecordCollectionSchema = z.enum(CITATION_RECORD_COLLECTIONS);

interface CitationFields {
  kind: 'document' | 'record';
  documentId?: string | undefined;
  page?: number | undefined;
  pageEnd?: number | undefined;
  charStart?: number | undefined;
  charEnd?: number | undefined;
  recordRef?: unknown;
}

/** The checks across a citation's fields: what it cites must be named, and ranges run forwards. */
function citationIssues<T extends CitationFields>(citation: T, issue: z.core.$RefinementCtx<T>): void {
  if (citation.kind === 'document' && !citation.documentId)
    issue.addIssue({ code: 'custom', path: ['documentId'], message: 'A document citation needs its document' });
  if (citation.kind === 'record' && !citation.recordRef)
    issue.addIssue({ code: 'custom', path: ['recordRef'], message: 'A record citation needs its record' });
  if (citation.charStart !== undefined && citation.charEnd !== undefined && citation.charEnd < citation.charStart)
    issue.addIssue({ code: 'custom', path: ['charEnd'], message: 'charEnd comes before charStart' });
  if (citation.pageEnd !== undefined && (citation.page === undefined || citation.pageEnd < citation.page))
    issue.addIssue({ code: 'custom', path: ['pageEnd'], message: 'pageEnd comes before page' });
}

/**
 * A citation's fields (AI-05, ADR-043), without the legacy-name migration: use it where a plain
 * object schema is needed (a structured-output JSON schema); stored data goes through
 * `CitationSchema`.
 *
 * - `kind: 'document'` (the default) cites `documentId` at `docVersion`, `page` (to `pageEnd` when
 *   the quote runs over a page break) and optionally `charStart`/`charEnd`, offsets into the cited
 *   page's extracted text (a hint: the quote is what the viewer and verification search for).
 * - `kind: 'record'` cites a matter record (`recordRef`: a deadline, event, time entry…) for briefs
 *   and insights; `quote` is the fact it relies on.
 * - `verified: false` marks a citation whose quote wasn't found on the cited page (AI-05
 *   verification): kept for audit, never shown. Absent means verified or never checked.
 */
export const CitationObjectSchema = z
  .object({
    kind: z.enum(['document', 'record']).default('document'),
    documentId: DocIdSchema.optional(),
    /** The document version the quote was taken from (citations pin it; ADR-038). */
    docVersion: z.number().int().min(1).optional(),
    page: z.number().int().min(1).optional(),
    /** The last page of a quote that spans pages (only when after `page`). */
    pageEnd: z.number().int().min(1).optional(),
    quote: z.string().max(CITATION_QUOTE_MAX),
    charStart: z.number().int().min(0).optional(),
    charEnd: z.number().int().min(0).optional(),
    recordRef: z.object({ collection: CitationRecordCollectionSchema, id: DocIdSchema }).optional(),
    verified: z.boolean().optional(),
  })
  .superRefine(citationIssues);

/**
 * A citation (Clerk rule 2; AI-05, ADR-043). Older stored shapes (`{documentId, version?, page?,
 * quote}` from AI-02, AI-04 and AI-07) still parse: `version` is read as `docVersion` and `kind`
 * defaults to `document`, so the parsed value always has the current field names.
 */
export const CitationSchema = z
  .object({
    ...CitationObjectSchema.shape,
    /** @deprecated AI-02's name for `docVersion`; accepted on read, never written. */
    version: z.number().int().min(1).optional(),
  })
  .superRefine(citationIssues)
  .transform(({ version, ...citation }) => {
    const docVersion = citation.docVersion ?? version;
    return docVersion === undefined ? citation : { ...citation, docVersion };
  });
export type Citation = z.output<typeof CitationSchema>;
/** A citation as written (old field names allowed). */
export type CitationInput = z.input<typeof CitationSchema>;
/** A citation of a document (`kind: 'document'`), with its id. */
export type DocumentCitation = Citation & { kind: 'document'; documentId: string };

/** Whether a citation cites a document (as opposed to a matter record). */
export const isDocumentCitation = (citation: Citation): citation is DocumentCitation =>
  citation.kind === 'document' && typeof citation.documentId === 'string';

export const AddressSchema = z.object({
  type: z.enum(['residential', 'postal', 'business', 'other']),
  line1: NonEmptyString,
  line2: z.string().optional(),
  suburb: NonEmptyString,
  state: z.string().min(2).max(3),
  postcode: z.string().regex(/^\d{4}$/),
  country: z.literal('AU'),
});

/** E.164 phone number (legacy `04…` becomes `+614…` during migration). */
export const PhoneSchema = z.object({
  type: z.enum(['mobile', 'home', 'work', 'other']),
  number: z.string().regex(/^\+[1-9]\d{6,14}$/, { message: 'Expected an E.164 number such as +61412345678' }),
});

export const EmailSchema = z.object({
  type: z.enum(['personal', 'work', 'other']),
  address: z.email().transform((value) => value.toLowerCase()),
});

export { CentsSchema, DateOnlySchema };
