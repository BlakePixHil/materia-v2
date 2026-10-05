import * as z from 'zod';

import {
  ActorSchema,
  CentsSchema,
  DateOnlySchema,
  DocIdSchema,
  InstantSchema,
  NonEmptyString,
  SearchTokensSchema,
  withMeta,
} from './common';
import {
  DeadlineKindSchema,
  DeadlineStatusSchema,
  DocumentCategorySchema,
  DocumentSourceSchema,
  EventKindSchema,
  GstTreatmentSchema,
  PartyRoleSchema,
  PrioritySchema,
  TaskStatusSchema,
  TimeEntryStatusSchema,
} from './enums';
import { MinutesSchema } from '../values/minutes';

const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Expected HH:MM (24h)' });
const MATTER = 'orgs/{orgId}/matters/{matterId}';

/** Collection-group-queried docs carry orgId and matterId (Domain doc, Indexes rule). */
const GroupKeys = { orgId: DocIdSchema, matterId: DocIdSchema };

export const Party = withMeta(
  {
    contactId: DocIdSchema,
    role: PartyRoleSchema,
    share: z.string().optional(),
    notes: z.string().optional(),
    addedFrom: z.enum(['manual', 'clerk', 'migration']).default('manual'),
    // Queried across matters by contact ("the matters this contact is on", CORE-01).
    ...GroupKeys,
  },
  {
    path: `${MATTER}/parties`,
    softDelete: true,
    serverOwned: ['orgId', 'matterId'],
    // The row id is `partyDocId(role, contactId)` and the matter's `clientContactIds` follows the
    // client rows, so contact, role and removal go through `matters-upsertParty`/`removeParty` (CORE-06).
    updatable: ['share', 'notes'],
  },
);

/** Limits the rules enforce on client-written tasks (CORE-08). */
export const TASK_TITLE_MAX = 500;
export const TASK_GROUP_MAX = 120;
export const TASK_CHECKLIST_MAX = 100;

/** A checklist item inside a task (CORE-08), ticked inline. */
export const ChecklistItemSchema = z.object({ id: z.string().min(1), text: z.string().max(500), done: z.boolean() });
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

const taskShape = {
  title: NonEmptyString.max(TASK_TITLE_MAX),
  descriptionMd: z.string().optional(),
  status: TaskStatusSchema,
  priority: PrioritySchema.default('none'),
  assigneeUid: DocIdSchema.optional(),
  dueDate: DateOnlySchema.optional(),
  deadlineId: DocIdSchema.optional(),
  group: z.string().max(TASK_GROUP_MAX).optional(),
  checklist: z.array(ChecklistItemSchema).max(TASK_CHECKLIST_MAX).default([]),
  /** Fractional sort key (CORE-08): a move writes the midpoint of its neighbours (`orderBetween`). */
  order: z.number(),
  /** `rule`: created by a deadline rule's `createsTask` (CORE-10), linked by `deadlineId`. */
  source: z.enum(['manual', 'template', 'clerk', 'migration', 'rule']).default('manual'),
  /** Set by `tasks-onWrite` when the status becomes `done`, removed when the task is reopened. */
  completedAt: InstantSchema.optional(),
  /** The due date its reminder went out for (`reminders-dispatch`, CORE-11): one per due date. */
  reminderSentFor: DateOnlySchema.optional(),
  /** Title tokens for ⌘K (CORE-15), kept by `tasks-onWrite`/`tasks-onPersonalWrite`; empty until then. */
  search: SearchTokensSchema.default([]),
};

/**
 * The fields clients change directly (CORE-08): title, status, priority, assignee, due date,
 * checklist, order and group, plus soft delete. The description, deadline link and source are set
 * when the task is created.
 */
const TASK_UPDATABLE = [
  'title',
  'status',
  'priority',
  'assigneeUid',
  'dueDate',
  'checklist',
  'order',
  'group',
] as const;

/**
 * `matters/{matterId}/tasks/{taskId}`. Template tasks (CORE-07) have the id `tpl-{templateTaskKey}`
 * (one per matter and template task) and, while their anchor event is unknown, no `dueDate` and
 * `duePending` naming the event ("due date pending: date of death unknown"). `countedOpen` records
 * whether the task is counted in the matter's `openTaskCount` (server-owned, CORE-08): `tasks-onWrite`
 * reconciles it, and a server writer that counts a task itself sets it to `true`.
 */
export const Task = withMeta(
  {
    ...taskShape,
    ...GroupKeys,
    templateTaskKey: z.string().optional(),
    duePending: EventKindSchema.optional(),
    countedOpen: z.boolean().optional(),
  },
  {
    path: `${MATTER}/tasks`,
    softDelete: true,
    serverOwned: [
      'orgId',
      'matterId',
      'completedAt',
      'reminderSentFor',
      'templateTaskKey',
      'duePending',
      'countedOpen',
      'search',
    ],
    updatable: TASK_UPDATABLE,
  },
);

/**
 * `orgs/{orgId}/members/{uid}/tasks/{taskId}`: personal tasks, private to their member (even admins
 * can't read them). Same shape as matter tasks with `matterId: null` (the `tasks` collection group
 * holds both) and `assigneeUid` always the owner, so "assigned to me" finds them too.
 */
export const PersonalTask = withMeta(
  { ...taskShape, orgId: DocIdSchema, matterId: z.null().default(null) },
  {
    path: 'orgs/{orgId}/members/{uid}/tasks',
    softDelete: true,
    serverOwned: ['orgId', 'matterId', 'completedAt', 'reminderSentFor', 'search'],
    updatable: TASK_UPDATABLE,
  },
);

/**
 * `matters/{matterId}/events/{eventId}`: key facts that drive deadlines. Written only through the
 * `deadlines-upsertEvent` and `deadlines-deleteEvent` callables (CORE-10), which recompute the
 * matter's deadlines in the same transaction; clients read them.
 */
export const MatterEvent = withMeta(
  {
    kind: EventKindSchema,
    date: DateOnlySchema,
    time: TimeOfDay.optional(),
    label: z.string().max(200).optional(),
    meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
    sourceDocumentId: DocIdSchema.optional(),
  },
  { path: `${MATTER}/events`, softDelete: true, updatable: [] },
);

/** Why a deadline has no date yet (CORE-10): its anchor event, calendar data, or a bad input. */
export const DeadlineBlockedCodeSchema = z.enum(['anchor_missing', 'calendar_missing', 'invalid_input']);
export type DeadlineBlockedCode = z.infer<typeof DeadlineBlockedCodeSchema>;

/**
 * A computed deadline's provenance (ADR-009): the rule, its rule-set version and citation, the
 * anchor event, the inputs and the rendered trace. `dueDate` is the engine's latest date, which
 * differs from the deadline's `dueDate` while an override stands.
 */
export const ComputedSchema = z.object({
  ruleId: NonEmptyString,
  ruleSetId: NonEmptyString,
  ruleSetVersion: z.number().int().min(1),
  /** Absent for composite rules and for a rule blocked on a missing anchor. */
  anchorEventId: DocIdSchema.optional(),
  inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  trace: z.array(z.string()),
  citation: z.string().optional(),
  /** The rule's plain-language explanation. */
  explain: z.string().optional(),
  dueDate: DateOnlySchema.optional(),
  /** Computed from an approximate anchor (the earliest possible date). */
  approximate: z.boolean().optional(),
  /** The rule is marked `verify` in its rule set: it needs particular practitioner attention. */
  verify: z.boolean().optional(),
});
export type DeadlineComputed = z.infer<typeof ComputedSchema>;

/** Limits on client-entered (manual) deadlines (CORE-10); the rules enforce them too. */
export const DEADLINE_TITLE_MAX = 300;
export const DEADLINE_REMINDERS_MAX = 10;
/** At most this many people are told of one escalation (the supervisor and the admins). */
export const DEADLINE_ESCALATION_RECIPIENTS_MAX = 50;
export const DEADLINE_REASON_MAX = 1000;

/**
 * `matters/{matterId}/deadlines/{deadlineId}`. Every computed deadline records its rule (ADR-009).
 *
 * Computed deadlines (`computed` set, id `rule-{ruleId}`) are written by the recompute (CORE-10);
 * clients change only their assignee and acknowledgement. Manual ones (no `computed`; kind
 * contractual, internal or court) are created and edited by clients directly. Status changes go
 * through `deadlines-complete` (done, waived, missed), `deadlines-override` and
 * `deadlines-resolveChange`. `dueDate` is the date in force (the override when there is one) and
 * is absent only while `status` is `blocked`.
 */
export const Deadline = withMeta(
  {
    ...GroupKeys,
    title: NonEmptyString.max(DEADLINE_TITLE_MAX),
    dueDate: DateOnlySchema.optional(),
    dueTime: TimeOfDay.optional(),
    kind: DeadlineKindSchema,
    critical: z.boolean(),
    status: DeadlineStatusSchema,
    blockedReason: z.string().optional(),
    blockedCode: DeadlineBlockedCodeSchema.optional(),
    computed: ComputedSchema.optional(),
    override: z
      .object({ dueDate: DateOnlySchema, reason: NonEmptyString, by: DocIdSchema, at: InstantSchema })
      .optional(),
    /** The engine's date is now earlier than the override (CORE-10): the deadline is flagged. */
    overrideConflict: z.boolean().optional(),
    /** The proposal the responsible lawyer last rejected: the same proposal isn't made again. */
    declined: z
      .object({
        kind: z.enum(['moved', 'removed']),
        dueDate: DateOnlySchema.optional(),
        by: DocIdSchema,
        at: InstantSchema,
      })
      .optional(),
    /** How a done, waived or missed deadline was closed (`deadlines-complete`). */
    resolution: z
      .object({
        on: DateOnlySchema,
        by: z.string().min(1),
        at: InstantSchema,
        reason: z.string().max(DEADLINE_REASON_MAX).optional(),
      })
      .optional(),
    /** Set by the daily missed check: past its date, waiting for a person to confirm it missed. */
    missedCheck: z.object({ since: DateOnlySchema, at: InstantSchema }).optional(),
    /** The task its rule created (`createsTask`), which links back with `deadlineId`. */
    taskId: DocIdSchema.optional(),
    reminders: z
      .array(z.object({ offsetDays: z.number().int(), sentAt: InstantSchema.optional() }))
      .max(DEADLINE_REMINDERS_MAX)
      .default([]),
    assigneeUid: DocIdSchema,
    calendar: z
      .record(
        z.string(),
        z.object({ provider: z.enum(['microsoft', 'google']), eventId: z.string(), etag: z.string() }),
      )
      .optional(),
    nextReminderAt: InstantSchema.optional(),
    ackBy: DocIdSchema.optional(),
    ackAt: InstantSchema.optional(),
    /** When `reminders-dispatch` escalated it (CORE-11), and to whom; cleared when the date moves. */
    escalatedAt: InstantSchema.optional(),
    escalatedTo: z.array(DocIdSchema).max(DEADLINE_ESCALATION_RECIPIENTS_MAX).optional(),
    /** Already past when computed: in the review queue, never marked missed automatically. */
    pastOnCreation: z.boolean().default(false),
  },
  {
    path: `${MATTER}/deadlines`,
    softDelete: true,
    serverOwned: [
      'orgId',
      'matterId',
      'status',
      'blockedReason',
      'blockedCode',
      'computed',
      'override',
      'overrideConflict',
      'declined',
      'resolution',
      'missedCheck',
      'taskId',
      'calendar',
      'nextReminderAt',
      'escalatedAt',
      'escalatedTo',
      'pastOnCreation',
    ],
    // Manual deadlines change these; computed ones only assigneeUid, ackBy and ackAt (the rules).
    updatable: ['title', 'dueDate', 'dueTime', 'kind', 'critical', 'assigneeUid', 'reminders', 'ackBy', 'ackAt'],
  },
);

export const DeadlineChangeStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'superseded']);
export type DeadlineChangeStatus = z.infer<typeof DeadlineChangeStatusSchema>;
export const DeadlineChangeKindSchema = z.enum(['moved', 'removed']);
export type DeadlineChangeKind = z.infer<typeof DeadlineChangeKindSchema>;
/** What made the recompute that proposed a change. */
export const DeadlineChangeCauseSchema = z.enum(['event', 'stage', 'recompute', 'ruleset_upgrade', 'matter_created']);
export type DeadlineChangeCause = z.infer<typeof DeadlineChangeCauseSchema>;

/**
 * `matters/{matterId}/deadlineChanges/{changeId}` (CORE-10): a recompute's proposal for an upcoming
 * computed deadline, never a silent change. `moved` proposes `toDueDate` (with its provenance in
 * `computed`); `removed` proposes marking the deadline superseded (its anchor was deleted or its
 * rule no longer applies). Decided through `deadlines-resolveChange`; a later recompute supersedes
 * a pending proposal that no longer holds. Written by functions only; members read them.
 */
export const DeadlineChange = withMeta(
  {
    ...GroupKeys,
    deadlineId: DocIdSchema,
    ruleId: NonEmptyString,
    title: NonEmptyString,
    critical: z.boolean(),
    kind: DeadlineChangeKindSchema,
    cause: DeadlineChangeCauseSchema,
    status: DeadlineChangeStatusSchema,
    fromDueDate: DateOnlySchema,
    toDueDate: DateOnlySchema.optional(),
    /** The new date is earlier than the current one. */
    earlier: z.boolean(),
    /** The new date has already passed (critical: high-priority notification and a red banner). */
    intoPast: z.boolean(),
    /** Why a `removed` proposal: the engine's reason ("No grant yet"). */
    reason: z.string().optional(),
    computed: ComputedSchema.optional(),
    /** Who decides: the matter's responsible lawyer when it was proposed. */
    assigneeUid: DocIdSchema,
    recomputeVersion: z.number().int().min(0),
    resolvedBy: DocIdSchema.optional(),
    resolvedAt: InstantSchema.optional(),
  },
  {
    path: `${MATTER}/deadlineChanges`,
    migratable: false,
    serverOwned: [
      'orgId',
      'matterId',
      'deadlineId',
      'ruleId',
      'title',
      'critical',
      'kind',
      'cause',
      'status',
      'fromDueDate',
      'toDueDate',
      'earlier',
      'intoPast',
      'reason',
      'computed',
      'assigneeUid',
      'recomputeVersion',
      'resolvedBy',
      'resolvedAt',
    ],
    updatable: [],
  },
);

/** Limits on a matter document's metadata and history (CORE-12). The rules check the same values. */
export const DOCUMENT_NAME_MAX = 255;
export const DOCUMENT_TAG_MAX = 40;
export const DOCUMENT_TAGS_MAX = 20;
export const DOCUMENT_NOTES_MAX = 5000;
export const DOCUMENT_VERSIONS_MAX = 100;

/** A stored version: `orgs/{orgId}/matters/{matterId}/documents/{docId}/v{n}`. */
export const DocumentStoragePathSchema = z.string().regex(/^orgs\/[^/]+\/matters\/[^/]+\/documents\/[^/]+\/v\d+$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Derived files of one version (CORE-12), each a Storage path under
 * `documents/{docId}/renditions/v{n}/`: an Office document's PDF preview, a HEIC photo's JPEG, an
 * email's parsed headers, body and attachment list (JSON). Clients fetch them through
 * `documents-getDownloadUrl`.
 */
export const DocumentRenditionsSchema = z
  .object({ previewPdf: z.string().optional(), previewImage: z.string().optional(), message: z.string().optional() })
  .strict();
export type DocumentRenditions = z.infer<typeof DocumentRenditionsSchema>;

/** One clean version in a document's history (CORE-12). Versions are never edited or removed. */
export const DocumentVersionSchema = z
  .object({
    version: z.number().int().min(1),
    storagePath: DocumentStoragePathSchema,
    /** The file name it was uploaded with. */
    fileName: NonEmptyString.max(DOCUMENT_NAME_MAX),
    /** The type its content was verified as (magic bytes), not what the browser said. */
    mime: z.string().min(3),
    sizeBytes: z.number().int().min(0),
    sha256: Sha256Schema,
    uploadedAt: InstantSchema,
    uploadedBy: ActorSchema,
    /** The pending upload it came from (`pending/{uploadId}`), so a retried trigger adds it once. */
    uploadId: z.string().optional(),
    pageCount: z.number().int().min(0).optional(),
    /** A password-protected PDF: stored, but it can't be previewed or merged. */
    encrypted: z.boolean().optional(),
    /** `documents-restoreVersion` copied this version from an earlier one. */
    restoredFrom: z.number().int().min(1).optional(),
    renditions: DocumentRenditionsSchema.optional(),
  })
  .strict();
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;

/** Why an upload was refused before it became a version (CORE-12). */
export const DocumentUploadReasonSchema = z.enum([
  /** The extension isn't on the allow-list. */
  'type_not_allowed',
  /** The content isn't what the extension says (magic bytes). */
  'type_mismatch',
  /** The SHA-256 the client sent doesn't match the bytes received. */
  'hash_mismatch',
  'too_large',
  /** The uploader may not upload here (role, membership, privileged material). */
  'not_allowed',
  /** The document a new version was meant for is gone or not visible to the uploader. */
  'target_unavailable',
  /** The document already has the maximum number of versions. */
  'version_limit',
]);
export type DocumentUploadReason = z.infer<typeof DocumentUploadReasonSchema>;

/**
 * The document's latest upload while it is in the pipeline, or refused (CORE-12): `scanning`,
 * `delayed` (the scanner timed out or is down: the file stays quarantined and is retried, shown
 * as "Scanning delayed"), `infected` (deleted), `rejected` (`reason`) or `expired` (still
 * unscanned after 24 hours, deleted). Removed once the upload becomes a version.
 */
export const DocumentUploadSchema = z
  .object({
    uploadId: z.string().min(1),
    fileName: NonEmptyString.max(DOCUMENT_NAME_MAX),
    sizeBytes: z.number().int().min(0),
    uploadedBy: ActorSchema,
    at: InstantSchema,
    status: z.enum(['scanning', 'delayed', 'infected', 'rejected', 'expired']),
    attempts: z.number().int().min(0),
    reason: DocumentUploadReasonSchema.optional(),
    /** The version number reserved for it (once clean). */
    version: z.number().int().min(1).optional(),
  })
  .strict();
export type DocumentUpload = z.infer<typeof DocumentUploadSchema>;

/** Why a document wasn't ingested for Clerk (AI-04). */
export const IngestSkipReasonSchema = z.enum([
  /** Password-protected PDF. */
  'encrypted',
  /** A type Clerk doesn't read (spreadsheets, slides, archives, HEIC photos, legacy .doc). */
  'unsupported',
  /** No text, and no OCR could be done. */
  'empty',
  /** Every page needs OCR, and Clerk (which does the OCR) is off for the org. */
  'ocr_unavailable',
  /** The file couldn't be parsed. */
  'damaged',
]);
export type IngestSkipReason = z.infer<typeof IngestSkipReasonSchema>;

/**
 * Where a document is in Clerk's ingestion (AI-04): `pending` (waiting for the `documents-ingest`
 * task), `running`, `queued` (over the org's daily OCR page budget: resumes the next day, shown as
 * "Queued"), `done`, `failed` (`error`) or `skipped` (`reason`). Ingestion is idempotent by
 * `(docId, version)`: `version` is the document version the chunks were built from. `checkpoint`
 * lets a long PDF resume where it stopped (every 50 pages).
 */
export const DocumentIngestSchema = z.object({
  status: z.enum(['pending', 'running', 'queued', 'done', 'failed', 'skipped']),
  version: z.number().int().min(1).optional(),
  pages: z.number().int().min(0).optional(),
  /** Pages read by OCR (no text layer). */
  ocrPages: z.number().int().min(0).optional(),
  /** Whether any page was read by OCR. */
  ocr: z.boolean().optional(),
  /** Pages the OCR model flagged as hard to read (handwriting, poor scans). */
  lowConfidencePages: z.array(z.number().int().min(1)).max(1000).optional(),
  /** Pages that needed OCR but got none (Clerk off for the org): ingested without them. */
  ocrUnavailablePages: z.number().int().min(0).optional(),
  chars: z.number().int().min(0).optional(),
  chunks: z.number().int().min(0).optional(),
  /** ISO 639-1 language when it isn't English (`und` when unknown); absent for English. */
  language: z.string().min(2).max(8).optional(),
  reason: IngestSkipReasonSchema.optional(),
  error: z.string().max(200).optional(),
  /** Resume point: the next page to read and the next chunk ordinal. */
  checkpoint: z.object({ nextPage: z.number().int().min(1), nextOrdinal: z.number().int().min(0) }).optional(),
  /** When a `queued` document resumes. */
  queuedUntil: InstantSchema.optional(),
  at: InstantSchema.optional(),
});
export type DocumentIngest = z.infer<typeof DocumentIngestSchema>;

/**
 * `matters/{matterId}/documents/{docId}` (CORE-12). Created by `documents-onUpload` when an upload
 * arrives, with `scan.status: 'pending'` and no version; each clean upload appends to `versions`,
 * and the top-level `storagePath`, `mime`, `sizeBytes`, `sha256`, `version`, `pageCount`,
 * `encrypted` and `renditions` mirror the current one. `scan` is the current content's status
 * (`infected` only when the first upload was infected and nothing was stored). Clients edit the
 * name, category, privileged flag, tags and notes, and soft delete; everything else is
 * server-owned. A soft-deleted document stays readable so citations resolve ("Removed document").
 */
export const MatterDocument = withMeta(
  {
    ...GroupKeys,
    name: NonEmptyString.max(DOCUMENT_NAME_MAX),
    category: DocumentCategorySchema,
    privileged: z.boolean().default(false),
    tags: z.array(NonEmptyString.max(DOCUMENT_TAG_MAX)).max(DOCUMENT_TAGS_MAX).default([]),
    notes: z.string().max(DOCUMENT_NOTES_MAX).optional(),
    storagePath: DocumentStoragePathSchema.optional(),
    mime: z.string().min(3).optional(),
    sizeBytes: z.number().int().min(0).optional(),
    sha256: Sha256Schema.optional(),
    /** The current version's number; 0 until the first clean upload. */
    version: z.number().int().min(0),
    /** The highest version number reserved so far (numbers are never reused; a crash can skip one). */
    versionSeq: z.number().int().min(0).optional(),
    versions: z.array(DocumentVersionSchema).max(DOCUMENT_VERSIONS_MAX).default([]),
    scan: z.object({ status: z.enum(['pending', 'clean', 'infected', 'error']), at: InstantSchema.optional() }),
    upload: DocumentUploadSchema.optional(),
    /** Another live document in the matter with the same content: the UI offers keep both or discard. */
    duplicateOf: DocIdSchema.optional(),
    ingest: DocumentIngestSchema,
    source: DocumentSourceSchema,
    pageCount: z.number().int().optional(),
    encrypted: z.boolean().default(false),
    accessRestricted: z.boolean().default(false),
    renditions: DocumentRenditionsSchema.optional(),
    /** Name tokens for ⌘K (CORE-15), kept by `documents-onWrite`; empty until then. */
    search: SearchTokensSchema.default([]),
  },
  {
    path: `${MATTER}/documents`,
    softDelete: true,
    serverOwned: [
      'orgId',
      'matterId',
      'storagePath',
      'mime',
      'sha256',
      'sizeBytes',
      'version',
      'versionSeq',
      'versions',
      'scan',
      'upload',
      'duplicateOf',
      'ingest',
      'source',
      'renditions',
      'pageCount',
      'encrypted',
      'search',
    ],
    updatable: ['name', 'category', 'privileged', 'accessRestricted', 'tags', 'notes'],
  },
);

/**
 * `matters/{matterId}/documentHashes/{sha256}`: server-only index of the matter's content hashes
 * (CORE-12). `documents-onUpload` reads and writes it in the transaction that adds a first version,
 * so two uploads of the same file, even at the same moment, can't both be the original: the
 * second is marked `duplicateOf` the first.
 */
export const DocumentHash = withMeta(
  { documentId: DocIdSchema },
  { path: `${MATTER}/documentHashes`, migratable: false, updatable: [] },
);

/** The embedding size of every chunk (ADR-012: Vertex AI text embeddings at 768 dimensions). */
export const CHUNK_EMBEDDING_DIMENSIONS = 768;

/**
 * `documents/{docId}/chunks/{n}` (AI-04): one passage of a document version, never crossing a
 * page, with its embedding. `n` is the zero-padded `ordinal`. `orgId`, `matterId` and
 * `privileged` are the vector index's pre-filters, so `privileged` follows the document (a
 * trigger). Written by functions only; old versions' chunks are deleted on re-ingest.
 */
export const Chunk = withMeta(
  {
    ...GroupKeys,
    text: z.string(),
    page: z.number().int().min(1),
    /** The document version the text came from (citations pin it). */
    docVersion: z.number().int().min(1),
    /** Position in the document version, from 0. */
    ordinal: z.number().int().min(0),
    privileged: z.boolean(),
    /** The page was read by OCR. */
    ocr: z.boolean().optional(),
    // Vector(768) in Firestore; a number array in the domain model (ADR-012).
    embedding: z.array(z.number()).length(CHUNK_EMBEDDING_DIMENSIONS),
  },
  { path: `${MATTER}/documents/{docId}/chunks`, migratable: false },
);

/** The longest note (CORE-13): 100 KB of Markdown. */
export const NOTE_BODY_MAX = 100_000;

/**
 * `matters/{matterId}/notes/{noteId}` (CORE-13). Mentions are `@[uid]` and `#[matterId]` tokens,
 * parsed server-side into `mentions`. Text and the privileged flag change only through
 * `notes-create`/`notes-update`, which stamp `editedAt`/`editedBy` on edits and keep the previous
 * text in `revisions`; clients pin, delete and restore directly. `legacyAuthor` names a migrated
 * note's author who isn't a member.
 */
export const Note = withMeta(
  {
    bodyMd: z.string().max(NOTE_BODY_MAX),
    mentions: z.object({ uids: z.array(DocIdSchema), matterIds: z.array(DocIdSchema) }),
    pinned: z.boolean().default(false),
    privileged: z.boolean().default(false),
    source: z.enum(['manual', 'clerk', 'migration', 'voice']).default('manual'),
    editedAt: InstantSchema.optional(),
    editedBy: z.string().optional(),
    legacyAuthor: z.string().max(200).optional(),
  },
  {
    path: `${MATTER}/notes`,
    softDelete: true,
    serverOwned: ['mentions', 'editedAt', 'editedBy'],
    updatable: ['pinned'],
  },
);

/**
 * `notes/{noteId}/revisions/{id}` (CORE-13): an earlier version of a note's text, appended by
 * `notes-update` before each edit. `editedAt`/`editedBy` say who wrote that version and when.
 */
export const NoteRevision = withMeta(
  {
    bodyMd: z.string().max(NOTE_BODY_MAX),
    privileged: z.boolean(),
    editedAt: InstantSchema,
    editedBy: z.string(),
  },
  { path: `${MATTER}/notes/{noteId}/revisions`, migratable: false, updatable: [] },
);

/** `matters/{matterId}/activity/{id}`: the feed's read model, written by triggers. */
export const Activity = withMeta(
  {
    kind: NonEmptyString,
    summary: z.string(),
    actorUid: z.string(),
    at: InstantSchema,
    refs: z.record(z.string(), z.string()).default({}),
  },
  { path: `${MATTER}/activity`, migratable: false },
);

/** Limits the rules enforce on client-written time entries (BILL-01). */
export const TIME_NARRATIVE_MAX = 2000;
/** One entry's sanity cap: 100 hours. Over 24 hours on a day only warns (BILL-01). */
export const TIME_ENTRY_MAX_MINUTES = 6000;

/**
 * `matters/{matterId}/timeEntries/{id}` (BILL-01). Drafts are written client-direct; `time-onWrite`
 * recomputes `units`, `rateCents` and `amountCents` from the rate in force on `date` (never trusting
 * the client's values) and keeps the matter's `wipCents`. Status changes go through `time-setStatus`.
 */
export const TimeEntry = withMeta(
  {
    ...GroupKeys,
    uid: DocIdSchema,
    date: DateOnlySchema,
    minutes: MinutesSchema,
    units: z.number().int().min(0),
    rateCents: CentsSchema,
    amountCents: CentsSchema,
    narrative: z.string().max(TIME_NARRATIVE_MAX),
    billable: z.boolean(),
    status: TimeEntryStatusSchema,
    invoiceId: DocIdSchema.optional(),
    source: z.enum(['manual', 'timer', 'voice', 'clerk', 'migration']).default('manual'),
    taskId: DocIdSchema.optional(),
    writeDown: z
      .object({
        originalUnits: z.number().int(),
        originalAmountCents: CentsSchema,
        by: DocIdSchema,
        reason: z.string(),
      })
      .optional(),
    /** What this entry adds to the matter's `wipCents` right now; kept by `time-onWrite`. */
    wipCountedCents: CentsSchema.default(0 as never),
  },
  {
    path: `${MATTER}/timeEntries`,
    softDelete: true,
    serverOwned: ['orgId', 'matterId', 'invoiceId', 'writeDown', 'wipCountedCents'],
    // `units`, `rateCents` and `amountCents` are the client's preview, recomputed by the trigger.
    // The author (`uid`) is fixed, and the status moves only through `time-setStatus` (and invoicing).
    updatable: ['date', 'minutes', 'units', 'rateCents', 'amountCents', 'narrative', 'billable', 'taskId'],
  },
);

/** `matters/{matterId}/disbursements/{id}`. */
export const Disbursement = withMeta(
  {
    date: DateOnlySchema,
    description: NonEmptyString,
    amountExGstCents: CentsSchema,
    gstCents: CentsSchema,
    gstTreatment: GstTreatmentSchema,
    payee: z.string(),
    receiptDocumentId: DocIdSchema.optional(),
    status: z.enum(['draft', 'final', 'billed', 'written_off']),
    invoiceId: DocIdSchema.optional(),
  },
  { path: `${MATTER}/disbursements`, softDelete: true, serverOwned: ['gstCents', 'invoiceId'] },
);

/** `matters/{matterId}/assets/{id}`: the estate register. */
export const Asset = withMeta(
  {
    class: z.enum([
      'real_property',
      'bank',
      'shares',
      'superannuation',
      'insurance',
      'vehicle',
      'personal',
      'business',
      'debt_owed_to_estate',
      'other',
    ]),
    description: NonEmptyString,
    valueAtDeathCents: CentsSchema,
    valuationSource: z.string(),
    jointlyHeld: z.boolean(),
    passesOutsideEstate: z.boolean(),
    status: z.enum(['identified', 'valued', 'realised', 'transferred']),
    realisedCents: CentsSchema.optional(),
  },
  { path: `${MATTER}/assets`, softDelete: true },
);

export const Liability = withMeta(
  {
    class: z.enum(['mortgage', 'credit_card', 'loan', 'tax', 'funeral', 'medical', 'utility', 'other']),
    creditor: NonEmptyString,
    amountCents: CentsSchema,
    status: z.enum(['notified', 'paid', 'disputed']),
  },
  { path: `${MATTER}/liabilities`, softDelete: true },
);

export const Distribution = withMeta(
  {
    beneficiaryPartyId: DocIdSchema,
    kind: z.enum(['specific', 'pecuniary', 'residuary']),
    amountCents: CentsSchema.optional(),
    assetId: DocIdSchema.optional(),
    status: z.enum(['planned', 'approved', 'paid', 'cancelled']),
    paidOn: DateOnlySchema.optional(),
  },
  { path: `${MATTER}/distributions`, softDelete: true },
);

export type Party = z.infer<typeof Party.schema>;
export type Task = z.infer<typeof Task.schema>;
export type PersonalTask = z.infer<typeof PersonalTask.schema>;
export type MatterEvent = z.infer<typeof MatterEvent.schema>;
export type Deadline = z.infer<typeof Deadline.schema>;
export type DeadlineChange = z.infer<typeof DeadlineChange.schema>;
export type MatterDocument = z.infer<typeof MatterDocument.schema>;
export type DocumentHash = z.infer<typeof DocumentHash.schema>;
export type Chunk = z.infer<typeof Chunk.schema>;
export type Note = z.infer<typeof Note.schema>;
export type Activity = z.infer<typeof Activity.schema>;
export type NoteRevision = z.infer<typeof NoteRevision.schema>;
export type TimeEntry = z.infer<typeof TimeEntry.schema>;
export type Disbursement = z.infer<typeof Disbursement.schema>;
export type Asset = z.infer<typeof Asset.schema>;
export type Liability = z.infer<typeof Liability.schema>;
export type Distribution = z.infer<typeof Distribution.schema>;
