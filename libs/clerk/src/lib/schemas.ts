import * as z from 'zod';

import { DocumentCategorySchema } from '@materia/domain';

/**
 * Structured-output schemas, by the name a prompt's `outputSchema` uses. The gateway sends the
 * JSON schema derived from each (`output_config.format`) and validates the reply with zod again on
 * receipt; a reply that fails is `invalid_output`, never retried blindly (Clerk doc).
 */
export const HelloOutput = z.object({
  greeting: z.string().min(1).max(500),
  promptRef: z.string(),
});

/**
 * One page read by OCR (AI-04, `ocr@1`): the page's text in reading order, whether the model found
 * it hard to read (handwriting, a poor scan), and its language (ISO 639-1, `und` when unknown).
 */
export const OcrPageOutput = z.object({
  text: z.string(),
  lowConfidence: z.boolean(),
  language: z.string(),
});
export type OcrPageOutput = z.infer<typeof OcrPageOutput>;

/**
 * A document's suggested metadata (AI-04, `classify-document@1`), from its first pages. It becomes
 * a `document_meta` suggestion; it never overwrites what a person entered. `documentDate` is
 * `YYYY-MM-DD` (checked again before use); `language` is ISO 639-1.
 */
export const DocumentClassificationOutput = z.object({
  category: DocumentCategorySchema,
  suggestedTitle: z.string(),
  documentDate: z.string().optional(),
  parties: z.array(z.string()),
  language: z.string(),
});
export type DocumentClassificationOutput = z.infer<typeof DocumentClassificationOutput>;

export const OUTPUT_SCHEMAS = {
  hello: HelloOutput,
  ocrPage: OcrPageOutput,
  documentClassification: DocumentClassificationOutput,
} as const satisfies Record<string, z.ZodType>;

export type OutputSchemaName = keyof typeof OUTPUT_SCHEMAS;
