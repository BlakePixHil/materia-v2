import * as z from 'zod';

import * as domain from '@materia/domain';
import {
  EXPORT_TTL_DAYS,
  exportCollectionName,
  ORG_EXPORT_EXCLUDED,
  ORG_EXPORT_FORMAT,
  ORG_EXPORT_FORMAT_VERSION,
  toPortable,
  type OrgExportManifest,
  type OrgExportRecord,
  type PortableJson,
} from '@materia/domain';

/**
 * The full export's format (SEC-05, ADR-058): which collections it holds, the JSON Schema of each
 * collection's records (generated from the libs/domain schemas, so they can't drift), how a
 * Firestore value is written as portable JSON, and the README.
 */

/** An org-scoped entity of libs/domain, with the export collection its records go to. */
export interface ExportEntity {
  name: string;
  /** Its path pattern (`orgs/{orgId}/matters/{matterId}/tasks`). */
  path: string;
  /** Its own document id, for a settings document (`letterhead`). */
  docId?: string;
  /** `matters.tasks`, or `org` for the org document. */
  collection: string;
  schema: z.ZodType;
}

let entities: ExportEntity[] | undefined;

/** Every org-scoped entity, from libs/domain (the same reflection the seed's `--verify` uses). */
export function exportEntities(): ExportEntity[] {
  entities ??= Object.entries(domain as Record<string, unknown>)
    .flatMap(([name, value]) => {
      const entity = value as { path?: unknown; schema?: unknown; docId?: unknown } | null;
      if (!entity || typeof entity !== 'object' || typeof entity.path !== 'string' || !entity.schema) return [];
      const collection = exportCollectionName(entity.path);
      if (!collection) return [];
      return [
        {
          name,
          path: entity.path,
          ...(typeof entity.docId === 'string' ? { docId: entity.docId } : {}),
          collection,
          schema: entity.schema as z.ZodType,
        },
      ];
    })
    .sort((a, b) => a.collection.localeCompare(b.collection) || a.name.localeCompare(b.name));
  return entities;
}

/** Whether the export leaves this collection out (`ORG_EXPORT_EXCLUDED`). */
export const excludedCollection = (collection: string) =>
  (ORG_EXPORT_EXCLUDED as readonly string[]).includes(collection);

/**
 * The collection groups the export walks, in order: the last segment of each included entity's
 * path (`tasks` holds both `matters.tasks` and `members.tasks`). Groups that only hold excluded
 * collections (Clerk's chunks, OAuth tokens) are never read.
 */
export function exportGroups(): string[] {
  const groups = new Set<string>();
  for (const entity of exportEntities()) {
    if (entity.collection === 'org' || excludedCollection(entity.collection)) continue;
    groups.add(entity.path.split('/').at(-1) as string);
  }
  return [...groups].sort();
}

/**
 * The export collection of a stored document, from its path: the collection ids under the
 * practice joined with dots (`orgs/o1/matters/m1/tasks/t1` → `matters.tasks`).
 */
export function collectionOfPath(orgId: string, path: string): string | null {
  const prefix = `orgs/${orgId}/`;
  if (!path.startsWith(prefix)) return null;
  const segments = path.slice(prefix.length).split('/');
  if (segments.length % 2 !== 0) return null;
  return segments.filter((_, i) => i % 2 === 0).join('.');
}

/** A date as portable JSON: `{"$date": "2026-10-07T01:02:03.000Z"}`. */
const PORTABLE_DATE = {
  type: 'object',
  description: 'An instant: {"$date": ISO 8601 in UTC}.',
  properties: { $date: { type: 'string', format: 'date-time' } },
  required: ['$date'],
  additionalProperties: false,
};

/** A record's fields as JSON Schema, with instants as `{"$date": …}`. */
function dataSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    override: (ctx) => {
      if ((ctx.zodSchema as { _zod: { def: { type: string } } })._zod.def.type === 'date') {
        for (const key of Object.keys(ctx.jsonSchema)) Reflect.deleteProperty(ctx.jsonSchema, key);
        Object.assign(ctx.jsonSchema, PORTABLE_DATE);
      }
    },
  }) as Record<string, unknown>;
  delete json['$schema'];
  return json;
}

/**
 * Each collection's `schemas/{collection}.schema.json`: one JSONL line, `{path, id, data}`, where
 * `data` follows the entity's schema (any of them for a collection of several, like `settings`).
 */
export function exportSchemas(): Map<string, Record<string, unknown>> {
  const byCollection = new Map<string, ExportEntity[]>();
  for (const entity of exportEntities()) {
    if (excludedCollection(entity.collection)) continue;
    byCollection.set(entity.collection, [...(byCollection.get(entity.collection) ?? []), entity]);
  }
  const out = new Map<string, Record<string, unknown>>();
  for (const [collection, list] of [...byCollection].sort(([a], [b]) => a.localeCompare(b))) {
    const data =
      list.length === 1
        ? dataSchema((list[0] as ExportEntity).schema)
        : { anyOf: list.map((e) => dataSchema(e.schema)) };
    out.set(collection, {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `${ORG_EXPORT_FORMAT}/v${ORG_EXPORT_FORMAT_VERSION}/schemas/${collection}.schema.json`,
      title: collection,
      description: `One line of data/${collection}.jsonl (${list.map((e) => e.name).join(', ')}): the record's path in the practice, its id and its fields.`,
      type: 'object',
      required: ['path', 'id', 'data'],
      properties: {
        path: { type: 'string', description: 'The record’s path inside the practice (`matters/m1/tasks/t1`).' },
        id: { type: 'string' },
        data,
      },
      additionalProperties: false,
    });
  }
  return out;
}

export const schemaFileName = (collection: string) => `schemas/${collection}.schema.json`;

const isMap = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

/**
 * A stored Firestore value as portable JSON: Timestamps as `$date`, references as `$ref` (relative
 * to the practice when inside it), GeoPoints as `$geo`, vectors as `$vector`, bytes as `$bytes`.
 */
export function firestorePortable(value: unknown, orgId: string): PortableJson {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown> & { constructor?: { name?: string } };
    if (typeof v['toDate'] === 'function' && typeof v['toMillis'] === 'function') {
      return { $date: (v['toDate'] as () => Date).call(v).toISOString() };
    }
    if (typeof v['path'] === 'string' && typeof v['firestore'] === 'object' && 'parent' in v) {
      const path = v['path'] as string;
      return { $ref: path.startsWith(`orgs/${orgId}/`) ? path.slice(`orgs/${orgId}/`.length) : path };
    }
    if (typeof v['latitude'] === 'number' && typeof v['longitude'] === 'number' && v.constructor?.name === 'GeoPoint') {
      return { $geo: [v['latitude'], v['longitude']] };
    }
    if (typeof v['toArray'] === 'function' && v.constructor?.name === 'VectorValue') {
      return { $vector: (v['toArray'] as () => number[]).call(v) };
    }
    if (Array.isArray(value)) return value.map((item) => firestorePortable(item, orgId));
    if (isMap(value)) {
      const out: Record<string, PortableJson> = {};
      for (const [key, inner] of Object.entries(value))
        if (inner !== undefined) out[key] = firestorePortable(inner, orgId);
      return out;
    }
  }
  return toPortable(value);
}

/** One JSONL record for a stored document. */
export function exportRecord(orgId: string, path: string, data: Record<string, unknown>): OrgExportRecord {
  const relative = path === `orgs/${orgId}` ? '' : path.slice(`orgs/${orgId}/`.length);
  return { path: relative, id: path.split('/').at(-1) as string, data: firestorePortable(data, orgId) };
}

/** A file or folder name safe in any zip tool and file system (no separators, control or reserved characters). */
export function safeName(name: string, fallback = 'file'): string {
  const cleaned = name
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!cleaned) return fallback;
  if (cleaned.length <= 150) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 150 - extension.length) + extension;
}

const size = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** `README.md`, in the last part: what is in the export and how to read and check it. */
export function exportReadme(
  manifest: Omit<OrgExportManifest, 'entries'> & { files: number; fileBytes: number },
): string {
  const collections = Object.entries(manifest.collections).sort(([a], [b]) => a.localeCompare(b));
  const records = collections.reduce((sum, [, count]) => sum + count, 0);
  return `# ${manifest.orgName}: full export

Exported from Materia on ${manifest.createdAt} (UTC) by an owner of the practice.
Format \`${manifest.format}\` version ${manifest.version}. Practice id \`${manifest.orgId}\`.

${manifest.parts > 1 ? `The export is split into ${manifest.parts} zip files. Unzip them all into the same folder: each holds some of the files below, and this one (the last) also holds this README, \`manifest.json\` and \`schemas/\`.` : 'Everything is in this one zip file.'}

**This export holds privileged and confidential material**: client records, file notes, Clerk
conversations and documents marked privileged. It belongs to the practice; keep it as securely as
the practice keeps its files. Materia keeps the download for ${EXPORT_TTL_DAYS} days, then deletes it.

## What is in it

- \`data/{collection}.jsonl\`: ${records.toLocaleString('en-AU')} records in ${collections.length} collections, one JSON object per
  line. A large collection continues in \`{collection}.2.jsonl\`, \`{collection}.3.jsonl\` and so on.
- \`files/matters/{matterId}/{documentId}/v{version}/{file name}\`: ${manifest.files.toLocaleString('en-AU')} stored files (${size(manifest.fileBytes)}),
  ${manifest.allVersions ? 'every version of each matter document' : 'the current version of each matter document'}, then the practice's other stored files
  (document templates, destruction certificates) under \`files/\` by their own paths.
- \`schemas/{collection}.schema.json\`: the JSON Schema (2020-12) of each collection's lines.
- \`manifest.json\`: every file above with its zip, size and SHA-256 checksum, and the record count
  of each collection.

## Records

Each line is \`{"path": "matters/m1/tasks/t1", "id": "t1", "data": {…}}\`: where the record lives in
the practice, its id, and its fields. \`data/org.jsonl\` holds the practice's own settings (its path is
empty). Values JSON can't hold are objects with one key:

| Value | Written as |
|---|---|
| An instant | \`{"$date": "2026-10-07T01:02:03.000Z"}\` (UTC) |
| A reference to another record | \`{"$ref": "matters/m1"}\` |
| Bytes | \`{"$bytes": "<base64>"}\` |
| A map location | \`{"$geo": [latitude, longitude]}\` |
| An embedding vector | \`{"$vector": [numbers]}\` |
| Not a number, or infinite | \`{"$number": "NaN"}\` |

Amounts are integer cents. Legal dates (due dates, dates of death) are \`YYYY-MM-DD\` strings. Ids
link records: a task's \`matterId\` is the id of a line in \`matters.jsonl\`; a document's
\`versions[].sha256\` is the checksum of its file under \`files/\`.

## Checking the files

Every file's SHA-256 is in \`manifest.json\` (\`entries[].sha256\`). On macOS or Linux, after unzipping:

    shasum -a 256 data/matters.jsonl

## Not included

- Connection tokens for Microsoft, Google and Xero (secrets that only work inside Materia), pending
  invitations, export and background jobs, and Clerk's search index (the documents' text cut up for
  search: the documents themselves are in \`files/\`).
- Previews made from documents, and uploads that never finished.
- Each person's own settings, saved views and sign-in history (they belong to the person, not the
  practice).

## Collections

| Collection | Records |
|---|---|
${collections.map(([name, count]) => `| \`${name}\` | ${count.toLocaleString('en-AU')} |`).join('\n')}
`;
}
