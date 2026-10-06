import type { DocTemplateItem, WithId } from '@materia/data-access/repository';
import { DomainError, type DocTemplateProblem } from '@materia/domain';
import type { MtBadgeTone } from '@materia/ui';

import { errorCopy } from '../../core/error-copy';

/** The largest .docx a template can be (the callable's limit, checked here first). */
export const TEMPLATE_MAX_BYTES = 5 * 1024 * 1024;

const details = (error: unknown): Record<string, unknown> | undefined =>
  error instanceof DomainError
    ? error.details
    : ((error as { details?: Record<string, unknown> } | null)?.details ?? undefined);

/** What the docs-* callables refused, in words (INT-06), by `details.reason`. */
export function docTemplateErrorCopy(error: unknown): string {
  switch (details(error)?.['reason']) {
    case 'template_invalid':
      return 'Some tags in the template need fixing. Each one is listed below.';
    case 'template_unpublished':
      return 'This template isn’t published. An owner or admin can publish it in Settings → Document templates.';
    case 'infected':
      return 'The file failed the malware scan, so it wasn’t saved.';
    case 'version_limit':
      return 'This template has 50 versions, the most it keeps. Upload the file as a new template instead.';
    case 'too_large':
      return 'A template can be up to 5 MB. Remove large images and try again.';
    case 'privileged_not_allowed':
      return 'Your role can’t file privileged documents. Ask a lawyer to generate it.';
    case 'matter_archived':
      return 'This matter is archived, so nothing can be added to it. Reopen it first.';
    default:
      return errorCopy(error);
  }
}

/** The tag problems a refused upload or merge listed, each naming its tag. */
export function templateProblems(error: unknown): DocTemplateProblem[] {
  const problems = details(error)?.['problems'];
  return Array.isArray(problems)
    ? problems.filter((p): p is DocTemplateProblem => typeof (p as DocTemplateProblem)?.message === 'string')
    : [];
}

/** A template's state for its badge: Published v2, Draft, or v3 not published yet. */
export function templateStatus(template: DocTemplateItem): { label: string; tone: MtBadgeTone } {
  if (!template.published || template.publishedVersion === undefined) return { label: 'Draft', tone: 'warning' };
  return { label: `Published v${template.publishedVersion}`, tone: 'success' };
}

/** The latest version, when it isn't the published one (so it can be published). */
export function unpublishedLatest(template: DocTemplateItem): number | null {
  return template.published && template.publishedVersion === template.version ? null : template.version;
}

/** "3 fields had no value: client.address, firm.phone and fee.amount." */
export function missingText(missing: readonly string[]): string | null {
  if (missing.length === 0) return null;
  const shown = missing.slice(0, 6);
  const list = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] ?? ''}`;
  const more = missing.length > shown.length ? ` (and ${missing.length - shown.length} more)` : '';
  return `${missing.length === 1 ? '1 field had' : `${missing.length} fields had`} no value: ${list}${more}. Each shows as [[missing: …]] in the document.`;
}

/** The templates by id, for "Replaced by …" on the built-in ones. */
export function replacedBy(templates: readonly WithId<DocTemplateItem>[]): Map<string, string> {
  return new Map(
    templates.flatMap((t) => (t.replaces && t.published && !t.deletedAt ? [[t.replaces, t.name] as const] : [])),
  );
}

/** A file's contents as base64 (no `data:` prefix), for the upload callable. */
export function fileBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('The file couldn’t be read'));
    reader.readAsDataURL(file);
  });
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Saves a base64 file (a downloaded template or a test merge) through a temporary link. */
export function downloadBase64(fileName: string, contentBase64: string, type = DOCX_MIME): void {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
