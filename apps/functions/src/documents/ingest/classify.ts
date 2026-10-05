import type { Firestore } from 'firebase-admin/firestore';

import { type DocumentClassificationOutput } from '@materia/clerk';
import { isDateOnly, Suggestion } from '@materia/domain';

import { matterPath } from '../../matters/shared';

/**
 * Turns a classification into a `document_meta` suggestion (AI-04). Clerk proposes, never commits:
 * the suggestion carries the category, title, date and parties, and a person accepts or edits it
 * (AI-07); the document's own name and category are never touched here. One suggestion per
 * document version (`docmeta-{docId}-v{n}`), so a retried task doesn't make a second.
 */
export async function writeDocumentMetaSuggestion(
  db: Firestore,
  input: {
    orgId: string;
    matterId: string;
    docId: string;
    version: number;
    output: DocumentClassificationOutput;
    model: string;
    promptRef: string;
    at: Date;
  },
): Promise<'created' | 'exists'> {
  const { output } = input;
  const [promptId = 'classify-document', promptVersion = '1.0.0'] = input.promptRef.split('@');
  const id = `docmeta-${input.docId}-v${input.version}`;
  const title = output.suggestedTitle.trim().slice(0, 255) || 'Untitled document';
  const record = Suggestion.schema.parse({
    kind: 'document_meta',
    payload: {
      documentId: input.docId,
      category: output.category,
      title,
      ...(output.documentDate && isDateOnly(output.documentDate) ? { date: output.documentDate } : {}),
      ...(output.parties.length
        ? {
            parties: output.parties
              .map((p) => p.trim().slice(0, 200))
              .filter(Boolean)
              .slice(0, 20),
          }
        : {}),
    },
    citations: [],
    status: 'proposed',
    promptId,
    promptVersion,
    model: input.model,
    dedupeKey: `document_meta#${input.docId}#v${input.version}`,
    createdAt: input.at,
    createdBy: 'clerk',
    updatedAt: input.at,
    updatedBy: 'clerk',
    schemaVersion: Suggestion.version,
  });
  try {
    await db.doc(`${matterPath(input.orgId, input.matterId)}/suggestions/${id}`).create(record);
    return 'created';
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 6 || code === 'already-exists') return 'exists';
    throw error;
  }
}
