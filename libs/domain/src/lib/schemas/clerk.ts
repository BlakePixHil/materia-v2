import * as z from 'zod';

import {
  CitationSchema,
  DateOnlySchema,
  DocIdSchema,
  InstantSchema,
  MetaShape,
  NonEmptyString,
  withMeta,
} from './common';
import { DocumentCategorySchema, RoleSchema, SuggestionStatusSchema } from './enums';
import { ChronologyEntry, CourtOrder, Evidence } from './litigation';
import { Deadline, MatterEvent, Note, Party, Task, TimeEntry } from './matter-records';

const MATTER = 'orgs/{orgId}/matters/{matterId}';

/** Clerk proposals, one payload schema per kind (Clerk rule 3: proposes, never commits). */
export const SuggestionPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), payload: Task.create }),
  z.object({ kind: z.literal('deadline'), payload: Deadline.create }),
  z.object({ kind: z.literal('event'), payload: MatterEvent.create }),
  z.object({ kind: z.literal('party'), payload: Party.create }),
  z.object({ kind: z.literal('time_entry'), payload: TimeEntry.create }),
  z.object({ kind: z.literal('note'), payload: Note.create }),
  z.object({ kind: z.literal('key_fact'), payload: z.object({ field: NonEmptyString, value: z.string() }) }),
  z.object({ kind: z.literal('chronology'), payload: ChronologyEntry.create }),
  z.object({ kind: z.literal('order'), payload: CourtOrder.create }),
  z.object({
    kind: z.literal('document_meta'),
    payload: z.object({
      documentId: DocIdSchema,
      category: DocumentCategorySchema,
      title: z.string(),
      date: DateOnlySchema.optional(),
      /** People and organisations the document names (AI-04 classification). */
      parties: z.array(z.string().max(200)).max(20).optional(),
    }),
  }),
  z.object({ kind: z.literal('evidence'), payload: Evidence.create }),
]);
export type SuggestionPayload = z.infer<typeof SuggestionPayloadSchema>;

const suggestionMeta = {
  citations: z.array(CitationSchema).default([]),
  status: SuggestionStatusSchema,
  promptId: NonEmptyString,
  /** The prompt's semantic version (`promptId@promptVersion` names the template, AI-02). */
  promptVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  model: NonEmptyString,
  confidence: z.number().min(0).max(1).optional(),
  basis: z.string().optional(),
  dedupeKey: z.string(),
  resolvedBy: DocIdSchema.optional(),
  resolvedAt: InstantSchema.optional(),
  resultRef: z.string().optional(),
};

/**
 * `matters/{matterId}/suggestions/{id}`. The stored shape is the payload union (validated per
 * `kind`) plus the suggestion fields; the client may only change `status`.
 */
const SUGGESTION_CREATE_KEYS = [
  'citations',
  'promptId',
  'promptVersion',
  'model',
  'confidence',
  'basis',
  'dedupeKey',
] as const;
export const Suggestion = {
  schema: SuggestionPayloadSchema.and(z.object({ ...suggestionMeta, ...MetaShape })),
  create: SuggestionPayloadSchema.and(
    z
      .object(suggestionMeta)
      .pick(
        Object.fromEntries(SUGGESTION_CREATE_KEYS.map((key) => [key, true])) as Record<
          (typeof SUGGESTION_CREATE_KEYS)[number],
          true
        >,
      ),
  ),
  update: z.object({ status: SuggestionStatusSchema }).partial().strict(),
  version: 1,
  path: `${MATTER}/suggestions`,
};
export type Suggestion = z.infer<typeof Suggestion.schema>;

export const ClerkThread = withMeta(
  {
    title: z.string(),
    ownerUid: DocIdSchema,
    matterId: DocIdSchema.nullable(),
    lastMessageAt: InstantSchema.optional(),
    shared: z.boolean().default(false),
  },
  { path: 'orgs/{orgId}/clerkThreads', softDelete: true, serverOwned: ['lastMessageAt'], migratable: false },
);

/**
 * What Clerk was shown for one reply (AI-03, ADR-034): every source `buildContext` included, by id
 * and version, stored on the assistant message for audit. Ids and counts only, never text.
 */
export const ContextManifestSchema = z.object({
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('matter'), matterId: DocIdSchema }),
    z.object({ kind: z.literal('metrics') }),
  ]),
  feature: NonEmptyString,
  /** The role the context was built for (the member's current role, re-read at build time). */
  role: RoleSchema,
  /** Privileged material was included: the reply is privileged too (Clerk rule 6). */
  privileged: z.boolean(),
  /** Matter records in the facts block; `at` is the record's `updatedAt` (ISO 8601) when known. */
  records: z.array(
    z.object({
      kind: z.enum(['matter', 'party', 'event', 'deadline', 'task', 'note', 'metrics']),
      id: DocIdSchema,
      at: z.string().optional(),
    }),
  ),
  /** Whole documents (the person's attachments), at the version sent. */
  documents: z.array(z.object({ documentId: DocIdSchema, version: z.number().int().min(1) })),
  /** Retrieved excerpts, one per document page. */
  chunks: z.array(
    z.object({ documentId: DocIdSchema, version: z.number().int().min(1), page: z.number().int().min(1) }),
  ),
  /** Attachments left out because they are still being scanned or ingested. */
  processing: z.number().int().min(0),
  /** What the context told the model about itself ("1 document(s) still processing"). */
  notices: z.array(z.string()),
  /** Material dropped to fit the feature's token budget, lowest-ranked first; null when nothing was. */
  truncated: z
    .object({
      droppedDocs: z.number().int().min(0),
      droppedChunks: z.number().int().min(0),
      droppedNotes: z.number().int().min(0),
    })
    .nullable(),
  /** Context tokens (exact from the provider, or a character estimate) against the feature's budget. */
  tokens: z.object({ used: z.number().int().min(0), budget: z.number().int().min(1), exact: z.boolean() }),
});
export type ContextManifest = z.infer<typeof ContextManifestSchema>;
export type ContextTruncation = NonNullable<ContextManifest['truncated']>;

const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('suggestion_ref'), suggestionId: DocIdSchema }),
]);

export const ClerkMessage = withMeta(
  {
    role: z.enum(['user', 'assistant']),
    content: z.array(ContentBlockSchema),
    citations: z.array(CitationSchema).default([]),
    /**
     * `refused` (shown honestly), `truncated` (hit max tokens; disclosed), `invalid_output` (a
     * structured reply failed validation; never retried blindly), `error` keeps any partial text.
     */
    status: z.enum(['streaming', 'done', 'error', 'stopped', 'refused', 'truncated', 'invalid_output']),
    stopRequested: z.boolean().default(false),
    usage: z
      .object({
        inputTokens: z.number().int().min(0),
        outputTokens: z.number().int().min(0),
        cacheReadTokens: z.number().int().min(0).default(0),
        cacheWriteTokens: z.number().int().min(0).default(0),
      })
      .optional(),
    toolCalls: z.array(z.object({ name: z.string(), status: z.enum(['running', 'done', 'error']) })).default([]),
    /** `id@version` of the prompt template (AI-02). */
    promptId: z.string().optional(),
    /** The model that produced the reply (a fallback model when `fallbackUsed`). */
    model: z.string().optional(),
    fallbackUsed: z.boolean().optional(),
    /** The sources Clerk was given for this reply (AI-03), for audit. */
    manifest: ContextManifestSchema.optional(),
    /** The reply drew on privileged material (AI-03, Clerk rule 6). */
    privileged: z.boolean().optional(),
  },
  {
    path: 'orgs/{orgId}/clerkThreads/{threadId}/messages',
    migratable: false,
    serverOwned: [
      'status',
      'usage',
      'toolCalls',
      'citations',
      'promptId',
      'model',
      'fallbackUsed',
      'manifest',
      'privileged',
    ],
    updatable: ['stopRequested'],
  },
);

export type ClerkThread = z.infer<typeof ClerkThread.schema>;
export type ClerkMessage = z.infer<typeof ClerkMessage.schema>;
