import * as z from 'zod';

import { DocIdSchema, InstantSchema, NonEmptyString, withMeta } from './schemas/common';

/**
 * Data rights (SEC-05, ADR-058): the owner's full export of the practice, member offboarding,
 * deleting the practice after a 30-day grace period (blocked by legal holds and running exports),
 * the tombstone and certificate a deletion leaves, and deleting an account that has no practice.
 */

// ---------- the full export ----------

/** `exports-orgFull` (owner, recent sign-in): everything the practice holds, as portable JSON and files. */
export const ORG_EXPORT_CALLABLE = 'exports-orgFull';
/** The Cloud Tasks queue that writes it, one part per task. */
export const ORG_EXPORT_QUEUE = 'exports-runOrgFull';
/** The export's format, in `manifest.json` (`format` and `version`). */
export const ORG_EXPORT_FORMAT = 'materia.org-export';
export const ORG_EXPORT_FORMAT_VERSION = 1;
/** The largest zip a part may be: exports over it are split into several zips (10 GB). */
export const ORG_EXPORT_PART_BYTES = 10 * 1024 ** 3;
/** The largest single JSONL file: a bigger collection continues in `name.2.jsonl`, `name.3.jsonl`… */
export const ORG_EXPORT_DATA_FILE_BYTES = 1024 ** 3;

export const OrgExportInput = z.object({
  requestId: z.uuid(),
  /** Every version of each document, not only the current one. */
  allVersions: z.boolean().default(false),
  /** The owner read that privileged material is in the export (it belongs to the practice). */
  acknowledgePrivileged: z.literal(true),
});
export type OrgExportInput = z.input<typeof OrgExportInput>;

export interface OrgExportResult {
  jobId: string;
  status: 'queued';
}

/** What an `org.export` job's `input` holds. */
export const OrgExportJobInputSchema = z.object({
  allVersions: z.boolean(),
  /** The part size (ORG_EXPORT_PART_BYTES; tests use a tiny one). */
  partBytes: z.number().int().min(1),
});
export type OrgExportJobInput = z.infer<typeof OrgExportJobInputSchema>;

/**
 * Collections not in the export: OAuth tokens and connect attempts (secrets, useless outside
 * Materia), invites (token hashes, gone in 7 days), export jobs, and Clerk's search chunks (the
 * document text again, cut up for retrieval: the documents themselves are in `files/`).
 */
export const ORG_EXPORT_EXCLUDED = [
  'integrations',
  'integrationStates',
  'invites',
  'jobs',
  'matters.documents.chunks',
] as const;

/**
 * The export's name for a collection, from its entity path (`orgs/{orgId}/matters/{matterId}/tasks`
 * → `matters.tasks`, the org document itself → `org`), or null for paths outside the org.
 */
export function exportCollectionName(entityPath: string): string | null {
  if (entityPath === 'orgs') return 'org';
  if (!entityPath.startsWith('orgs/{orgId}/')) return null;
  return entityPath
    .slice('orgs/{orgId}/'.length)
    .split('/')
    .filter((segment) => !segment.startsWith('{'))
    .join('.');
}

/** The JSONL file for one collection (`data/matters.tasks.jsonl`, then `data/matters.tasks.2.jsonl`). */
export function exportDataFileName(collection: string, file = 1): string {
  return file === 1 ? `data/${collection}.jsonl` : `data/${collection}.${file}.jsonl`;
}

/**
 * A part's download name: "Harbour & Vine Legal export 2026-10-07.zip", "(part 2 of 3)", or
 * "(part 2)" while the number of parts isn't known yet.
 */
export function orgExportFileName(orgName: string, day: string, part: number, parts?: number): string {
  const base =
    `${orgName} export ${day}`
      .replace(/[^\p{L}\p{N} &_-]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Export';
  if (parts !== undefined) return parts > 1 ? `${base} (part ${part} of ${parts}).zip` : `${base}.zip`;
  return part > 1 ? `${base} (part ${part}).zip` : `${base}.zip`;
}

/** Where a part is kept for 7 days: `orgs/{orgId}/exports/{jobId}.zip`, then `{jobId}.part-2.zip`… */
export function orgExportPartPath(orgId: string, jobId: string, part: number): string {
  return part === 1 ? `orgs/${orgId}/exports/${jobId}.zip` : `orgs/${orgId}/exports/${jobId}.part-${part}.zip`;
}

/** One file in the export, with its checksum (`manifest.json`). */
export const OrgExportEntrySchema = z.object({
  /** The path inside the zip (`data/matters.jsonl`, `files/matters/m1/documents/d1/v2/Will.pdf`). */
  path: z.string().min(1),
  /** The zip it is in (1-based). */
  part: z.number().int().min(1),
  kind: z.enum(['data', 'file', 'schema', 'readme']),
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Data files: the collection and how many records. */
  collection: z.string().optional(),
  records: z.number().int().min(0).optional(),
  /** Files: the Storage object and, for a matter document, which document and version. */
  storagePath: z.string().optional(),
  matterId: z.string().optional(),
  documentId: z.string().optional(),
  version: z.number().int().min(1).optional(),
});
export type OrgExportEntry = z.infer<typeof OrgExportEntrySchema>;

export const OrgExportManifestSchema = z.object({
  format: z.literal(ORG_EXPORT_FORMAT),
  version: z.literal(ORG_EXPORT_FORMAT_VERSION),
  orgId: z.string().min(1),
  orgName: z.string(),
  /** ISO 8601. */
  createdAt: z.string(),
  createdBy: z.string().min(1),
  allVersions: z.boolean(),
  parts: z.number().int().min(1),
  /** Collections and how many records each holds (all their JSONL files together). */
  collections: z.record(z.string(), z.number().int().min(0)),
  entries: z.array(OrgExportEntrySchema),
});
export type OrgExportManifest = z.infer<typeof OrgExportManifestSchema>;

// ---------- portable JSON ----------

/**
 * A JSON value as the export writes it. Values JSON can't hold are tagged objects with one key:
 * `{"$date": "2026-10-07T01:02:03.000Z"}` (an instant), `{"$ref": "matters/m1"}` (a document
 * reference, relative to the practice), `{"$bytes": "<base64>"}`, `{"$geo": [lat, lng]}`,
 * `{"$vector": [...]}` and `{"$number": "NaN"}`.
 */
export type PortableJson = null | boolean | number | string | PortableJson[] | { [key: string]: PortableJson };

const TAGS = ['$date', '$ref', '$bytes', '$geo', '$vector', '$number'] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

/** A value as portable JSON: Dates tagged, `undefined` fields dropped, bytes as base64. */
export function toPortable(value: unknown): PortableJson {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return { $date: value.toISOString() };
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $number: String(value) };
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Uint8Array) return { $bytes: bytesToBase64(value) };
  if (Array.isArray(value)) return value.map(toPortable);
  if (isPlainObject(value)) {
    const out: Record<string, PortableJson> = {};
    for (const [key, inner] of Object.entries(value)) if (inner !== undefined) out[key] = toPortable(inner);
    return out;
  }
  return null;
}

/** Portable JSON back to values: `$date` becomes a Date and `$number` a number; other tags stay as they are. */
export function fromPortable(value: PortableJson): unknown {
  if (Array.isArray(value)) return value.map(fromPortable);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && (TAGS as readonly string[]).includes(keys[0] as string)) {
      if ('$date' in value && typeof value['$date'] === 'string') return new Date(value['$date']);
      if ('$number' in value && typeof value['$number'] === 'string') return Number(value['$number']);
      return value;
    }
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fromPortable(inner)]));
  }
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** One JSONL line: the record's path inside the practice, its id and its fields. */
export interface OrgExportRecord {
  /** `matters/m1/tasks/t1` (relative to the practice; the practice itself is ``). */
  path: string;
  id: string;
  data: PortableJson;
}

// ---------- deleting the practice ----------

/** Days between asking to delete a practice and its deletion. */
export const ORG_DELETION_GRACE_DAYS = 30;

export const ORG_DELETION_CALLABLES = {
  request: 'orgs-requestDeletion',
  cancel: 'orgs-cancelDeletion',
} as const;

export const RequestOrgDeletionInput = z.object({
  requestId: z.uuid(),
  /** The practice's name, typed by the owner. */
  confirmation: z.string().trim().min(1).max(200),
});
export type RequestOrgDeletionInput = z.input<typeof RequestOrgDeletionInput>;

export const CancelOrgDeletionInput = z.object({ requestId: z.uuid() });
export type CancelOrgDeletionInput = z.input<typeof CancelOrgDeletionInput>;

export interface RequestOrgDeletionResult {
  /** ISO 8601. */
  deletionScheduledAt: string;
}

/** When a practice asked to be deleted at `at` is deleted. */
export function orgDeletionDate(at: Date): Date {
  return new Date(at.getTime() + ORG_DELETION_GRACE_DAYS * 86_400_000);
}

/** Whether the typed confirmation is the practice's name (case, spacing and curly quotes aside). */
export function confirmsOrgName(typed: string, name: string): boolean {
  const norm = (text: string) =>
    text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(typed).length > 0 && norm(typed) === norm(name);
}

/** What stops a practice being deleted (each a DomainError code with copy). */
export type OrgDeletionBlocker = 'LEGAL_HOLD' | 'EXPORT_RUNNING';

/**
 * Whether an export job still counts as running: queued or running, and heard from (`heartbeatAt`,
 * or `updatedAt`) within the last two hours. A job silent longer has died; it doesn't block.
 */
export const EXPORT_STALE_MS = 2 * 60 * 60 * 1000;
export function exportStillRunning(
  job: { status?: unknown; heartbeatAt?: Date | null; updatedAt?: Date | null },
  now: Date,
): boolean {
  if (job.status !== 'queued' && job.status !== 'running') return false;
  const last = job.heartbeatAt ?? job.updatedAt;
  return !last || now.getTime() - last.getTime() < EXPORT_STALE_MS;
}

/** The deletion job's steps, in order (ADR-058). */
export const ORG_PURGE_STAGES = [
  'marked',
  'integrations',
  'storage',
  'firestore',
  'users',
  'verified',
  'certificate',
] as const;
export const OrgPurgeStageSchema = z.enum(ORG_PURGE_STAGES);
export type OrgPurgeStage = z.infer<typeof OrgPurgeStageSchema>;

/** The Cloud Tasks queue that deletes a practice, a step per task. */
export const ORG_PURGE_QUEUE = 'orgs-purge';

export const OrgPurgeCountsSchema = z.object({
  /** Firestore documents deleted. */
  records: z.number().int().min(0),
  /** Stored files deleted (by name; every version of each). */
  files: z.number().int().min(0),
  /** Connections revoked with their provider. */
  integrations: z.number().int().min(0),
  /** People whose membership was removed. */
  members: z.number().int().min(0),
});
export type OrgPurgeCounts = z.infer<typeof OrgPurgeCountsSchema>;

/**
 * `deletedOrgs/{orgId}`: what is kept of a deleted practice (SEC-05): its id, name, when it was
 * deleted and its certificate. Server-only (the rules deny every client). Written when the
 * deletion starts (`purging`), so triggers leave the practice alone while it goes, and finished
 * with the certificate (`deleted`). `ownerUids` lets an owner fetch the certificate again.
 */
export const DeletedOrg = withMeta(
  () => ({
    orgId: DocIdSchema,
    name: NonEmptyString,
    status: z.enum(['purging', 'deleted']),
    stage: OrgPurgeStageSchema,
    requestedBy: DocIdSchema,
    /** Their name, for the certificate (their member document goes with the practice). */
    requestedByName: z.string().max(200).optional(),
    requestedAt: InstantSchema,
    scheduledFor: InstantSchema,
    purgeStartedAt: InstantSchema,
    deletedAt: InstantSchema.optional(),
    certificateId: NonEmptyString,
    certificate: z.object({ storagePath: NonEmptyString, sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
    /** The practice's time zone, for the certificate's dates. */
    timeZone: z.string().min(1).max(64).optional(),
    ownerUids: z.array(DocIdSchema),
    /** Everyone with a member document, until their memberships are removed. */
    memberUids: z.array(DocIdSchema).optional(),
    counts: OrgPurgeCountsSchema,
  }),
  { path: 'deletedOrgs', migratable: false, updatable: [] },
);
export type DeletedOrg = z.infer<typeof DeletedOrg.schema>;

/** A deletion certificate's id: `odc-` and 12 hex characters (never the practice's id). */
export function orgDeletionCertificateId(hashHex: string): string {
  return `odc-${hashHex.slice(0, 12)}`;
}

/** Where a deletion certificate PDF is kept, outside the practice's own files. */
export const orgDeletionCertificatePath = (orgId: string, certificateId: string) =>
  `deletedOrgs/${orgId}/${certificateId}.pdf`;

// ---------- offboarding a member ----------

export const OFFBOARDING_CALLABLES = {
  plan: 'orgs-offboardingPlan',
  offboard: 'orgs-offboardMember',
} as const;

export const OffboardingPlanInput = z.object({ uid: DocIdSchema });
export type OffboardingPlanInput = z.input<typeof OffboardingPlanInput>;

/** What a member leaves behind: the work to hand on and what is theirs alone. */
export interface OffboardingPlan {
  uid: string;
  /** Open matter tasks assigned to them. */
  tasks: number;
  /** Upcoming (or blocked) deadlines assigned to them. */
  deadlines: number;
  /** Matters they are the responsible lawyer for that aren't closed or archived. */
  matters: number;
  /** Whether any of that work is on a privileged matter: whoever takes it needs `privileged.view`. */
  privileged: { tasks: boolean; deadlines: boolean; matters: boolean };
  /** Their personal tasks (not deleted). */
  personalTasks: number;
  /** Their timer is running or paused on a matter of this practice. */
  timer: boolean;
  /** Their own connections (Microsoft, Google). */
  integrations: number;
}

/**
 * Their personal tasks (private even from admins): `export` writes them to a CSV for the admin
 * doing this (a 7-day export, like any other) and then deletes them; `delete` just deletes them.
 */
export const PersonalTasksChoiceSchema = z.enum(['export', 'delete']);
export type PersonalTasksChoice = z.infer<typeof PersonalTasksChoiceSchema>;

export const OffboardMemberInput = z.object({
  requestId: z.uuid(),
  uid: DocIdSchema,
  /** Who takes each kind of work; required when there is any of it (`orgs-offboardingPlan`). */
  reassign: z
    .object({
      tasks: DocIdSchema.optional(),
      deadlines: DocIdSchema.optional(),
      matters: DocIdSchema.optional(),
    })
    .default({}),
  personalTasks: PersonalTasksChoiceSchema,
});
export type OffboardMemberInput = z.input<typeof OffboardMemberInput>;

export interface OffboardMemberResult {
  ok: true;
  tokensRevoked: boolean;
  /** How many of each were handed on. */
  moved: { tasks: number; deadlines: number; matters: number };
  /** Their personal tasks: how many, and the export job when they were exported. */
  personalTasks: { choice: PersonalTasksChoice; count: number; exportJobId?: string };
  /** Their timer's time was saved as draft time entries (`discarded` when its matter is gone). */
  timer: 'saved' | 'discarded' | 'none';
  integrationsRemoved: number;
}

/** The personal-tasks CSV's columns (`orgs-offboardMember` with `personalTasks: export`). */
export const PERSONAL_TASK_EXPORT_COLUMNS = [
  'Title',
  'Status',
  'Priority',
  'Due date',
  'Group',
  'Description',
  'Checklist',
  'Created',
] as const;

// ---------- deleting an account ----------

/** `auth-deleteAccount` (recent sign-in): someone in no practice deletes their account. */
export const DELETE_ACCOUNT_CALLABLE = 'auth-deleteAccount';
export const DeleteAccountInput = z.object({
  /** "DELETE", typed. */
  confirmation: z.string().trim().min(1).max(20),
});
export type DeleteAccountInput = z.input<typeof DeleteAccountInput>;
export const DELETE_ACCOUNT_CONFIRMATION = 'DELETE';
