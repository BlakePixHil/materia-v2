import * as z from 'zod';

import { DocIdSchema, InstantSchema, NonEmptyString, withMeta } from './common';
import { DocumentCategorySchema } from './enums';

const ORG = 'orgs/{orgId}';

/** Heavy work run as a Cloud Run job (ADR-014, FND-24). Each type is one handler in `apps/jobs`. */
export const JobTypeSchema = z.enum(['pdf.render', 'pdf.merge']);
export type JobType = z.infer<typeof JobTypeSchema>;

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
  z.object({ kind: z.literal('export'), name: NonEmptyString.max(250) }).strict(),
]);
export type JobTarget = z.infer<typeof JobTargetSchema>;

/** What a caller asks for; `input` is validated per type. */
export const JobRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pdf.render'), input: PdfRenderInputSchema, target: JobTargetSchema }).strict(),
  z.object({ type: z.literal('pdf.merge'), input: PdfMergeInputSchema, target: JobTargetSchema }).strict(),
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
});

/** `jobs/{jobId}`: status and progress, written by functions (create) and the job (everything else). */
export const Job = withMeta(
  {
    type: JobTypeSchema,
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
  },
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
    ],
    updatable: [],
  },
);
export type Job = z.infer<typeof Job.schema>;

/**
 * `jobs-getExportUrl` (FND-24, CORE-17): a 5-minute signed URL for an export job's PDF, for the
 * member who started it, once it has succeeded.
 */
export const GET_EXPORT_URL_CALLABLE = 'jobs-getExportUrl';
export const GetExportUrlInput = z.object({ jobId: DocIdSchema });
export type GetExportUrlInput = z.input<typeof GetExportUrlInput>;

export interface GetExportUrlResult {
  url: string;
  /** ISO 8601. */
  expiresAt: string;
  fileName: string;
}
