import { createHash } from 'node:crypto';

import type * as z from 'zod';

import { domain } from '../domain.ts';
import { sha256 } from '../export/jsonl.ts';

/**
 * A made-up transformed run, shaped as MIG-03's transform writes it (`transformed/*.jsonl`,
 * `report.json` listing each file's sha256) with MIG-05's `files/documents.jsonl`, for the load's
 * tests. One legacy card becomes a matter with its client, a party, a checklist task, a comment and
 * an attachment; the member also gets a personal task and a checklist template. Fictional data only.
 */

export const FIXTURE_UID = 'uid-alex-rivers';
export const FIXTURE_ORG = 'org-mig-rivers';
export const FIXTURE_MATTER = 'm-mig-quill';
export const FIXTURE_CARD = 'workflows/wf-rivers/cards/card-quill';
export const FIXTURE_ATTACHMENT = `${FIXTURE_CARD}/attachments/att-letter`;
/** The export's read time, which the transform writes as `migration.loadedAt`. */
export const FIXTURE_READ_TIME = new Date('2026-09-30T00:00:00.000Z');

const CREATED = new Date('2024-03-04T05:06:07.000Z');
const UPDATED = new Date('2024-05-06T07:08:09.000Z');
/** The attachment's bytes, with the hashes the export (MD5) and the copy (sha256) recorded. */
export const FIXTURE_FILE = Buffer.from('%PDF-1.4\n% A made-up letter to the executor.\n%%EOF\n');
const SHA = createHash('sha256').update(FIXTURE_FILE).digest('hex');
const MD5 = createHash('md5').update(FIXTURE_FILE).digest('base64');

type Data = Record<string, unknown>;
export interface FixtureLine {
  path: string;
  legacyPath: string;
  data: Data;
  copy?: Data;
  result?: Data;
}

export interface FixtureOptions {
  runId?: string;
  /** Leave out the org (the run loads into an org that exists). */
  withoutOrg?: boolean;
  /** How the attachment's copy went (MIG-05). */
  outcome?: 'copied' | 'skipped' | 'missing' | 'infected' | 'unscanned' | 'failed';
  /** Change lines before they are written: the tests' way to make a bad run. */
  edit?: (file: string, lines: FixtureLine[]) => FixtureLine[];
}

const ORG_PATH = `orgs/${FIXTURE_ORG}`;
const MATTER_PATH = `${ORG_PATH}/matters/${FIXTURE_MATTER}`;
export const FIXTURE_PATHS = {
  org: ORG_PATH,
  user: `users/${FIXTURE_UID}`,
  member: `${ORG_PATH}/members/${FIXTURE_UID}`,
  counter: `${ORG_PATH}/counters/matter-2024`,
  matterNumber: `${ORG_PATH}/matterNumbers/${domain.matterNumberKey('M-2024-0001')}`,
  contact: `${ORG_PATH}/contacts/c-mig-quill`,
  template: `${ORG_PATH}/checklistTemplates/tpl-mig-probate`,
  matter: MATTER_PATH,
  party: `${MATTER_PATH}/parties/p-mig-client`,
  task: `${MATTER_PATH}/tasks/t-mig-grant`,
  note: `${MATTER_PATH}/notes/n-mig-comment`,
  document: `${MATTER_PATH}/documents/d-mig-letter`,
  personalTask: `${ORG_PATH}/members/${FIXTURE_UID}/tasks/pt-mig-diary`,
} as const;

/** Instants as the transform writes them. */
export function encodeInstants(value: unknown): unknown {
  if (value instanceof Date) return { $timestamp: value.toISOString() };
  if (Array.isArray(value)) return value.map(encodeInstants);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, encodeInstants(item)]),
    );
  }
  return value;
}

/** Whether an entity's documents carry `migration` (the transform writes only those). */
const meta = { createdAt: CREATED, createdBy: FIXTURE_UID, updatedAt: UPDATED, updatedBy: FIXTURE_UID };

function line(
  entity: { schema: z.ZodType; version: number },
  path: string,
  legacyPath: string,
  data: Data,
  runId: string,
  migratable = true,
): FixtureLine {
  const parsed = entity.schema.parse({
    ...meta,
    schemaVersion: entity.version,
    ...data,
    ...(migratable ? { migration: { runId, legacyPath, loadedAt: FIXTURE_READ_TIME } } : {}),
  }) as Data;
  return { path, legacyPath, data: parsed };
}

/** The run's lines by transform file. */
export function fixtureLines(runId: string): Record<string, FixtureLine[]> {
  const d = domain;
  const P = FIXTURE_PATHS;
  const profile = `profiles/${FIXTURE_UID}`;
  const documentData = {
    orgId: FIXTURE_ORG,
    matterId: FIXTURE_MATTER,
    name: 'Letter to the executor.pdf',
    category: 'other',
    privileged: false,
    tags: [],
    scan: { status: 'pending' },
    ingest: { status: 'pending' },
    source: 'migration',
  };
  return {
    orgs: [
      line(
        d.Org,
        P.org,
        `${profile}#org`,
        {
          name: 'Rivers Estate Law (Fictional)',
          practiceType: 'wills_estates',
          jurisdictions: ['VIC'],
          primaryJurisdiction: 'VIC',
          timezone: d.DEFAULT_ORG_TIMEZONE,
          holidayLocality: 'VIC_GREATER_GEELONG',
          billing: {
            unitMinutes: 6,
            rounding: 'up',
            gstRegistered: true,
            defaultRateCents: 45000,
            invoicePrefix: 'INV',
            paymentTermsDays: 14,
          },
          matterNumberFormat: 'M-{YYYY}-{seq:4}',
          fy: { startMonth: 7 },
          retentionYears: 7,
          plan: 'standard',
          security: d.newOrgSecurity(FIXTURE_READ_TIME),
        },
        runId,
      ),
    ],
    users: [
      line(
        d.User,
        P.user,
        profile,
        {
          email: 'alex.rivers@example.com',
          displayName: 'Alex Rivers',
          firstName: 'Alex',
          lastName: 'Rivers',
          orgIds: [FIXTURE_ORG],
          activeOrgId: FIXTURE_ORG,
          memberships: { [FIXTURE_ORG]: { role: 'owner', name: 'Rivers Estate Law (Fictional)' } },
          prefs: {
            theme: 'system',
            density: 'comfortable',
            shortcuts: true,
            notifications: { email: true, push: false, digestHour: 7 },
          },
        },
        runId,
      ),
    ],
    members: [
      line(
        d.Member,
        P.member,
        `${profile}#member`,
        {
          role: 'owner',
          status: 'active',
          displayName: 'Alex Rivers',
          initials: 'AR',
          title: 'Principal',
          defaultRateCents: 45000,
          colour: '#346CFC',
        },
        runId,
      ),
    ],
    counters: [line(d.Counter, P.counter, `${FIXTURE_CARD}#number`, { next: 2 }, runId, false)],
    'matter-numbers': [
      line(
        d.MatterNumber,
        P.matterNumber,
        `${FIXTURE_CARD}#number`,
        { number: 'M-2024-0001', matterId: FIXTURE_MATTER, year: 2024 },
        runId,
        false,
      ),
    ],
    contacts: [
      line(
        d.Contact,
        P.contact,
        `${FIXTURE_CARD}#client`,
        {
          kind: 'person',
          givenNames: 'Quentin',
          familyName: 'Quill',
          emails: [],
          phones: [],
          addresses: [],
          ...d.contactDerivedFields({ kind: 'person', givenNames: 'Quentin', familyName: 'Quill' }),
        },
        runId,
      ),
    ],
    'checklist-templates': [
      line(
        d.ChecklistTemplate,
        P.template,
        `${profile}#checklist-template/probate`,
        { name: 'Probate kick-off', items: ['Order the death certificate'], priority: 'high' },
        runId,
      ),
    ],
    matters: [
      line(
        d.Matter,
        P.matter,
        FIXTURE_CARD,
        {
          number: 'M-2024-0001',
          title: 'Estate of Quentin Quill (fictional)',
          type: 'probate',
          status: 'open',
          jurisdiction: 'VIC',
          responsibleUid: FIXTURE_UID,
          clientContactIds: ['c-mig-quill'],
          fee: { arrangement: 'hourly' },
          costsDisclosure: { status: 'required' },
          conflictCheck: { status: 'clear' },
          search: d.matterSearchTokens({
            number: 'M-2024-0001',
            title: 'Estate of Quentin Quill (fictional)',
            clientNames: ['Quentin Quill'],
          }),
        },
        runId,
      ),
    ],
    parties: [
      line(
        d.Party,
        P.party,
        `${FIXTURE_CARD}#client`,
        { orgId: FIXTURE_ORG, matterId: FIXTURE_MATTER, contactId: 'c-mig-quill', role: 'client' },
        runId,
      ),
    ],
    tasks: [
      line(
        d.Task,
        P.task,
        `${FIXTURE_CARD}#checklist/list-1/item/item-1`,
        {
          orgId: FIXTURE_ORG,
          matterId: FIXTURE_MATTER,
          title: 'Apply for the grant',
          status: 'todo',
          priority: 'high',
          order: 1,
          assigneeUid: FIXTURE_UID,
          source: 'migration',
        },
        runId,
      ),
    ],
    notes: [
      line(
        d.Note,
        P.note,
        `${FIXTURE_CARD}#comment/cm-1`,
        { bodyMd: 'Spoke with the executor about the grant.', mentions: { uids: [], matterIds: [] } },
        runId,
      ),
    ],
    documents: [
      {
        ...line(d.MatterDocument, P.document, FIXTURE_ATTACHMENT, { ...documentData, version: 0, versions: [] }, runId),
        copy: {
          source: `${FIXTURE_CARD}/attachments/att-letter.pdf`,
          md5Hash: MD5,
          target: `${P.document}/v1`,
          fileName: 'Letter to the executor.pdf',
          mime: 'application/pdf',
          sizeBytes: FIXTURE_FILE.length,
        },
      },
    ],
    'personal-tasks': [
      line(
        d.PersonalTask,
        P.personalTask,
        `${profile}#diary/1`,
        { orgId: FIXTURE_ORG, title: 'Diary: call the registry', status: 'todo', order: 1 },
        runId,
      ),
    ],
  };
}

/** The document as copy-files (MIG-05) leaves it: version 1, hashed and scanned. */
function copied(lineIn: FixtureLine, outcome: NonNullable<FixtureOptions['outcome']>): FixtureLine {
  const storagePath = `${lineIn.path}/v1`;
  const done = outcome === 'copied' || outcome === 'skipped';
  const data: Data = done
    ? {
        ...lineIn.data,
        storagePath,
        mime: 'application/pdf',
        sizeBytes: FIXTURE_FILE.length,
        sha256: SHA,
        version: 1,
        versionSeq: 1,
        versions: [
          {
            version: 1,
            storagePath,
            fileName: 'Letter to the executor.pdf',
            mime: 'application/pdf',
            sizeBytes: FIXTURE_FILE.length,
            sha256: SHA,
            uploadedAt: CREATED,
            uploadedBy: FIXTURE_UID,
          },
        ],
        scan: { status: 'clean', at: FIXTURE_READ_TIME },
      }
    : lineIn.data;
  return {
    ...lineIn,
    data: domain.MatterDocument.schema.parse(data) as Data,
    result: { outcome, ...(done ? { sha256: SHA } : {}) },
  };
}

const jsonl = (lines: readonly FixtureLine[]) =>
  lines.map((item) => `${JSON.stringify(encodeInstants(item))}\n`).join('');

/** A run's files, as the sink holds them (names relative to `runs/{runId}/`). */
export function fixtureRun(options: FixtureOptions = {}): Map<string, string> {
  const runId = options.runId ?? 'run-fixture';
  const edit = options.edit ?? ((_file: string, lines: FixtureLine[]) => lines);
  const files = new Map<string, string>();
  const listed: Record<string, { count: number; sha256: string }> = {};
  const lines = fixtureLines(runId);
  if (options.withoutOrg) delete lines['orgs'];
  for (const [file, items] of Object.entries(lines)) {
    const edited = edit(file, items);
    const text = jsonl(edited);
    files.set(`transformed/${file}.jsonl`, text);
    listed[`transformed/${file}.jsonl`] = { count: edited.length, sha256: sha256(text) };
  }
  const idmap = Object.values(lines)
    .flat()
    .map((item) => `${JSON.stringify({ legacyPath: item.legacyPath, v2Path: item.path })}\n`)
    .join('');
  files.set('idmap.jsonl', idmap);
  listed['idmap.jsonl'] = { count: idmap.split('\n').length - 1, sha256: sha256(idmap) };
  files.set('report.json', JSON.stringify({ runId, files: listed, rejects: [], warnings: [] }));
  const documents = edit(
    'files/documents.jsonl',
    (lines['documents'] ?? []).map((item) => copied(item, options.outcome ?? 'copied')),
  );
  files.set('files/documents.jsonl', jsonl(documents));
  files.set('manifest.json', JSON.stringify({ runId, counts: { cards: 1, attachments: 1 } }));
  return files;
}
