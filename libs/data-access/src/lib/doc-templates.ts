import * as z from 'zod';

import {
  DOC_CALLABLES,
  DocTemplate,
  DomainError,
  LETTERHEAD_DOC,
  LetterheadDetailsSchema,
  LetterheadDoc,
  SoftDeleteShape,
  type DocTemplateResult,
  type DownloadDocTemplateInput,
  type DownloadDocTemplateResult,
  type GenerateDocumentInput,
  type GenerateDocumentResult,
  type PreviewDocTemplateInput,
  type PreviewDocTemplateResult,
  type PublishDocTemplateInput,
  type SaveDocTemplateInput,
  type SaveDocTemplateResult,
  type SaveLetterheadInput,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

const refuse = (what: string) => () =>
  Promise.reject(
    new DomainError('FAILED_PRECONDITION', `${what} change through the docs-* callables`, { reason: 'callable_only' }),
  );

/** A document template as Settings and "New from template" read it (INT-06); unknown fields are dropped. */
export const DocTemplateItemSchema = /* @__PURE__ */ z.object({
  ...DocTemplate.schema.shape,
  deletedAt: SoftDeleteShape.deletedAt,
});
export type DocTemplateItem = z.infer<typeof DocTemplateItemSchema>;

/**
 * The org's docx templates (`orgs/{orgId}/docTemplates`, INT-06): every member reads them; every
 * write is a `docs-*` callable, which checks the tags and scans the file. Call it in an injection context.
 */
export function docTemplatesRepository(): Repository<DocTemplateItem> {
  const base = repo((orgId) => `orgs/${orgId}/docTemplates`, {
    schema: DocTemplateItemSchema,
    version: DocTemplate.version,
  });
  const write = refuse('Document templates');
  return { ...base, create: write, update: write, softDelete: write, hardDelete: write };
}

/** Every live template, by name (a firm keeps a handful). */
export const DOC_TEMPLATES_QUERY: QuerySpec<DocTemplateItem> = { orderBy: [['name', 'asc']], pageSize: 200 };

/** `orgs/{orgId}/settings/letterhead` as read: the firm's contact details for the letterhead. */
export const LetterheadItemSchema = /* @__PURE__ */ z.object({ ...LetterheadDetailsSchema.shape });
export type LetterheadItem = z.infer<typeof LetterheadItemSchema>;

/** The letterhead details, by id `letterhead` (`LETTERHEAD_DOC`): read-only, saved by `docs-saveLetterhead`. */
export function letterheadRepository(): Repository<LetterheadItem> {
  const base = repo((orgId) => `orgs/${orgId}/settings`, {
    schema: LetterheadItemSchema,
    version: LetterheadDoc.version,
  });
  const write = refuse('Letterhead details');
  return { ...base, create: write, update: write, softDelete: write, hardDelete: write };
}

export { LETTERHEAD_DOC };

type Input<T> = Omit<T, 'requestId'>;

/** The `docs-*` callables (INT-06). */
export interface DocTemplateCallables {
  /** `docs-generate` (`document.upload`; idempotent): a document from a template, saved on the matter. */
  generate(input: Input<GenerateDocumentInput>): Promise<GenerateDocumentResult>;
  /** `docs-saveTemplate` (`org.settings`; idempotent): a new template, a new version, or new details. */
  saveTemplate(input: Input<SaveDocTemplateInput>): Promise<SaveDocTemplateResult>;
  publishTemplate(input: Input<PublishDocTemplateInput>): Promise<DocTemplateResult>;
  unpublishTemplate(templateId: string): Promise<DocTemplateResult>;
  deleteTemplate(templateId: string): Promise<DocTemplateResult>;
  /** `docs-previewTemplate` (`org.settings`): a test merge against a matter, saving nothing. */
  previewTemplate(input: PreviewDocTemplateInput): Promise<PreviewDocTemplateResult>;
  downloadTemplate(input: DownloadDocTemplateInput): Promise<DownloadDocTemplateResult>;
  saveLetterhead(input: Input<SaveLetterheadInput>): Promise<{ saved: true }>;
}

export function docTemplateCallables(client: Pick<CallableClient, 'call'>): DocTemplateCallables {
  const idempotent = { idempotent: true };
  return {
    generate: (input) => client.call(DOC_CALLABLES.generate, input, idempotent),
    saveTemplate: (input) => client.call(DOC_CALLABLES.saveTemplate, input, idempotent),
    publishTemplate: (input) => client.call(DOC_CALLABLES.publishTemplate, input, idempotent),
    unpublishTemplate: (templateId) => client.call(DOC_CALLABLES.unpublishTemplate, { templateId }, idempotent),
    deleteTemplate: (templateId) => client.call(DOC_CALLABLES.deleteTemplate, { templateId }, idempotent),
    previewTemplate: (input) => client.call(DOC_CALLABLES.previewTemplate, input),
    downloadTemplate: (input) => client.call(DOC_CALLABLES.downloadTemplate, input),
    saveLetterhead: (input) => client.call(DOC_CALLABLES.saveLetterhead, input, idempotent),
  };
}
