import { createHash } from 'node:crypto';

import * as z from 'zod';

import { domain } from '../domain.ts';
import { mapCard, matterIdOf, type CardResult } from './card.ts';
import { mapCollaborators } from './collaborators.ts';
import {
  ENTITIES,
  migId,
  REVIEW_CODES,
  Warnings,
  type EntityName,
  type TransformContext,
  type TransformedRecord,
} from './context.ts';
import { mapDashboardItems } from './dashboard.ts';
import { createdAndUpdated } from './dates.ts';
import { allocateNumbers, type NumberBase } from './numbers.ts';
import { byPath, idmapLine, recordLine, reportJson } from './output.ts';
import { mapPersonalCards } from './personal.ts';
import { mapReferrers } from './referrers.ts';
import { mapChecklistTemplates } from './templates.ts';
import { mapProfile } from './user.ts';
import { cleanText } from './values.ts';
import { mapWorkflow, type WorkflowPlan } from './workflow.ts';
import { byCodeUnit, type ExportRecord } from '../export/jsonl.ts';
import type { ExportFile } from '../export/scope.ts';
import type { ExportManifest } from '../export.ts';
import {
  cardKeyOf,
  docId,
  referencedUids,
  str,
  workflowIdOf,
  type LegacyDoc,
  type StorageObject,
} from '../legacy/snapshot.ts';
import type { MappingProfile } from '../profile.ts';

/**
 * The transform (MIG-03): one exported run (MIG-02's `raw/*.jsonl`) in, the v2 documents a load
 * (MIG-06) writes and the files MIG-05 copies out, as `transformed/{entity}.jsonl` with
 * `idmap.jsonl` and `report.json`. Pure: no clock, no network, no randomness. The reference time
 * is the export's `readTime`, ids are `deterministicId('mig', legacyPath)`, and every output is
 * validated against the `libs/domain` schemas; a record that fails goes to `report.rejects` (with
 * the records under it) instead of the output.
 */

/** An export run as the transform reads it. */
export interface RawRun {
  manifest: ExportManifest;
  files: Partial<Record<ExportFile | 'paths', ExportRecord[]>>;
}

export interface TransformArgs {
  runId: string;
  profile: MappingProfile;
  /** sha256 of the profile file. */
  profileHash: string;
  /** An existing v2 org id, or `new` to create the org. */
  targetOrg: string;
  toolVersion: string;
  /** What the base run allocated, for a delta. */
  base?: NumberBase;
}

export interface Reject {
  entity: EntityName;
  path: string;
  legacyPath: string;
  /** Zod's issue paths, codes and messages: never the values. */
  issues: { path: string; code: string; message: string }[];
}

export interface TransformReport {
  version: 1;
  runId: string;
  uid: string;
  orgId: string;
  targetOrg: 'new' | 'existing';
  /** The export's readTime, which stands in for "now" everywhere. */
  asOf: string;
  kind: ExportManifest['kind'];
  toolVersion: string;
  profileHash: string;
  /** Whether the profile differs from the one the export was read under. */
  profileChanged: boolean;
  counts: { in: Record<string, number>; out: Record<EntityName, number> };
  warnings: ReturnType<Warnings['summary']>;
  needsReview: { records: number; byCode: Record<string, number> };
  rejects: Reject[];
  storage: {
    objects: number;
    /** Files MIG-05 copies: attachments, extracted images and the avatar. */
    copies: number;
    copyBytes: number;
    /** Documents whose legacy object is missing (nothing to copy). */
    missingObjects: number;
    /**
     * Legacy objects no document names, for a decision (D-13, D-18): files under a card with no
     * attachment document, and board-level files (`workflows/{wf}/attachments/`). Names and sizes.
     */
    orphans: { name: string; size: number }[];
  };
  integrations: { provider: string; type: string; connected: boolean }[];
  workspaces: { prime: number; nonPrime: string[] };
  notifications: number | null;
  /**
   * Per output file: lines and sha256. Empty when records were rejected and nothing else was
   * written (no --allow-rejects), so a load can't take stale files for this run's.
   */
  files: Record<string, { count: number; sha256: string }>;
}

export interface TransformOutput {
  /** File name under the run (`transformed/matters.jsonl`) → its text. */
  files: Map<string, string>;
  report: TransformReport;
  /** Whether a record was rejected. */
  rejected: boolean;
}

/** The transform can't run on this input (a delta without its base, another user's profile…). */
export class TransformRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransformRefusedError';
  }
}

/** Where the outputs go in the run, beside the export's `raw/` and `manifest.json`. */
export const OUTPUT_DIR = 'transformed';
export const REPORT_FILE = 'report.json';
export const IDMAP_FILE = 'idmap.jsonl';

/** The schema each output entity must pass. */
const SCHEMAS: Record<Exclude<EntityName, 'avatars'>, z.ZodType> = {
  orgs: domain.OrgSchema,
  users: domain.UserSchema,
  members: domain.MemberSchema,
  counters: domain.CounterSchema,
  contacts: domain.ContactSchema,
  matters: domain.MatterSchema,
  'matter-numbers': domain.MatterNumberSchema,
  tasks: domain.TaskSchema,
  'personal-tasks': domain.PersonalTaskSchema,
  notes: domain.NoteSchema,
  activity: domain.ActivitySchema,
  documents: domain.MatterDocumentSchema,
  'checklist-templates': domain.ChecklistTemplateSchema,
};

/** A file MIG-05 copies (see context.ts `CopyPlan`). */
export const CopyPlanSchema = z
  .object({
    source: z.string().min(1).optional(),
    content: z
      .object({
        encoding: z.literal('base64'),
        data: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .optional(),
    target: z.string().min(1),
    fileName: z.string().min(1).max(255),
    mime: z.string().min(1),
    sizeBytes: z.number().int().min(0),
    md5Hash: z.string().min(1).optional(),
    crc32c: z.string().min(1).optional(),
    generation: z.string().min(1).optional(),
    downloadOnly: z.literal(true).optional(),
  })
  .strict()
  .refine((copy) => !(copy.source && copy.content), { message: 'A copy has a source or content, not both' });

export function runTransform(raw: RawRun, args: TransformArgs): TransformOutput {
  const { manifest } = raw;
  const uid = args.profile.subject.legacyUid;
  if (manifest.uid !== uid) {
    throw new TransformRefusedError(
      `Run ${manifest.runId} exported ${manifest.uid}, not the profile's subject (${uid}).`,
    );
  }
  if (manifest.kind === 'delta' && !args.base) {
    throw new TransformRefusedError(
      `Run ${manifest.runId} is a delta: pass --base-run, the run it continues, so matter numbers don't repeat.`,
    );
  }
  const files = (name: ExportFile | 'paths') => raw.files[name] ?? [];
  const newOrg = args.targetOrg === 'new';
  const ctx: TransformContext = {
    runId: args.runId,
    uid,
    orgId: newOrg ? migId(`profiles/${uid}#org`) : args.targetOrg,
    profile: args.profile,
    timeZone: args.profile.org.timezone,
    asOf: new Date(manifest.readTime.replace(/(\.\d{3})\d+/, '$1')),
    people: peopleOf(files('people')),
    members: new Set([uid]),
    warnings: new Warnings(),
  };
  if (Number.isNaN(ctx.asOf.getTime())) throw new TransformRefusedError(`The manifest's readTime isn't a time.`);

  const records: TransformedRecord[] = [];
  const objects = new Map(files('storage-objects').map((r) => [r.path, objectOf(r)]));

  // The user, their membership and (for a new org) the org; the photo.
  const photo = [...objects.values()].find((o) => o.name.startsWith(`profile-images/${uid}`));
  const profileResult = mapProfile(ctx, {
    profile: files('profiles').find((r) => r.path === `profiles/${uid}`),
    auth: files('auth')[0],
    newOrg,
    photo,
  });
  records.push(...profileResult.records);
  const subjectName = profileResult.subject.displayName;

  // Workspaces merge into the org; integrations are reconnected (D-14).
  const workspaces = { prime: 0, nonPrime: [] as string[] };
  for (const { path, data } of files('workspaces')) {
    if (data?.['isPrime'] === true) workspaces.prime++;
    else {
      workspaces.nonPrime.push(path);
      ctx.warnings.add('MIG_W_NON_PRIME_WORKSPACE', path);
    }
  }
  const integrations = files('integrations').map(({ path, data }) => {
    ctx.warnings.add('MIG_W_INTEGRATION_NOT_MIGRATED', path);
    return {
      provider: cleanText(data?.['provider']) || 'unknown',
      type: cleanText(data?.['type']) || 'unknown',
      connected: data?.['isEnabled'] === true && data['isAuthenticated'] === true,
    };
  });

  // Contacts: referrers, then the other people the data names.
  const referrers = mapReferrers(ctx, files('referrers'));
  const docs = (name: ExportFile): LegacyDoc[] =>
    files(name).flatMap((r) => (r.data ? [{ path: r.path, data: r.data }] : []));
  const collaborators = mapCollaborators(
    ctx,
    [
      ...referencedUids({
        uid,
        workflows: docs('workflows'),
        cards: docs('cards'),
        attachments: docs('attachments'),
      }).keys(),
    ],
    referrers.records,
  );
  const contacts = new Map(referrers.records.map((r) => [r.path, r]));
  for (const record of collaborators.records) contacts.set(record.path, record);
  records.push(...contacts.values());

  // Boards and their cards.
  const plans = new Map<string, WorkflowPlan>();
  for (const workflow of files('workflows')) {
    const plan = mapWorkflow(ctx, workflow);
    if (plan) plans.set(plan.id, plan);
  }
  const attachmentsByCard = new Map<string, ExportRecord[]>();
  for (const attachment of files('attachments')) {
    const key = cardKeyOf(attachment.path);
    if (!key) continue;
    const cardPath = cardPathOf(key);
    attachmentsByCard.set(cardPath, [...(attachmentsByCard.get(cardPath) ?? []), attachment]);
  }
  const cardsByBoard = new Map<string, ExportRecord[]>();
  for (const card of files('cards')) {
    const id = workflowIdOf(card.path);
    if (!id || !card.data || !plans.has(id)) continue;
    cardsByBoard.set(id, [...(cardsByBoard.get(id) ?? []), card]);
  }

  const matterCards: { card: ExportRecord; plan: WorkflowPlan }[] = [];
  for (const [id, cards] of cardsByBoard) {
    const plan = plans.get(id) as WorkflowPlan;
    if (plan.mapping.mode === 'matters') matterCards.push(...cards.map((card) => ({ card, plan })));
    else records.push(...mapPersonalCards(ctx, plan, cards, attachmentsByCard, subjectName));
  }
  matterCards.sort((a, b) => byPath(a.card, b.card));

  const numbers = allocateNumbers(
    ctx,
    matterCards.map(({ card }) => ({
      path: card.path,
      matterId: matterIdOf(card.path),
      createdAt: createdAndUpdated(ctx, card.data ?? {}, card.path).createdAt,
      reference: cleanText(card.data?.['matterReference']),
    })),
    args.base,
  );
  records.push(...numbers.records);

  const results: CardResult[] = matterCards.map(({ card, plan }) =>
    mapCard(ctx, card, {
      plan,
      number: numbers.numbers.get(matterIdOf(card.path)) as string,
      referrers: referrers.contactIds,
      subjectName,
      attachments: attachmentsByCard.get(card.path) ?? [],
      objects,
    }),
  );

  // Second pass: links to cards that are migrated matters (in this run, or a delta's unchanged ones).
  const matterPaths = new Set(matterCards.map(({ card }) => card.path));
  for (const { path } of files('paths')) {
    const id = workflowIdOf(path);
    if (id && plans.get(id)?.mapping.mode === 'matters' && /^workflows\/[^/]+\/cards\/[^/]+$/.test(path)) {
      matterPaths.add(path);
    }
  }
  for (const result of results) {
    const own = result.matter.legacyPath;
    const related = new Set<string>();
    for (const key of result.links) {
      const target = cardPathOf(key);
      if (target === own) continue;
      if (matterPaths.has(target)) related.add(matterIdOf(target));
      else ctx.warnings.add('MIG_W_LINK_DROPPED', own);
    }
    if (result.matter.data) result.matter.data['relatedMatterIds'] = [...related].sort(byCodeUnit);
    records.push(result.matter, ...result.records);
  }

  records.push(...mapDashboardItems(ctx, files('dashboard-checklist-items')));
  records.push(...mapChecklistTemplates(ctx, files('checklist-templates')));

  // Storage: what MIG-05 copies, and what nothing points at.
  const used = new Set<string>();
  for (const attachment of files('attachments')) {
    const key = cardKeyOf(attachment.path);
    if (key) used.add(`${cardPathOf(key)}/attachments/${docId(attachment.path)}`);
  }
  const orphans: { name: string; size: number }[] = [];
  for (const object of objects.values()) {
    const attachment = /^(workflows\/[^/]+\/cards\/[^/]+\/attachments\/[^/.]+)/.exec(object.name);
    const unnamed = attachment
      ? !used.has(attachment[1] as string)
      : /^workflows\/[^/]+\/attachments\//.test(object.name);
    if (unnamed) orphans.push({ name: object.name, size: object.size });
  }

  const { kept, rejects } = validateRecords(records);
  const output = writeOutput(kept);
  const copies = kept.filter((r) => r.copy?.source || r.copy?.content);
  const report: TransformReport = {
    version: 1,
    runId: args.runId,
    uid,
    orgId: ctx.orgId,
    targetOrg: newOrg ? 'new' : 'existing',
    asOf: ctx.asOf.toISOString(),
    kind: manifest.kind,
    toolVersion: args.toolVersion,
    profileHash: args.profileHash,
    profileChanged: args.profileHash !== manifest.profileHash,
    counts: {
      in: Object.fromEntries(Object.entries(raw.files).map(([name, list]) => [name, list?.length ?? 0])),
      out: Object.fromEntries(
        ENTITIES.map((entity) => [entity, kept.filter((r) => r.entity === entity).length]),
      ) as Record<EntityName, number>,
    },
    warnings: ctx.warnings.summary(),
    needsReview: reviewTotals(kept),
    rejects,
    storage: {
      objects: objects.size,
      copies: copies.length,
      copyBytes: copies.reduce((sum, r) => sum + (r.copy?.sizeBytes ?? 0), 0),
      missingObjects: kept.filter((r) => r.entity === 'documents' && r.copy && !r.copy.source && !r.copy.content)
        .length,
      orphans: orphans.sort((a, b) => byCodeUnit(a.name, b.name)),
    },
    integrations: integrations.sort((a, b) => byCodeUnit(`${a.type}/${a.provider}`, `${b.type}/${b.provider}`)),
    workspaces: { prime: workspaces.prime, nonPrime: workspaces.nonPrime.sort(byCodeUnit) },
    notifications: manifest.counts.notifications ?? null,
    files: output.summary,
  };
  output.files.set(REPORT_FILE, reportJson(report));
  return { files: output.files, report, rejected: rejects.length > 0 };
}

/** `{wf}/{card}` → `workflows/{wf}/cards/{card}`. */
function cardPathOf(key: string): string {
  const slash = key.indexOf('/');
  return `workflows/${key.slice(0, slash)}/cards/${key.slice(slash + 1)}`;
}

/** Other users' names from `people.jsonl`: the display name, else first and last; null when gone. */
function peopleOf(people: readonly ExportRecord[]): Map<string, string | null> {
  return new Map(
    people.map(({ path, data }) => {
      const name =
        cleanText(data?.['displayName']) ||
        [cleanText(data?.['firstName']), cleanText(data?.['lastName'])].filter(Boolean).join(' ');
      return [docId(path), name || null];
    }),
  );
}

function objectOf(record: ExportRecord): StorageObject {
  const data = record.data ?? {};
  const optional = (key: string) => (typeof data[key] === 'string' ? { [key]: data[key] as string } : {});
  return {
    name: str(data['name']) ?? record.path,
    size: typeof data['size'] === 'number' ? data['size'] : Number(data['size'] ?? 0),
    ...optional('contentType'),
    ...optional('md5Hash'),
    ...optional('crc32c'),
    ...optional('generation'),
    ...optional('updated'),
  };
}

/**
 * Every record through its schema (and its copy through CopyPlanSchema). A record that fails is
 * rejected with every record under its path, and a matter's number reservation goes with it.
 * Records keep the schema's output, so defaults are filled in as v2 stores them.
 */
export function validateRecords(records: readonly TransformedRecord[]): {
  kept: TransformedRecord[];
  rejects: Reject[];
} {
  const rejects: Reject[] = [];
  const passed: TransformedRecord[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const issues: Reject['issues'] = [];
    if (seen.has(record.path))
      issues.push({ path: '', code: 'duplicate_path', message: 'Another record has this path' });
    seen.add(record.path);
    let data = record.data;
    if (record.entity !== 'avatars') {
      const result = SCHEMAS[record.entity].safeParse(record.data);
      if (result.success) data = result.data as Record<string, unknown>;
      else issues.push(...issuesOf(result.error));
    }
    if (record.copy) {
      const result = CopyPlanSchema.safeParse(record.copy);
      if (!result.success) issues.push(...issuesOf(result.error, 'copy'));
    }
    if (issues.length)
      rejects.push({ entity: record.entity, path: record.path, legacyPath: record.legacyPath, issues });
    else passed.push({ ...record, ...(data ? { data } : {}) });
  }
  const rejected = rejects.map((r) => r.path);
  const rejectedMatters = new Set(rejects.filter((r) => r.entity === 'matters').map((r) => docId(r.path)));
  const kept = passed.filter((record) => {
    const parent = rejected.find((path) => record.path.startsWith(`${path}/`));
    const matterId = record.entity === 'matter-numbers' ? str(record.data?.['matterId']) : undefined;
    if (!parent && !(matterId && rejectedMatters.has(matterId))) return true;
    rejects.push({
      entity: record.entity,
      path: record.path,
      legacyPath: record.legacyPath,
      issues: [{ path: '', code: 'parent_rejected', message: 'The matter or record it belongs to was rejected' }],
    });
    return false;
  });
  return { kept, rejects: rejects.sort(byPath) };
}

function issuesOf(error: z.ZodError, prefix = 'data'): Reject['issues'] {
  return error.issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)].join('.'),
    code: issue.code,
    message: issue.message,
  }));
}

function reviewTotals(records: readonly TransformedRecord[]): TransformReport['needsReview'] {
  const byCode: Record<string, number> = Object.fromEntries(REVIEW_CODES.map((code) => [code, 0]));
  let total = 0;
  for (const record of records) {
    const review = record.data?.['needsReview'];
    if (!Array.isArray(review) || !review.length) continue;
    total++;
    for (const code of review) if (typeof code === 'string') byCode[code] = (byCode[code] ?? 0) + 1;
  }
  return { records: total, byCode };
}

function writeOutput(records: readonly TransformedRecord[]) {
  const files = new Map<string, string>();
  const summary: Record<string, { count: number; sha256: string }> = {};
  const put = (name: string, lines: string[]) => {
    const text = lines.join('');
    files.set(name, text);
    summary[name] = { count: lines.length, sha256: createHash('sha256').update(text).digest('hex') };
  };
  for (const entity of ENTITIES) {
    put(
      `${OUTPUT_DIR}/${entity}.jsonl`,
      records
        .filter((r) => r.entity === entity)
        .sort(byPath)
        .map(recordLine),
    );
  }
  const idmap = records
    .map((r) => ({ legacyPath: r.legacyPath, v2Path: r.path }))
    .sort((a, b) => byCodeUnit(a.legacyPath, b.legacyPath) || byCodeUnit(a.v2Path, b.v2Path));
  put(IDMAP_FILE, idmap.map(idmapLine));
  return { files, summary };
}
