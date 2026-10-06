import { createHash } from 'node:crypto';

import type { Firestore } from 'firebase-admin/firestore';
import type * as z from 'zod';

import {
  can,
  DOC_CALLABLES,
  docTemplateCategory,
  docTemplateTags,
  documentVersionPath,
  DomainError,
  GenerateDocumentInput,
  longDate,
  MatterDocument,
  PERMISSIONS,
  type DocumentCategorySchema,
  type GenerateDocumentResult,
  type Role,
} from '@materia/domain';

import { loadMergeSources, mergeDataFor } from './data';
import { DOCX_MIME } from './docx';
import { mergeTemplate, TemplateMergeError } from './engine';
import { loadTemplate } from './store';
import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';
import type { Log } from '../core/log';
import { storageFiles, type FileStore } from '../documents/files';
import { RENDER_QUEUE } from '../documents/renditions';
import { documentPath } from '../documents/shared';
import { matterPath, writableMatter } from '../matters/shared';
import type { Clock, Ports } from '../ports';

/** The most a generated document's name can be (the document name limit, less the extension). */
const NAME_MAX = 200;

export interface GenerateRequest {
  orgId: string;
  uid: string;
  role: Role;
  /** Names the document, so a retry of the same request can't add a second one. */
  requestId: string;
  templateId: string;
  matterId: string;
  /** Laid over the matter's merge data: a Markdown `body`, a `recipient`, or a feature's own fields. */
  data?: Record<string, unknown> | undefined;
  name?: string | undefined;
  privileged?: boolean | undefined;
  /** `clerk_draft` for Clerk drafting (AI-10); otherwise `generated`. */
  source?: 'generated' | 'clerk_draft';
  /** Overrides the kind's category (`correspondence` for letters) and adds tags. */
  category?: z.infer<typeof DocumentCategorySchema>;
  tags?: readonly string[];
}

export interface GenerateDeps {
  db: Firestore;
  files: FileStore;
  ports: Ports;
  clock: Clock;
  log: Log;
}

/** `Letter to client 6 October 2026.docx`: no path or reserved characters, one extension. */
export function documentFileName(name: string): string {
  const base = name
    .replace(/\.docx$/i, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
  return `${base || 'Document'}.docx`;
}

/** The generated document's id: the same request always names the same document. */
export const generatedDocumentId = (orgId: string, requestId: string) =>
  `gen-${createHash('sha256').update(`${orgId}/${requestId}`).digest('hex').slice(0, 32)}`;

/**
 * Generates a document from a template on a matter and saves it to the matter's documents (INT-06):
 * the merged .docx as version 1 (`source: 'generated'`, clean: it is built from a template that was
 * scanned at upload, ADR-047), filed under the kind's category and tags, with a PDF preview queued
 * through the preview service (CORE-12a). BILL-06 and AI-10 call this with their own data, tags
 * and source. Missing fields are listed in the result, not refused.
 */
export async function generateDocument(deps: GenerateDeps, request: GenerateRequest): Promise<GenerateDocumentResult> {
  const { db, files, log } = deps;
  const { orgId, matterId, role } = request;
  const matter = writableMatter(await db.doc(matterPath(orgId, matterId)).get(), role, matterId);
  if (request.privileged && !can(role, 'privileged.view')) {
    throw new DomainError('PERMISSION_DENIED', 'Your role can’t file privileged documents', {
      reason: 'privileged_not_allowed',
    });
  }
  const template = await loadTemplate(db, files, { orgId, templateId: request.templateId, forGeneration: true });
  const now = deps.clock.now();
  const sources = await loadMergeSources(db, { orgId, matterId, matter, uid: request.uid, now });
  let merged;
  try {
    merged = mergeTemplate(template.data, mergeDataFor(sources, request.data));
  } catch (error) {
    if (!(error instanceof TemplateMergeError)) throw error;
    throw new DomainError('FAILED_PRECONDITION', 'The template couldn’t be merged', {
      reason: 'template_invalid',
      problems: error.problems,
    });
  }

  const docId = generatedDocumentId(orgId, request.requestId);
  const name = documentFileName(request.name ?? `${template.name} ${longDate(sources.today)}`);
  const storagePath = documentVersionPath(orgId, matterId, docId, 1);
  const sha256 = createHash('sha256').update(merged.output).digest('hex');
  await files.write(storagePath, merged.output, { contentType: DOCX_MIME });
  const tags = [...new Set([...docTemplateTags(template.kind), ...(request.tags ?? [])])];
  const record = MatterDocument.schema.parse({
    orgId,
    matterId,
    name,
    category: request.category ?? docTemplateCategory(template.kind),
    // A document generated on a privileged matter is privileged too.
    privileged: request.privileged === true || matter['privileged'] === true,
    tags,
    storagePath,
    mime: DOCX_MIME,
    sizeBytes: merged.output.length,
    sha256,
    version: 1,
    versionSeq: 1,
    versions: [
      {
        version: 1,
        storagePath,
        fileName: name,
        mime: DOCX_MIME,
        sizeBytes: merged.output.length,
        sha256,
        uploadedAt: now,
        uploadedBy: request.uid,
      },
    ],
    scan: { status: 'clean', at: now },
    ingest: { status: 'pending' },
    source: request.source ?? 'generated',
    encrypted: false,
    accessRestricted: false,
    generatedFrom: { templateId: template.id, version: template.version },
    deletedAt: null,
    createdAt: now,
    createdBy: request.uid,
    updatedAt: now,
    updatedBy: request.uid,
    schemaVersion: MatterDocument.version,
  });
  const ref = db.doc(documentPath(orgId, matterId, docId));
  try {
    await ref.create(record);
  } catch (error) {
    // A retry of a request whose first attempt saved the document: it is already there.
    if ((error as { code?: number }).code !== 6) throw error;
  }
  const ids = { matterId, docId, templateId: template.id, version: template.version };
  await deps.ports.tasks
    .enqueue(
      RENDER_QUEUE,
      { orgId, matterId, docId, version: 1 },
      { dedupeKey: `render#${orgId}#${matterId}#${docId}#1` },
    )
    .catch((error: unknown) =>
      log.warn('preview not queued', { ...ids, errorType: error instanceof Error ? error.name : typeof error }),
    );
  await audit(
    { uid: request.uid, orgId, requestId: request.requestId, db, clock: deps.clock },
    {
      action: 'document.generated',
      entity: { path: ref.path },
      summary: `Document generated from template ${template.id} v${template.version}`,
      data: { templateId: template.id, version: template.version, missing: merged.missing.length },
    },
  );
  log.info('generated', { ...ids, sizeBytes: merged.output.length, missing: merged.missing.length });
  return { documentId: docId, name, missing: merged.missing, warnings: template.warnings };
}

/** `docs-generate` (`document.upload`, idempotent). */
export function generateDefinition(files: () => FileStore = () => storageFiles()) {
  return {
    name: DOC_CALLABLES.generate,
    input: GenerateDocumentInput,
    roles: PERMISSIONS['document.upload'],
    idempotent: true,
    memory: '512MiB',
    handler: ({ input, orgId, uid, role, requestId, db, clock, ports, log }) =>
      generateDocument(
        { db, files: files(), ports, clock, log },
        {
          orgId,
          uid,
          role,
          requestId,
          templateId: input.templateId,
          matterId: input.matterId,
          data: input.data,
          name: input.name,
          privileged: input.privileged,
        },
      ),
  } satisfies CallableDefinition<typeof GenerateDocumentInput, GenerateDocumentResult>;
}

export const generate = defineCallable(generateDefinition());
