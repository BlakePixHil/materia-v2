import * as z from 'zod';

import { DocIdSchema, InstantSchema, NonEmptyString, withMeta } from './common';
import { DocumentCategorySchema } from './enums';

const ORG = 'orgs/{orgId}';

/** Heavy work run as a Cloud Run job (ADR-014, FND-24). Each type is one handler in `apps/jobs`. */
export const JobTypeSchema = z.enum(['pdf.render', 'pdf.merge', 'documents.zip']);
export type JobType = z.infer<typeof JobTypeSchema>;

/**
 * Jobs functions run themselves, on a Cloud Tasks queue rather than Cloud Run (ADR-055): CSV
 * exports of the core lists (INS-03), which read Firestore page by page, and the practice's full
 * export (SEC-05, ADR-058), a zip per task with a checkpoint between them.
 */
export const FunctionJobTypeSchema = z.enum(['csv.export', 'org.export']);
export type FunctionJobType = z.infer<typeof FunctionJobTypeSchema>;

export const JobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Where a stamp or page number sits on the page. */
export const PdfPositionSchema = z.enum([
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]);
export type PdfPosition = z.infer<typeof PdfPositionSchema>;

/** A stored matter document version: `orgs/{orgId}/matters/{matterId}/documents/{docId}/v{n}`. */
export const MATTER_DOCUMENT_PATH = /^orgs\/([^/]+)\/matters\/([^/]+)\/documents\/([^/]+)\/v(\d+)$/;

/** Pages, 1-based: `1-3,7,10-12`. */
export const PageRangeSchema = z.string().regex(/^\d+(-\d+)?(,\d+(-\d+)?)*$/, { message: 'Expected pages like 1-3,7' });

/** `pdf.render`: an HTML template from `apps/jobs/templates`, filled with `data` (escaped). */
export const PdfRenderInputSchema = z
  .object({
    templateId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export type PdfRenderInput = z.infer<typeof PdfRenderInputSchema>;

export const PdfStampSchema = z.object({ text: NonEmptyString.max(200), position: PdfPositionSchema }).strict();

export const PdfPageNumbersSchema = z
  .object({
    /** `{n}` is the page number and `{total}` the last page number. */
    format: z.string().min(1).max(60).default('{n}'),
    start: z.number().int().min(0).default(1),
    position: PdfPositionSchema.default('bottom-right'),
  })
  .strict();

/** `pdf.merge`: concatenates matter documents, then stamps, numbers and bookmarks the result. */
export const PdfMergeInputSchema = z
  .object({
    inputs: z
      .array(
        z
          .object({ storagePath: z.string().regex(MATTER_DOCUMENT_PATH), pageRange: PageRangeSchema.optional() })
          .strict(),
      )
      .min(1)
      .max(5000),
    stamp: PdfStampSchema.optional(),
    pageNumbers: PdfPageNumbersSchema.optional(),
    /** `pageIndex` is 0-based in the merged output. */
    bookmarks: z
      .array(z.object({ title: NonEmptyString.max(500), pageIndex: z.number().int().min(0) }).strict())
      .max(5000)
      .optional(),
    /** An encrypted or unreadable input aborts the job, or is skipped with a warning. */
    onInputError: z.enum(['abort', 'skip']).default('abort'),
  })
  .strict();
export type PdfMergeInput = z.infer<typeof PdfMergeInputSchema>;

/** The most documents in one zip download (`documents.zip`, CORE-12b). */
export const DOCUMENTS_ZIP_MAX = 200;
/**
 * The most bytes in one zip download. The job builds the zip in its scratch space, which counts
 * against the job's memory, and zips without zip64 must stay under 4 GiB.
 */
export const DOCUMENTS_ZIP_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * A file name inside a zip: no folders (`/` or `\`), no control characters, and not `.` or `..`,
 * so unzipping can't write outside the folder it unzips into.
 */
export const ZipEntryNameSchema = NonEmptyString.max(255).refine(
  // eslint-disable-next-line no-control-regex
  (name) => !/[/\\\u0000-\u001f\u007f]/.test(name) && name !== '.' && name !== '..',
  { message: 'Expected a file name without folders' },
);

/**
 * `documents.zip` (CORE-12b): the current versions of a selection of matter documents, stored
 * (not compressed) in one zip under the names given. The names are unique (case-insensitively).
 */
export const DocumentsZipInputSchema = z
  .object({
    inputs: z
      .array(z.object({ storagePath: z.string().regex(MATTER_DOCUMENT_PATH), fileName: ZipEntryNameSchema }).strict())
      .min(1)
      .max(DOCUMENTS_ZIP_MAX)
      .refine((inputs) => new Set(inputs.map((input) => input.fileName.toLowerCase())).size === inputs.length, {
        message: 'Each file name may be used once',
      }),
  })
  .strict();
export type DocumentsZipInput = z.infer<typeof DocumentsZipInputSchema>;

/** How long an export file is kept: `jobs-sweepExports` deletes it, and its job, after this. */
export const EXPORT_TTL_DAYS = 7;

/**
 * An export file's path: `[, orgId, jobId, extension]`. A full export split into several zips
 * (SEC-05) names its later parts `{jobId}.part-2.zip`, `{jobId}.part-3.zip`…
 */
export const EXPORT_FILE_PATH = /^orgs\/([^/]+)\/exports\/([^/.]+)(?:\.part-\d+)?\.(pdf|zip|csv)$/;

/** An export file, `orgs/{orgId}/exports/{jobId}.{pdf|zip|csv}`, downloaded through `jobs-getExportUrl`. */
export const ExportTargetSchema = z.object({ kind: z.literal('export'), name: NonEmptyString.max(250) }).strict();

/** Where the output goes: a new matter document, or an export file (7-day TTL, SEC-05). */
export const JobTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('matter'),
      matterId: DocIdSchema,
      name: NonEmptyString.max(250),
      category: DocumentCategorySchema,
      privileged: z.boolean().default(false),
    })
    .strict(),
  ExportTargetSchema,
]);
export type JobTarget = z.infer<typeof JobTargetSchema>;

/** What a caller asks for; `input` is validated per type. */
export const JobRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pdf.render'), input: PdfRenderInputSchema, target: JobTargetSchema }).strict(),
  z.object({ type: z.literal('pdf.merge'), input: PdfMergeInputSchema, target: JobTargetSchema }).strict(),
  /** A zip is never a matter document: it is only ever downloaded. */
  z.object({ type: z.literal('documents.zip'), input: DocumentsZipInputSchema, target: ExportTargetSchema }).strict(),
]);
export type JobRequest = z.infer<typeof JobRequestSchema>;

/** A failure (or a skipped input). `code` is an ErrorCode; the message never carries document text. */
export const JobProblemSchema = z.object({
  code: NonEmptyString,
  message: z.string().max(500),
  retryable: z.boolean(),
  inputIndex: z.number().int().min(0).optional(),
});
export type JobProblem = z.infer<typeof JobProblemSchema>;

export const JobOutputSchema = z.object({
  storagePath: NonEmptyString,
  sizeBytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  pages: z.number().int().min(0),
  documentId: DocIdSchema.optional(),
  /** A CSV export's rows, not counting the header. */
  rows: z.number().int().min(0).optional(),
  /**
   * A full export's zips (SEC-05), in order, when there is more than one; `storagePath` is the
   * first's. Each is a complete zip; the last holds `manifest.json`.
   */
  parts: z
    .array(
      z.object({
        storagePath: NonEmptyString,
        sizeBytes: z.number().int().min(0),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .optional(),
});

/** `jobs/{jobId}`: status and progress, written by functions (create) and the job (everything else). */
export const Job = withMeta(
  () => ({
    type: z.union([JobTypeSchema, FunctionJobTypeSchema]),
    input: z.record(z.string(), z.unknown()),
    target: JobTargetSchema,
    status: JobStatusSchema,
    progress: z.object({
      done: z.number().int().min(0),
      total: z.number().int().min(0),
      stage: z.string().max(60).optional(),
    }),
    output: JobOutputSchema.optional(),
    error: JobProblemSchema.optional(),
    warnings: z.array(JobProblemSchema).default([]),
    attempts: z.number().int().min(0),
    executionId: z.string().optional(),
    startedAt: InstantSchema.optional(),
    heartbeatAt: InstantSchema.optional(),
    finishedAt: InstantSchema.optional(),
    /** Where a job run in several tasks stopped (a full export's next part, SEC-05). */
    checkpoint: z.record(z.string(), z.unknown()).optional(),
  }),
  {
    path: `${ORG}/jobs`,
    migratable: false,
    serverOwned: [
      'status',
      'progress',
      'output',
      'error',
      'warnings',
      'attempts',
      'executionId',
      'startedAt',
      'heartbeatAt',
      'finishedAt',
      'checkpoint',
    ],
    updatable: [],
  },
);
export type Job = z.infer<typeof Job.schema>;

export type ExportExtension = 'zip' | 'pdf' | 'csv';

/** An export job's file type: a zip for `documents.zip` and `org.export`, a CSV for `csv.export`, otherwise a PDF. */
export function exportFileType(type: JobType | FunctionJobType | string | undefined): {
  extension: ExportExtension;
  contentType: string;
} {
  if (type === 'documents.zip' || type === 'org.export') return { extension: 'zip', contentType: 'application/zip' };
  if (type === 'csv.export') return { extension: 'csv', contentType: 'text/csv; charset=utf-8' };
  return { extension: 'pdf', contentType: 'application/pdf' };
}

/**
 * `jobs-getExportUrl` (FND-24, CORE-17, CORE-12b, INS-03): a 5-minute signed URL for an export
 * job's PDF, zip or CSV, for the member who started it, once it has succeeded.
 */
export const GET_EXPORT_URL_CALLABLE = 'jobs-getExportUrl';
export const GetExportUrlInput = z.object({
  jobId: DocIdSchema,
  /** Which zip of a full export split into several (SEC-05), from 1; the first when absent. */
  part: z.number().int().min(1).max(10_000).optional(),
});
export type GetExportUrlInput = z.input<typeof GetExportUrlInput>;

export interface GetExportUrlResult {
  url: string;
  /** ISO 8601. */
  expiresAt: string;
  fileName: string;
  /** How many zips the export has (1 unless a full export was split). */
  parts?: number;
  /** Which one this link is for. */
  part?: number;
}
