import { mapLimit, type LegacyReader } from '../legacy/reader.ts';
import {
  docId,
  referencedUids,
  str,
  taggedKind,
  type LegacyData,
  type LegacyDoc,
  type StorageObject,
} from '../legacy/snapshot.ts';
import { findWorkflowMapping, type MappingProfile } from '../profile.ts';
import { sortRecords, withoutDownloadTokens, type ExportRecord } from './jsonl.ts';

/**
 * What the export (MIG-02) reads for one user, as records per file. The scope is the audit's
 * (legacy/reader.ts `collectSnapshot`) narrowed by the mapping profile: workflows the profile
 * excludes are left out with their cards, and other users' profiles shrink to their names.
 */

/** The `raw/*.jsonl` files, in the order they are written. */
export const EXPORT_FILES = [
  'profiles',
  'dashboard-checklist-items',
  'integrations',
  'workspaces',
  'workflows',
  'cards',
  'attachments',
  'checklist-templates',
  'referrers',
  'people',
  'auth',
  'storage-objects',
] as const;
export type ExportFile = (typeof EXPORT_FILES)[number];

/** Files read from Firestore at the snapshot's readTime; Storage and Auth have no readTime. */
export const SNAPSHOT_FILES: ReadonlySet<ExportFile> = new Set(
  EXPORT_FILES.filter((file) => file !== 'auth' && file !== 'storage-objects'),
);

/** The only fields kept from another user's profile. */
export const PERSON_FIELDS = ['displayName', 'firstName', 'lastName'] as const;

/** The collections a delta filters on `updatedOn`; everything else is small and goes in full. */
export const DELTA_FILES = ['cards', 'attachments'] as const;

export interface ExportScope {
  files: Record<ExportFile, ExportRecord[]>;
  /** Workflow ids the user is a member or legacy owner of, by what the profile says. */
  workflows: { exported: string[]; excluded: string[]; unmapped: string[] };
  /** Notifications addressed to the user (`recipientUids`): counted, never exported. Null when the reader can't count. */
  notifications: number | null;
  /** Download tokens taken out of URLs (see jsonl.ts). */
  downloadTokensStripped: number;
  warnings: string[];
  delta?: DeltaScope;
}

export interface DeltaScope {
  since: string;
  /** Every in-scope card and attachment path, changed or not, so the load can see what was deleted. */
  paths: ExportRecord[];
  /** In-scope records left out because they haven't changed. */
  unchanged: Record<(typeof DELTA_FILES)[number], number>;
  /** Records whose `updatedOn` isn't an ISO string (a Timestamp, missing, or not a date), per file: these go in. */
  nonUniform: Partial<Record<(typeof DELTA_FILES)[number], number>>;
}

/** The profile doesn't say what to do with some of the user's workflows: a person updates it first. */
export class UnmappedWorkflowsError extends Error {
  constructor(readonly workflowIds: string[]) {
    super(
      `The mapping profile doesn't map ${workflowIds.length} of the user's workflows (ids ${workflowIds.join(', ')}). ` +
        'Run a fresh audit and `check-profile --report`, add them to the profile, then export again.',
    );
    this.name = 'UnmappedWorkflowsError';
  }
}

export interface ExportOptions {
  uid: string;
  profile: MappingProfile;
  /** A delta: only cards and attachments changed after this time (ISO). */
  since?: string;
  /** Whether the credentials can read Auth (`firebaseauth.users.get`). */
  readAuth: boolean;
  concurrency?: number;
}

export async function collectExport(reader: LegacyReader, options: ExportOptions): Promise<ExportScope> {
  const { uid, profile, since, readAuth, concurrency = 8 } = options;
  const warnings: string[] = [];
  const [subject, dashboardItems, integrations, byMember, byOwner, referrers, workspaces, profileImages] =
    await Promise.all([
      reader.get(`profiles/${uid}`),
      reader.list(`profiles/${uid}/dashboard-checklist-items`),
      reader.list(`profiles/${uid}/integrations`),
      reader.query('workflows', 'uids', 'array-contains', uid),
      reader.query('workflows', 'owner', '==', uid),
      reader.query('referrers', 'uids', 'array-contains', uid),
      reader.query('workspaces', 'uids', 'array-contains', uid),
      reader.objects(`profile-images/${uid}`),
    ]);
  if (!subject) warnings.push("The user's profile document is missing.");

  // Scope: the profile decides each workflow. One it doesn't name stops the export before any card is read.
  const workflows = { exported: [] as LegacyDoc[], excluded: [] as string[], unmapped: [] as string[] };
  for (const workflow of sortRecords([...byMember, ...byOwner])) {
    const id = docId(workflow.path);
    const mapping = findWorkflowMapping(profile, { id, name: str(workflow.data['name']) ?? '' });
    if (!mapping) workflows.unmapped.push(id);
    else if (mapping.mode === 'exclude') workflows.excluded.push(id);
    else workflows.exported.push(workflow);
  }
  if (workflows.unmapped.length) throw new UnmappedWorkflowsError(workflows.unmapped);

  const perWorkflow = await mapLimit(workflows.exported, concurrency, async (workflow) => {
    const [cards, checklistTemplates, objects] = await Promise.all([
      reader.list(`${workflow.path}/cards`),
      reader.list(`${workflow.path}/checklist-templates`),
      reader.objects(`${workflow.path}/`),
    ]);
    const attachments = (await mapLimit(cards, concurrency, (card) => reader.list(`${card.path}/attachments`))).flat();
    return { cards, checklistTemplates, objects, attachments };
  });
  const cards = perWorkflow.flatMap((w) => w.cards);
  const attachments = perWorkflow.flatMap((w) => w.attachments);

  // Other users the exported data names: their names only, or null when their profile is gone.
  const others = [...referencedUids({ uid, workflows: workflows.exported, cards, attachments }).keys()];
  const people = await mapLimit(others, concurrency, async (other): Promise<ExportRecord> => {
    const doc = await reader.get(`profiles/${other}`);
    return { path: `profiles/${other}`, data: doc ? personName(doc.data) : null };
  });

  const [notifications, auth] = await Promise.all([
    reader.count ? reader.count('notifications', 'recipientUids', 'array-contains', uid) : Promise.resolve(null),
    readAuth && reader.authRecord ? reader.authRecord(uid) : Promise.resolve(undefined),
  ]);
  if (notifications === null) warnings.push("The reader can't count notifications.");
  if (auth === undefined)
    warnings.push("These credentials can't read Auth (firebaseauth.users.get), so auth.jsonl is empty.");
  if (auth === null) warnings.push('The user has no Auth account.');

  const ownImage = (object: StorageObject) =>
    object.name === `profile-images/${uid}` ||
    object.name.startsWith(`profile-images/${uid}.`) ||
    object.name.startsWith(`profile-images/${uid}/`);
  const objects = [...perWorkflow.flatMap((w) => w.objects), ...profileImages.filter(ownImage)];

  const counter = { stripped: 0 };
  const records = (docs: readonly LegacyDoc[]) =>
    sortRecords(docs.map((doc) => ({ path: doc.path, data: withoutDownloadTokens(doc.data, counter) })));
  const files: Record<ExportFile, ExportRecord[]> = {
    profiles: records(subject ? [subject] : []),
    'dashboard-checklist-items': records(dashboardItems),
    integrations: records(integrations),
    workspaces: records(workspaces),
    workflows: records(workflows.exported),
    cards: records(cards),
    attachments: records(attachments),
    'checklist-templates': records(perWorkflow.flatMap((w) => w.checklistTemplates)),
    referrers: records(referrers),
    people: sortRecords(people),
    auth: auth ? [{ path: `auth/${uid}`, data: auth }] : [],
    'storage-objects': sortRecords(objects.map((object) => ({ path: object.name, data: objectRecord(object) }))),
  };

  const scope: ExportScope = {
    files,
    workflows: { exported: workflows.exported.map((w) => docId(w.path)), excluded: workflows.excluded, unmapped: [] },
    notifications,
    downloadTokensStripped: counter.stripped,
    warnings,
  };
  return since ? narrowToDelta(scope, since) : scope;
}

function personName(data: LegacyData): LegacyData {
  return Object.fromEntries(PERSON_FIELDS.flatMap((field) => (field in data ? [[field, data[field]]] : [])));
}

function objectRecord(object: StorageObject): LegacyData {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

// ---------- delta ----------

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A legacy date field as epoch milliseconds: an ISO string or a Firestore Timestamp; undefined otherwise. */
function stamp(value: unknown): number | undefined {
  const text =
    typeof value === 'string'
      ? value
      : taggedKind(value) === 'timestamp'
        ? str((value as LegacyData)['$timestamp'])
        : '';
  if (!text || !ISO_DATETIME.test(text)) return undefined;
  const millis = Date.parse(text);
  return Number.isNaN(millis) ? undefined : millis;
}

/**
 * Whether a record changed after `since`: its `updatedOn` or `createdOn` is later (some legacy
 * records were updated "before" they were created). A record with neither date readable counts
 * as changed, so a delta never misses it.
 */
export function changedSince(data: LegacyData | null, since: number): boolean {
  const stamps = [stamp(data?.['updatedOn']), stamp(data?.['createdOn'])].filter((s) => s !== undefined);
  return stamps.length === 0 || stamps.some((s) => s > since);
}

/** A delta keeps cards and attachments changed since `since`, with every attachment of a changed card. */
function narrowToDelta(scope: ExportScope, since: string): ExportScope {
  const sinceMillis = Date.parse(since);
  const nonUniform: DeltaScope['nonUniform'] = {};
  const notUniform = (file: (typeof DELTA_FILES)[number], records: ExportRecord[]) => {
    const count = records.filter(
      (r) => typeof r.data?.['updatedOn'] !== 'string' || !ISO_DATETIME.test(r.data['updatedOn']),
    ).length;
    if (count) nonUniform[file] = count;
  };
  const { cards, attachments } = scope.files;
  notUniform('cards', cards);
  notUniform('attachments', attachments);

  const changedCards = cards.filter((card) => changedSince(card.data, sinceMillis));
  const changedCardPaths = new Set(changedCards.map((card) => card.path));
  const cardOf = (path: string) => path.slice(0, path.indexOf('/attachments/'));
  const changedAttachments = attachments.filter(
    (a) => changedCardPaths.has(cardOf(a.path)) || changedSince(a.data, sinceMillis),
  );
  return {
    ...scope,
    files: { ...scope.files, cards: changedCards, attachments: changedAttachments },
    delta: {
      since,
      paths: sortRecords([...cards, ...attachments].map((r) => ({ path: r.path, data: null }))),
      unchanged: {
        cards: cards.length - changedCards.length,
        attachments: attachments.length - changedAttachments.length,
      },
      nonUniform,
    },
  };
}
