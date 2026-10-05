import { DocumentClassificationOutput, OcrPageOutput } from '@materia/clerk';
import { DomainError } from '@materia/domain';

import type { ClerkGateway, GatewayContext } from '../../clerk/gateway';

/**
 * What ingestion asks of Clerk (AI-04), through the gateway like every Clerk feature: OCR of one
 * page (`ocr@1`, low effort) and classification of a document (`classify-document@1`, low effort).
 * Both run as the system, without the per-user request window (background features).
 */
export interface IngestClerk {
  /** Reads one page; throws `OcrUnavailableError` when Clerk is off for the org. */
  ocr(input: OcrInput): Promise<OcrPageOutput>;
  /** Suggests metadata; null when classification is off, refused or invalid (never throws for those). */
  classify(
    input: ClassifyInput,
  ): Promise<{ output: DocumentClassificationOutput; model: string; promptRef: string } | null>;
}

export interface OcrInput {
  orgId: string;
  docId: string;
  version: number;
  page: number;
  fileName: string;
  pdfBase64: string;
}

export interface ClassifyInput {
  orgId: string;
  docId: string;
  version: number;
  fileName: string;
  /** The first pages' text, each starting with a `--- Page N ---` line. */
  text: string;
  pageCount: number;
}

/** Clerk can't OCR for this org right now (switched off, no key, over the monthly token budget). */
export class OcrUnavailableError extends Error {
  constructor(readonly code: string) {
    super(`OCR unavailable: ${code}`);
    this.name = 'OcrUnavailableError';
  }
}

/** Gateway errors that mean "not for this org now", rather than "try again soon". */
const RETRYABLE_CODES = new Set(['CLERK_UNAVAILABLE', 'CLERK_BUSY']);
const isOff = (error: unknown): error is DomainError =>
  error instanceof DomainError && error.code.startsWith('CLERK_') && !RETRYABLE_CODES.has(error.code);

export function gatewayIngestClerk(gateway: ClerkGateway, ctx: (orgId: string) => GatewayContext): IngestClerk {
  return {
    async ocr(input) {
      let result: Awaited<ReturnType<ClerkGateway['run']>>;
      try {
        result = await gateway.run({
          ctx: ctx(input.orgId),
          feature: 'ocr',
          promptId: 'ocr@1.0.0',
          vars: { page: input.page, fileName: input.fileName },
          documents: [
            {
              documentId: input.docId,
              version: input.version,
              blockPages: [input.page],
              source: { kind: 'pdf', base64: input.pdfBase64 },
            },
          ],
          output: OcrPageOutput,
        });
      } catch (error) {
        if (isOff(error)) throw new OcrUnavailableError(error.code);
        throw error;
      }
      const parsed = OcrPageOutput.safeParse(result.parsed);
      // A refusal, truncation or invalid reply still costs the page: keep what text there is, flagged.
      if (result.status !== 'done' || !parsed.success) return { text: '', lowConfidence: true, language: 'und' };
      return parsed.data;
    },

    async classify(input) {
      try {
        const result = await gateway.run({
          ctx: ctx(input.orgId),
          feature: 'classification',
          promptId: 'classify-document@1.0.0',
          vars: { fileName: input.fileName, pageCount: input.pageCount },
          documents: [
            {
              documentId: input.docId,
              version: input.version,
              title: input.fileName,
              source: { kind: 'text', text: input.text },
            },
          ],
          output: DocumentClassificationOutput,
        });
        const parsed = DocumentClassificationOutput.safeParse(result.parsed);
        if (result.status !== 'done' || !parsed.success) return null;
        return { output: parsed.data, model: result.model, promptRef: result.promptRef };
      } catch (error) {
        if (isOff(error)) return null;
        throw error;
      }
    },
  };
}
