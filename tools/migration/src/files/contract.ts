import * as z from 'zod';

import { byCodeUnit } from '../export/jsonl.ts';

/**
 * What the attachment copy (MIG-05) reads from the transform (MIG-03), under
 * `gs://materia-v2-<env>-migration/runs/{runId}/`:
 *
 * - `transformed/documents.jsonl`: one line per attachment, sorted by path,
 *   `{path, legacyPath, data, copy}`. `data` is the `MatterDocument` with `version: 0`, no
 *   versions and `scan.status: 'pending'`; `copy` names the legacy object and where it goes.
 * - `transformed/avatars.jsonl`: the profile photo, `{path: 'users/{uid}/avatar.png', legacyPath, copy}`.
 * - `report.json`: `storage.orphans[]`, the legacy objects no document names (names and sizes only).
 *
 * Instants stay tagged as in the export (`{"$timestamp": "…"}`). The schemas check only what the
 * copy relies on, so a change to the transform's output fails here, loudly, before anything is copied.
 */

const DOCUMENT_PATH = /^orgs\/[^/]+\/matters\/[^/]+\/documents\/[^/]+$/;
const AVATAR_PATH = /^users\/[^/]+\/avatar\.png$/;

/**
 * The legacy object behind a line and where its copy goes. `source` is absent when the object is
 * missing, and for `content`: bytes the transform extracted (an image a description embedded),
 * which the copy uploads instead.
 */
export const CopySpecSchema = z.object({
  source: z.string().min(1).optional(),
  content: z
    .object({
      encoding: z.literal('base64'),
      data: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
  target: z.string().min(1),
  fileName: z.string().min(1),
  mime: z.string().min(3),
  sizeBytes: z.number().int().min(0),
  /** Base64, as Storage reports them in the export's `raw/storage-objects.jsonl`. */
  md5Hash: z.string().min(1).optional(),
  crc32c: z.string().min(1).optional(),
  generation: z
    .union([z.string().min(1), z.number().int()])
    .transform(String)
    .optional(),
  /** svg, gif and bmp: v2 never shows them inline (D-13). */
  downloadOnly: z.boolean().optional(),
});
export type CopySpec = z.infer<typeof CopySpecSchema>;

export const DocumentLineSchema = z
  .object({
    path: z.string().regex(DOCUMENT_PATH),
    legacyPath: z.string().min(1),
    data: z.record(z.string(), z.unknown()),
    copy: CopySpecSchema,
  })
  .refine((line) => line.copy.target === `${line.path}/v1`, {
    message: 'must be the document path followed by /v1',
    path: ['copy', 'target'],
  });
export type DocumentLine = z.infer<typeof DocumentLineSchema>;

export const AvatarLineSchema = z
  .object({
    path: z.string().regex(AVATAR_PATH),
    legacyPath: z.string().min(1),
    copy: CopySpecSchema,
  })
  .refine((line) => line.copy.target === line.path, {
    message: 'must be the avatar path',
    path: ['copy', 'target'],
  });
export type AvatarLine = z.infer<typeof AvatarLineSchema>;

export const OrphanSchema = z.object({ name: z.string().min(1), size: z.number().int().min(0).optional() });
export type Orphan = z.infer<typeof OrphanSchema>;

const TransformReportSchema = z.object({
  storage: z
    .object({ orphans: z.array(OrphanSchema).default([]) })
    .partial()
    .optional(),
});

/** The transform's file is missing or doesn't hold what the copy expects. */
export class TransformOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransformOutputError';
  }
}

/** The lines of a JSONL file, each checked against `schema`; errors name the file and line number. */
export function parseJsonl<T>(name: string, text: string, schema: z.ZodType<T>): T[] {
  const lines: T[] = [];
  const rows = text.split('\n');
  rows.forEach((row, index) => {
    if (!row.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(row);
    } catch {
      throw new TransformOutputError(`${name} line ${index + 1} is not JSON.`);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new TransformOutputError(
        `${name} line ${index + 1}: ${issue?.path.join('.') || 'line'} ${issue?.message ?? 'is not valid'}.`,
      );
    }
    lines.push(parsed.data);
  });
  return lines;
}

/** Throws when two lines copy to the same target, which would make one overwrite the other. */
export function assertDistinctTargets(lines: readonly { copy: CopySpec }[]): void {
  const seen = new Set<string>();
  for (const { copy } of lines) {
    if (seen.has(copy.target)) throw new TransformOutputError(`Two lines copy to ${copy.target}.`);
    seen.add(copy.target);
  }
}

/** The transform report's Storage orphans, sorted by name; null when the report doesn't say. */
export function orphansOf(reportText: string | null): Orphan[] | null {
  if (reportText === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(reportText);
  } catch {
    throw new TransformOutputError('report.json is not JSON.');
  }
  const parsed = TransformReportSchema.safeParse(value);
  if (!parsed.success) throw new TransformOutputError('report.json storage.orphans is not a list of objects.');
  const orphans = parsed.data.storage?.orphans;
  return orphans ? [...orphans].sort((a, b) => byCodeUnit(a.name, b.name)) : null;
}
