import { type DocumentClassificationOutput } from '@materia/clerk';
import { isDateOnly } from '@materia/domain';

import type { NotifyContext } from '../../notifications/notify';
import { notifyNewSuggestions } from '../../suggestions/notify';
import { proposeSuggestions } from '../../suggestions/propose';

/** The longest document name a suggestion may propose (the document schema's own limit). */
const TITLE_MAX = 255;

/**
 * Turns a classification into a `document_meta` suggestion (AI-04) through `proposeSuggestions`
 * (AI-07, ADR-037), the only way Clerk writes. Clerk proposes, never commits: the suggestion carries
 * the category, title, date and parties, and a person accepts or edits it; the document's own name
 * and category are never touched here. The dedupe key names the document version, so a retried
 * task (or a dismissed proposal) doesn't make a second one. A new suggestion is notified
 * (`notifyNewSuggestions`, CORE-22a) to the matter's responsible lawyer, or else the uploader.
 */
export async function writeDocumentMetaSuggestion(
  ctx: NotifyContext,
  input: {
    matterId: string;
    docId: string;
    version: number;
    /** Who uploaded the version: told when the responsible lawyer can't review the suggestion. */
    uploaderUid?: string;
    output: DocumentClassificationOutput;
    model: string;
    promptRef: string;
    /** Tell the matter's lawyer (default); false when a summary goes out instead (MIG-09). */
    notify?: boolean;
  },
): Promise<'created' | 'exists' | 'skipped'> {
  const { output } = input;
  const [promptId = 'classify-document', promptVersion = '1.0.0'] = input.promptRef.split('@');
  const title = output.suggestedTitle.trim().slice(0, TITLE_MAX) || 'Untitled document';
  const parties = output.parties
    .map((p) => p.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 20);
  const result = await proposeSuggestions(
    ctx,
    input.matterId,
    [
      {
        kind: 'document_meta',
        payload: {
          documentId: input.docId,
          category: output.category,
          title,
          ...(output.documentDate && isDateOnly(output.documentDate) ? { date: output.documentDate } : {}),
          ...(parties.length ? { parties } : {}),
        },
        citations: [],
        dedupeKey: `document_meta#${input.docId}#v${input.version}`,
      },
    ],
    // The suggestion is privileged when the document is: proposeSuggestions checks the target.
    { privileged: false, promptId, promptVersion, model: input.model },
  );
  if (result.created.length) {
    if (input.notify === false) return 'created';
    await notifyNewSuggestions(
      ctx,
      input.matterId,
      result.created,
      input.uploaderUid ? { fallbackUid: input.uploaderUid } : {},
    );
    return 'created';
  }
  const reason = result.skipped[0]?.reason;
  return reason === 'duplicate' || reason === 'exists' ? 'exists' : 'skipped';
}
