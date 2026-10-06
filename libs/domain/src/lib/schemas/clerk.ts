import * as z from 'zod';

import {
  ActorSchema,
  CitationSchema,
  DateOnlySchema,
  DocIdSchema,
  InstantSchema,
  MetaShape,
  NonEmptyString,
  withMeta,
} from './common';
import {
  DeadlineKindSchema,
  DocumentCategorySchema,
  EventKindSchema,
  PartyRoleSchema,
  PrioritySchema,
  RoleSchema,
  SuggestionStatusSchema,
  type SuggestionKind,
} from './enums';
import { ChronologyEntry, CourtOrder, Evidence } from './litigation';
import { DEADLINE_TITLE_MAX, DOCUMENT_NAME_MAX, TASK_GROUP_MAX, TASK_TITLE_MAX } from './matter-records';
import { KEY_FACTS, KeyFactIdSchema } from '../matter-detail';
import { MinutesSchema } from '../values/minutes';

const MATTER = 'orgs/{orgId}/matters/{matterId}';

/** The longest note a suggestion may propose (the note schema's own limit). */
const PROPOSED_NOTE_MAX = 100_000;
const KEY_FACT_TEXT_MAX = 200;

/**
 * What each kind proposes (AI-07). Narrower than the records they become: the accept handler fills
 * in everything a person doesn't choose (status, order, source, the matter keys), through the same
 * domain logic as the manual path.
 */
export const TaskProposalSchema = z.strictObject({
  title: NonEmptyString.max(TASK_TITLE_MAX),
  descriptionMd: z.string().max(10_000).optional(),
  priority: PrioritySchema.default('none'),
  assigneeUid: DocIdSchema.optional(),
  dueDate: DateOnlySchema.optional(),
  group: z.string().max(TASK_GROUP_MAX).optional(),
});
/** A manual deadline (contractual, internal or court); statutory ones come from the rules engine. */
export const DeadlineProposalSchema = z.strictObject({
  title: NonEmptyString.max(DEADLINE_TITLE_MAX),
  dueDate: DateOnlySchema,
  dueTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Expected HH:MM (24h)' })
    .optional(),
  kind: DeadlineKindSchema.extract(['contractual', 'internal', 'court']).default('internal'),
  critical: z.boolean().default(false),
  assigneeUid: DocIdSchema.optional(),
});
/** A matter event; accepting it recomputes the matter's deadlines (CORE-10). */
export const EventProposalSchema = z.strictObject({
  /** The event to edit; omitted adds one (or edits the one event of a single-valued kind). */
  eventId: DocIdSchema.optional(),
  kind: EventKindSchema,
  date: DateOnlySchema,
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Expected HH:MM (24h)' })
    .optional(),
  label: z.string().trim().max(200).optional(),
  sourceDocumentId: DocIdSchema.optional(),
});
/** An existing contact in a role on the matter (CORE-06). */
export const PartyProposalSchema = z.strictObject({
  contactId: DocIdSchema,
  role: PartyRoleSchema,
  share: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export const NoteProposalSchema = z.strictObject({
  bodyMd: z
    .string()
    .max(PROPOSED_NOTE_MAX)
    .refine((text) => text.trim().length > 0, { message: 'Write something first' }),
  pinned: z.boolean().default(false),
});
/** A key fact (CORE-06): a date, cents or text, checked against the fact's kind. */
export const KeyFactProposalSchema = z
  .strictObject({ field: KeyFactIdSchema, value: z.union([z.string().trim().max(KEY_FACT_TEXT_MAX), z.number()]) })
  .superRefine((fact, issue) => {
    const kind = KEY_FACTS.find((definition) => definition.id === fact.field)?.kind;
    const ok =
      kind === 'date'
        ? DateOnlySchema.safeParse(fact.value).success
        : kind === 'money'
          ? Number.isInteger(fact.value) && (fact.value as number) >= 0
          : typeof fact.value === 'string' && fact.value.length > 0;
    if (!ok) {
      const expected = kind === 'date' ? 'a date (YYYY-MM-DD)' : kind === 'money' ? 'whole cents' : 'some text';
      issue.addIssue({ code: 'custom', path: ['value'], message: `Expected ${expected}` });
    }
  });
/** A draft time entry. No handler until BILL-01 registers one. */
export const TimeEntryProposalSchema = z.strictObject({
  date: DateOnlySchema,
  minutes: MinutesSchema,
  narrative: NonEmptyString.max(2000),
  billable: z.boolean().default(true),
  taskId: DocIdSchema.optional(),
});
/** A document's category or title (the document's `name`). */
export const DocumentMetaProposalSchema = z
  .strictObject({
    documentId: DocIdSchema,
    category: DocumentCategorySchema.optional(),
    title: NonEmptyString.max(DOCUMENT_NAME_MAX).optional(),
    /** The date the document bears (AI-04 classification); shown for review, not applied. */
    date: DateOnlySchema.optional(),
    /** People and organisations the document names (AI-04 classification); shown, not applied. */
    parties: z.array(z.string().max(200)).max(20).optional(),
  })
  .refine((meta) => meta.category !== undefined || meta.title !== undefined, {
    message: 'Propose a category or a title',
    path: ['category'],
  });

/** Clerk proposals, one payload schema per kind (Clerk rule 3: proposes, never commits). */
export const SuggestionPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), payload: TaskProposalSchema }),
  z.object({ kind: z.literal('deadline'), payload: DeadlineProposalSchema }),
  z.object({ kind: z.literal('event'), payload: EventProposalSchema }),
  z.object({ kind: z.literal('party'), payload: PartyProposalSchema }),
  z.object({ kind: z.literal('time_entry'), payload: TimeEntryProposalSchema }),
  z.object({ kind: z.literal('note'), payload: NoteProposalSchema }),
  z.object({ kind: z.literal('key_fact'), payload: KeyFactProposalSchema }),
  // Litigation kinds: LIT tickets register their accept handlers.
  z.object({ kind: z.literal('chronology'), payload: ChronologyEntry.create }),
  z.object({ kind: z.literal('order'), payload: CourtOrder.create }),
  z.object({ kind: z.literal('document_meta'), payload: DocumentMetaProposalSchema }),
  z.object({ kind: z.literal('evidence'), payload: Evidence.create }),
]);
export type SuggestionPayload = z.infer<typeof SuggestionPayloadSchema>;
/** The payload of one kind. */
export type SuggestionPayloadOf<K extends SuggestionKind> = Extract<SuggestionPayload, { kind: K }>['payload'];

/** Each kind's payload schema, for validating an edited payload on accept. */
export const SUGGESTION_PAYLOADS: Readonly<Record<SuggestionKind, z.ZodType>> = Object.fromEntries(
  SuggestionPayloadSchema.options.map((option) => [option.shape.kind.value, option.shape.payload]),
) as unknown as Record<SuggestionKind, z.ZodType>;

/** When an accept found the suggestion's sources changed (status `stale`): what to re-review. */
export const SuggestionStaleReviewSchema = z.object({
  /** The basis now: accepting with it as `expectedBasis` applies the suggestion as it stands. */
  basis: NonEmptyString,
  /** The basis parts that changed (`matter.status`, `fact.grantNo`, `document.{id}.privileged`). */
  changed: z.array(z.string()),
  at: InstantSchema,
});

/** The suggestion fields besides the payload (AI-07, ADR-037). Server-owned: clients only read. */
export const SuggestionMetaShape = {
  /** Collection-group keys, for the expiry sweep and the Inbox (CORE-22). */
  orgId: DocIdSchema,
  matterId: DocIdSchema,
  citations: z.array(CitationSchema).default([]),
  /** Why Clerk suggests it, shown on the card. */
  rationale: z.string().max(1000).optional(),
  status: SuggestionStatusSchema,
  promptId: NonEmptyString,
  /** The prompt's semantic version (`promptId@promptVersion` names the template, AI-02). */
  promptVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  model: NonEmptyString,
  confidence: z.number().min(0).max(1).optional(),
  /**
   * Drew on privileged material (the Clerk context's `manifest.privileged`, a privileged matter, or
   * a cited or targeted privileged document): hidden from roles without `privileged.view`.
   */
  privileged: z.boolean().default(false),
  /** A hash of the source data it was computed from (`suggestionBasis`); re-checked on accept. */
  basis: NonEmptyString,
  /** Each basis part's hash, so a stale accept can say what changed. */
  basisParts: z.record(z.string(), z.string()).default({}),
  dedupeKey: NonEmptyString.max(500),
  expiresAt: InstantSchema,
  resolvedBy: ActorSchema.optional(),
  resolvedAt: InstantSchema.optional(),
  /** The record accepting it created or changed (a document path). */
  resultRef: z.string().optional(),
  /** The payload applied when a person edited it first (status `edited`). */
  appliedPayload: z.record(z.string(), z.unknown()).optional(),
  dismissReason: z.string().max(500).optional(),
  staleReview: SuggestionStaleReviewSchema.optional(),
};

/** What a Clerk feature proposes (`proposeSuggestions`): a kind and payload, with its sources. */
export const SuggestionProposalSchema = SuggestionPayloadSchema.and(
  z.object({
    citations: z.array(CitationSchema).max(20).default([]),
    rationale: z.string().max(1000).optional(),
    confidence: z.number().min(0).max(1).optional(),
    /** Defaults to `defaultDedupeKey(kind, payload)`. */
    dedupeKey: NonEmptyString.max(500).optional(),
  }),
);
export type SuggestionProposal = z.input<typeof SuggestionProposalSchema>;

/**
 * `matters/{matterId}/suggestions/{id}` (AI-07). The stored shape is the payload union (validated
 * per `kind`) plus the suggestion fields. Written only by functions (`proposeSuggestions`, the
 * `suggestions-*` callables and the expiry sweep); clients read them (privileged ones need
 * `privileged.view`) and change nothing directly.
 */
export const Suggestion = {
  schema: SuggestionPayloadSchema.and(z.object({ ...SuggestionMetaShape, ...MetaShape })),
  create: SuggestionProposalSchema,
  update: z.object({}).strict(),
  version: 1,
  path: `${MATTER}/suggestions`,
};
export type Suggestion = z.infer<typeof Suggestion.schema>;

/**
 * `orgs/{orgId}/clerkThreads/{threadId}` (AI-06, ADR-044): one Clerk conversation about one matter.
 * Private to its owner until they share it with the matter team (`shared`). Created by
 * `clerk-sendMessage`; the owner may rename it, share it or delete it. `privileged` is set once any
 * reply drew on privileged material (Clerk rule 6), and hides the thread from roles without
 * `privileged.view`. `continuedFrom` names the thread this one continues, when that one outgrew
 * the context budget.
 */
export const ClerkThread = withMeta(
  {
    title: z.string().max(200),
    ownerUid: DocIdSchema,
    matterId: DocIdSchema.nullable(),
    lastMessageAt: InstantSchema.optional(),
    shared: z.boolean().default(false),
    privileged: z.boolean().default(false),
    continuedFrom: DocIdSchema.optional(),
  },
  {
    path: 'orgs/{orgId}/clerkThreads',
    softDelete: true,
    serverOwned: ['lastMessageAt', 'privileged', 'continuedFrom'],
    updatable: ['title', 'shared'],
    migratable: false,
  },
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

/** Why a person marked a Clerk answer down (AI-06). */
export const CLERK_FEEDBACK_REASONS = ['inaccurate', 'missing_sources', 'not_helpful', 'unsafe', 'other'] as const;
export const ClerkFeedbackReasonSchema = z.enum(CLERK_FEEDBACK_REASONS);
export type ClerkFeedbackReason = z.infer<typeof ClerkFeedbackReasonSchema>;

/** A person's thumbs up or down on one answer (`clerk-setFeedback`), counted for the evals (AI-12). */
export const ClerkFeedbackSchema = z.object({
  rating: z.enum(['up', 'down']),
  reason: ClerkFeedbackReasonSchema.optional(),
  comment: z.string().max(500).optional(),
  by: DocIdSchema,
  at: InstantSchema,
});
export type ClerkFeedback = z.infer<typeof ClerkFeedbackSchema>;

/** A read-only tool Clerk ran while answering (AI-06): shown as "Searching documents…". */
export const ClerkToolCallSchema = z.object({
  id: z.string().max(100).optional(),
  name: z.string(),
  status: z.enum(['running', 'done', 'error']),
});

export const ClerkMessage = withMeta(
  {
    role: z.enum(['user', 'assistant']),
    content: z.array(ContentBlockSchema),
    citations: z.array(CitationSchema).default([]),
    /**
     * `streaming` until the run finishes. `refused` (shown honestly), `truncated` (hit max tokens;
     * disclosed), `invalid_output` (a structured reply failed validation; never retried blindly),
     * `error` keeps any partial text and says why in `error`.
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
    toolCalls: z.array(ClerkToolCallSchema).default([]),
    /** `id@version` of the prompt template (AI-02). */
    promptId: z.string().optional(),
    /** The model that produced the reply (a fallback model when `fallbackUsed`). */
    model: z.string().optional(),
    fallbackUsed: z.boolean().optional(),
    /** The sources Clerk was given for this reply (AI-03), for audit. */
    manifest: ContextManifestSchema.optional(),
    /** The reply drew on privileged material (AI-03, Clerk rule 6). Always stored, so the rules can test it. */
    privileged: z.boolean().default(false),
    /** An assistant message: the user message it answers (a retry answers the same one again, AI-06). */
    replyTo: DocIdSchema.optional(),
    /** A user message: the documents attached to the question (AI-06). */
    attachments: z.array(DocIdSchema).max(10).optional(),
    /** Suggestions (AI-07) proposed with this answer. */
    suggestionIds: z.array(DocIdSchema).default([]),
    feedback: ClerkFeedbackSchema.optional(),
    /** Why an answer failed (`status: error`): an error code, and the switch for CLERK_DISABLED. */
    error: z.object({ code: z.string().max(60), switch: z.string().max(100).optional() }).optional(),
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
      'replyTo',
      'suggestionIds',
      'feedback',
      'error',
    ],
    updatable: ['stopRequested'],
  },
);

export type ClerkThread = z.infer<typeof ClerkThread.schema>;
export type ClerkMessage = z.infer<typeof ClerkMessage.schema>;
