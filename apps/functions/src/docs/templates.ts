import { createHash } from 'node:crypto';

import { FieldValue, type Firestore } from 'firebase-admin/firestore';

import {
  DOC_CALLABLES,
  DOC_TEMPLATE_MAX_BYTES,
  DOC_TEMPLATE_VERSIONS_MAX,
  DocTemplate,
  DocTemplateRefInput,
  DomainError,
  DownloadDocTemplateInput,
  LetterheadDoc,
  letterheadPath,
  PERMISSIONS,
  PreviewDocTemplateInput,
  PublishDocTemplateInput,
  SaveDocTemplateInput,
  SaveLetterheadInput,
  type DocTemplateResult,
  type DocTemplateVersion,
  type DownloadDocTemplateResult,
  type PreviewDocTemplateResult,
  type SaveDocTemplateResult,
} from '@materia/domain';

import { loadMergeSources, mergeDataFor } from './data';
import { inspectTemplate, mergeTemplate, TemplateMergeError } from './engine';
import { documentFileName } from './generate';
import { docTemplatePath, liveTemplate, loadTemplate, templateFilePath, versionsOfTemplate, withDates } from './store';
import { audit } from '../audit/audit';
import { isDeleted } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { storageFiles, type FileStore } from '../documents/files';
import { SCAN_TIMEOUT_MS, scanWithTimeout } from '../documents/pipeline';
import { liveMatter, matterPath } from '../matters/shared';
import { ScannerUnavailableError } from '../ports';

/**
 * Settings → Document templates (INT-06): upload and version a firm's .docx templates, publish
 * them, test-merge against a matter, download them (the system ones too, as a starting point) and
 * keep the letterhead details. Owners and admins (`org.settings`). Every write is a callable; the
 * rules let members read.
 */

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** A new template's id: the same request always names the same template. */
const newTemplateId = (orgId: string, requestId: string) =>
  `dt-${createHash('sha256').update(`${orgId}/${requestId}`).digest('hex').slice(0, 24)}`;

/** Decodes and checks an uploaded template: size, tags, malware. Throws the problems by name. */
async function checkUpload(
  file: { fileName: string; contentBase64: string },
  scan: (data: Uint8Array) => Promise<void>,
): Promise<{ data: Buffer; fields: string[]; warnings: string[] }> {
  const data = Buffer.from(file.contentBase64, 'base64');
  if (data.length === 0 || data.length > DOC_TEMPLATE_MAX_BYTES) {
    throw new DomainError('INVALID_ARGUMENT', 'The template must be a .docx of up to 5 MB', {
      fields: { 'file.contentBase64': ['Up to 5 MB'] },
      reason: 'too_large',
    });
  }
  const inspected = inspectTemplate(data);
  if (inspected.problems.length > 0) {
    throw new DomainError('INVALID_ARGUMENT', 'The template has tags that need fixing', {
      reason: 'template_invalid',
      problems: inspected.problems.slice(0, 50),
    });
  }
  await scan(data);
  return { data, fields: inspected.fields, warnings: inspected.warnings };
}

export function saveTemplateDefinition(files: () => FileStore = () => storageFiles()) {
  return {
    name: DOC_CALLABLES.saveTemplate,
    input: SaveDocTemplateInput,
    roles: PERMISSIONS['org.settings'],
    idempotent: true,
    memory: '512MiB',
    handler: async ({ input, orgId, uid, requestId, db, clock, ports, log }): Promise<SaveDocTemplateResult> => {
      const store = files();
      const templateId = input.templateId ?? newTemplateId(orgId, requestId);
      const existing = input.templateId ? await liveTemplate(db, orgId, input.templateId) : undefined;
      const versions = versionsOfTemplate(existing);
      if (input.file && versions.length >= DOC_TEMPLATE_VERSIONS_MAX) {
        throw new DomainError('FAILED_PRECONDITION', 'This template has the most versions it can keep', {
          reason: 'version_limit',
        });
      }
      const version = Math.max(0, ...versions.map((v) => v.version)) + (input.file ? 1 : 0);
      let added: DocTemplateVersion | undefined;
      if (input.file) {
        const storagePath = templateFilePath(orgId, templateId, version);
        const checked = await checkUpload(input.file, async (data) => {
          let verdict;
          try {
            verdict = await scanWithTimeout(
              ports.malwareScan,
              { bucket: store.bucket, path: storagePath, data },
              SCAN_TIMEOUT_MS,
            );
          } catch (error) {
            if (!(error instanceof ScannerUnavailableError)) throw error;
            log.warn('template scan unavailable', { templateId, reason: error.reason });
            throw new DomainError('UNAVAILABLE', 'The malware scanner is unavailable. Try again shortly.');
          }
          if (verdict.verdict === 'infected') {
            log.warn('template infected', { templateId });
            throw new DomainError('FAILED_PRECONDITION', 'The file failed the malware scan', { reason: 'infected' });
          }
        });
        await store.write(storagePath, checked.data, {
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });
        added = {
          version,
          storagePath,
          fileName: input.file.fileName,
          sizeBytes: checked.data.length,
          sha256: sha256(checked.data),
          fields: checked.fields,
          warnings: checked.warnings,
          uploadedAt: clock.now(),
          uploadedBy: uid,
        };
      }
      const ref = db.doc(docTemplatePath(orgId, templateId));
      const now = clock.now();
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists ? snap.data() : undefined;
        if (input.templateId && (!current || isDeleted(current))) {
          throw new DomainError('NOT_FOUND', 'Template not found', { templateId });
        }
        const currentVersions = versionsOfTemplate(current);
        // Another upload got in first: the version numbers would collide.
        if (added && currentVersions.some((v) => v.version === added.version)) {
          throw new DomainError('CONFLICT', 'The template changed while saving. Try again.');
        }
        const nextVersions = added ? [...currentVersions, added] : currentVersions;
        const latest = nextVersions[nextVersions.length - 1];
        if (!latest)
          throw new DomainError('INVALID_ARGUMENT', 'A new template needs a file', { fields: { file: ['Required'] } });
        const fields = {
          name: input.name,
          kind: input.kind,
          ...(input.matterTypes ? { matterTypes: input.matterTypes } : {}),
          ...(input.replaces ? { replaces: input.replaces } : {}),
          storagePath: latest.storagePath,
          fields: latest.fields,
          version: latest.version,
          versions: nextVersions,
          updatedAt: now,
          updatedBy: uid,
        };
        if (current) {
          tx.update(ref, input.replaces === null ? { ...fields, replaces: FieldValue.delete() } : fields);
          return;
        }
        tx.create(
          ref,
          DocTemplate.schema.parse({
            ...fields,
            matterTypes: input.matterTypes ?? [],
            published: false,
            deletedAt: null,
            createdAt: now,
            createdBy: uid,
            schemaVersion: DocTemplate.version,
          }),
        );
      });
      log.info('template saved', { templateId, version, uploaded: !!added });
      const latest = added ?? versions[versions.length - 1];
      return { templateId, version, fields: latest?.fields ?? [], warnings: latest?.warnings ?? [] };
    },
  } satisfies CallableDefinition<typeof SaveDocTemplateInput, SaveDocTemplateResult>;
}

async function updateTemplate(
  db: Firestore,
  orgId: string,
  templateId: string,
  change: (doc: Record<string, unknown>) => Record<string, unknown>,
) {
  const ref = db.doc(docTemplatePath(orgId, templateId));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (!snap.exists || !data || (data['deletedAt'] !== null && data['deletedAt'] !== undefined)) {
      throw new DomainError('NOT_FOUND', 'Template not found', { templateId });
    }
    tx.update(ref, change(data));
  });
  return ref.path;
}

export const publishTemplateDefinition = {
  name: DOC_CALLABLES.publishTemplate,
  input: PublishDocTemplateInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  handler: async ({ input, orgId, uid, requestId, db, clock }): Promise<DocTemplateResult> => {
    const now = clock.now();
    const path = await updateTemplate(db, orgId, input.templateId, (doc) => {
      if (!versionsOfTemplate(doc).some((v) => v.version === input.version)) {
        throw new DomainError('NOT_FOUND', 'Version not found', { version: input.version });
      }
      return {
        published: true,
        publishedVersion: input.version,
        publishedAt: now,
        publishedBy: uid,
        updatedAt: now,
        updatedBy: uid,
      };
    });
    await audit(
      { uid, orgId, requestId, db, clock },
      {
        action: 'doc_template.published',
        entity: { path },
        summary: `Document template ${input.templateId} v${input.version} published`,
      },
    );
    return { templateId: input.templateId };
  },
} satisfies CallableDefinition<typeof PublishDocTemplateInput, DocTemplateResult>;

export const unpublishTemplateDefinition = {
  name: DOC_CALLABLES.unpublishTemplate,
  input: DocTemplateRefInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  handler: async ({ input, orgId, uid, db, clock }): Promise<DocTemplateResult> => {
    const now = clock.now();
    await updateTemplate(db, orgId, input.templateId, () => ({ published: false, updatedAt: now, updatedBy: uid }));
    return { templateId: input.templateId };
  },
} satisfies CallableDefinition<typeof DocTemplateRefInput, DocTemplateResult>;

/** Soft delete: documents already generated keep `generatedFrom`; the files stay for them. */
export const deleteTemplateDefinition = {
  name: DOC_CALLABLES.deleteTemplate,
  input: DocTemplateRefInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  handler: async ({ input, orgId, uid, db, clock }): Promise<DocTemplateResult> => {
    const now = clock.now();
    await updateTemplate(db, orgId, input.templateId, () => ({
      published: false,
      deletedAt: now,
      deletedBy: uid,
      updatedAt: now,
      updatedBy: uid,
    }));
    return { templateId: input.templateId };
  },
} satisfies CallableDefinition<typeof DocTemplateRefInput, DocTemplateResult>;

/** The largest preview HTML returned (a long template's body, without images). */
const PREVIEW_HTML_MAX = 400_000;

/** The merged document's body as HTML (mammoth), images left out to keep the response small. */
async function bodyHtml(data: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const api = (mammoth as unknown as { default?: typeof mammoth }).default ?? mammoth;
  const { value } = await api.convertToHtml(
    { buffer: data },
    { convertImage: api.images.imgElement(() => Promise.resolve({ src: '', alt: '[image]' })) },
  );
  return value.length > PREVIEW_HTML_MAX ? `${value.slice(0, PREVIEW_HTML_MAX)}…` : value;
}

export function previewTemplateDefinition(files: () => FileStore = () => storageFiles()) {
  return {
    name: DOC_CALLABLES.previewTemplate,
    input: PreviewDocTemplateInput,
    roles: PERMISSIONS['org.settings'],
    memory: '512MiB',
    handler: async ({ input, orgId, uid, role, db, clock }): Promise<PreviewDocTemplateResult> => {
      const matter = liveMatter(await db.doc(matterPath(orgId, input.matterId)).get(), role, input.matterId);
      const template = await loadTemplate(db, files(), { orgId, templateId: input.templateId, version: input.version });
      const sources = await loadMergeSources(db, { orgId, matterId: input.matterId, matter, uid, now: clock.now() });
      let merged;
      try {
        merged = mergeTemplate(template.data, mergeDataFor(sources, input.data));
      } catch (error) {
        if (!(error instanceof TemplateMergeError)) throw error;
        throw new DomainError('FAILED_PRECONDITION', 'The template couldn’t be merged', {
          reason: 'template_invalid',
          problems: error.problems,
        });
      }
      return {
        html: await bodyHtml(merged.output),
        missing: merged.missing,
        warnings: template.warnings,
        fileName: documentFileName(`${template.name} (test merge)`),
        contentBase64: merged.output.toString('base64'),
      };
    },
  } satisfies CallableDefinition<typeof PreviewDocTemplateInput, PreviewDocTemplateResult>;
}

export function downloadTemplateDefinition(files: () => FileStore = () => storageFiles()) {
  return {
    name: DOC_CALLABLES.downloadTemplate,
    input: DownloadDocTemplateInput,
    roles: PERMISSIONS['org.settings'],
    handler: async ({ input, orgId, db }): Promise<DownloadDocTemplateResult> => {
      const template = await loadTemplate(db, files(), { orgId, templateId: input.templateId, version: input.version });
      const fileName = template.system
        ? documentFileName(template.name)
        : documentFileName(`${template.name} v${template.version}`);
      return { fileName, contentBase64: template.data.toString('base64') };
    },
  } satisfies CallableDefinition<typeof DownloadDocTemplateInput, DownloadDocTemplateResult>;
}

export const saveLetterheadDefinition = {
  name: DOC_CALLABLES.saveLetterhead,
  input: SaveLetterheadInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  handler: async ({ input, orgId, uid, db, clock }): Promise<{ saved: true }> => {
    const ref = db.doc(letterheadPath(orgId));
    const now = clock.now();
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      const cleaned = Object.fromEntries(
        Object.entries(input).filter(([key, value]) => key !== 'requestId' && value !== undefined && value !== ''),
      );
      tx.set(
        ref,
        LetterheadDoc.schema.parse({
          ...cleaned,
          createdAt: withDates(current?.['createdAt']) ?? now,
          createdBy: current?.['createdBy'] ?? uid,
          updatedAt: now,
          updatedBy: uid,
          schemaVersion: LetterheadDoc.version,
        }),
      );
    });
    return { saved: true };
  },
} satisfies CallableDefinition<typeof SaveLetterheadInput, { saved: true }>;

export const saveTemplate = defineCallable(saveTemplateDefinition());
export const publishTemplate = defineCallable(publishTemplateDefinition);
export const unpublishTemplate = defineCallable(unpublishTemplateDefinition);
export const deleteTemplate = defineCallable(deleteTemplateDefinition);
export const previewTemplate = defineCallable(previewTemplateDefinition());
export const downloadTemplate = defineCallable(downloadTemplateDefinition());
export const saveLetterhead = defineCallable(saveLetterheadDefinition);
