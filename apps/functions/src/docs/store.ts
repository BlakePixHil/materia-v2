import { Timestamp, type Firestore } from 'firebase-admin/firestore';

import {
  DocTemplateVersionSchema,
  DomainError,
  isSystemDocTemplateId,
  type DocTemplateKind,
  type DocTemplateVersion,
} from '@materia/domain';

import { systemTemplateDocx } from './system-templates';
import { isDeleted } from '../contacts/shared';
import type { FileStore } from '../documents/files';

/** Where an org's docx templates live (INT-06). */
export const docTemplatePath = (orgId: string, templateId: string) => `orgs/${orgId}/docTemplates/${templateId}`;
export const templateFilePath = (orgId: string, templateId: string, version: number) =>
  `${docTemplatePath(orgId, templateId)}/v${version}.docx`;

export interface LoadedTemplate {
  id: string;
  name: string;
  kind: DocTemplateKind;
  version: number;
  data: Buffer;
  system: boolean;
  /** Warnings recorded when the version was uploaded (fonts the PDF preview substitutes). */
  warnings: string[];
}

type Data = Record<string, unknown>;

/** Firestore Timestamps as Dates, so stored records parse with the domain schemas. */
export function withDates(value: unknown, depth = 0): unknown {
  if (value instanceof Timestamp) return value.toDate();
  if (depth > 6 || value === null || typeof value !== 'object' || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => withDates(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withDates(item, depth + 1)]));
}

export const versionsOfTemplate = (doc: Data | undefined): DocTemplateVersion[] =>
  Array.isArray(doc?.['versions'])
    ? (doc['versions'] as unknown[]).flatMap((v) => {
        const parsed = DocTemplateVersionSchema.safeParse(withDates(v));
        return parsed.success ? [parsed.data] : [];
      })
    : [];

/** An org template that exists and isn't deleted, or NOT_FOUND. */
export async function liveTemplate(db: Firestore, orgId: string, templateId: string): Promise<Data> {
  const snap = await db.doc(docTemplatePath(orgId, templateId)).get();
  const data = snap.data();
  if (!snap.exists || !data || isDeleted(data))
    throw new DomainError('NOT_FOUND', 'Template not found', { templateId });
  return data;
}

/**
 * A template's file and details: a system template, or a version of an org template. `forGeneration`
 * takes the published version and refuses an unpublished template (`template_unpublished`); without
 * it, `version` (default the latest) is read, for test merges and downloads.
 */
export async function loadTemplate(
  db: Firestore,
  files: FileStore,
  input: { orgId: string; templateId: string; version?: number | undefined; forGeneration?: boolean },
): Promise<LoadedTemplate> {
  const { orgId, templateId } = input;
  if (isSystemDocTemplateId(templateId)) {
    if (input.version !== undefined && input.version !== 1) {
      throw new DomainError('NOT_FOUND', 'Version not found', { templateId, version: input.version });
    }
    const { template, data } = systemTemplateDocx(templateId);
    return { id: template.id, name: template.name, kind: template.kind, version: 1, data, system: true, warnings: [] };
  }
  const doc = await liveTemplate(db, orgId, templateId);
  let wanted = input.version ?? Number(doc['version']);
  if (input.forGeneration) {
    if (doc['published'] !== true || typeof doc['publishedVersion'] !== 'number') {
      throw new DomainError('FAILED_PRECONDITION', 'Publish the template before using it', {
        reason: 'template_unpublished',
        templateId,
      });
    }
    wanted = doc['publishedVersion'];
  }
  const version = versionsOfTemplate(doc).find((v) => v.version === wanted);
  if (!version) throw new DomainError('NOT_FOUND', 'Version not found', { templateId, version: wanted });
  const data = await files.read(version.storagePath);
  if (!data) throw new DomainError('UNAVAILABLE', 'The template file couldn’t be read', { templateId });
  return {
    id: templateId,
    name: String(doc['name']),
    kind: doc['kind'] as DocTemplateKind,
    version: version.version,
    data,
    system: false,
    warnings: version.warnings,
  };
}
