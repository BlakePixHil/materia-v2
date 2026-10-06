import {
  cardKeyOf,
  linkedCardKeys,
  profileName,
  referencedUids,
  type AuthSummary,
  type LegacyData,
  type LegacyDoc,
  type LegacySnapshot,
  type StorageObject,
} from './snapshot.ts';

/**
 * Read-only access to the legacy project. There is deliberately no write method: the REST reader
 * sends only GETs and read-only POSTs (`:runQuery`, `:batchGet`…), and the audit and export check
 * the credentials can't write before they start (audit/iam.ts).
 */
export interface LegacyReader {
  get(path: string): Promise<LegacyDoc | null>;
  /** Every document in a collection (`workflows/{wf}/cards`). */
  list(collectionPath: string): Promise<LegacyDoc[]>;
  /** A top-level collection filtered on one field. */
  query(collectionId: string, field: string, op: 'array-contains' | '==', value: string): Promise<LegacyDoc[]>;
  /** How many documents of a top-level collection match one field (the export's notifications count). */
  count?(collectionId: string, field: string, op: 'array-contains' | '==', value: string): Promise<number>;
  /** Storage objects whose names start with `prefix`. */
  objects(prefix: string): Promise<StorageObject[]>;
  /** The Auth record's sign-in facts, or undefined when the reader can't see Auth. */
  authUser?(uid: string): Promise<AuthSummary | undefined>;
  /** The Auth record as the export keeps it (rest.ts `exportAuthRecord`), or null when there is none. */
  authRecord?(uid: string): Promise<LegacyData | null>;
}

/** A reader over documents in memory: the fixtures in tests. */
export function memoryReader(docs: readonly LegacyDoc[], objects: readonly StorageObject[] = []): LegacyReader {
  const byPath = new Map(docs.map((doc) => [doc.path, doc]));
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
  const matching = (collectionId: string, field: string, op: 'array-contains' | '==', value: string) =>
    docs.filter((doc) => {
      if (parentOf(doc.path) !== collectionId) return false;
      const fieldValue = doc.data[field];
      return op === '==' ? fieldValue === value : Array.isArray(fieldValue) && fieldValue.includes(value);
    });
  return {
    async get(path) {
      return byPath.get(path) ?? null;
    },
    async list(collectionPath) {
      return docs.filter((doc) => parentOf(doc.path) === collectionPath);
    },
    async query(collectionId, field, op, value) {
      return matching(collectionId, field, op, value);
    },
    async count(collectionId, field, op, value) {
      return matching(collectionId, field, op, value).length;
    },
    async objects(prefix) {
      return objects.filter((object) => object.name.startsWith(prefix));
    },
  };
}

function uniqueByPath(docs: LegacyDoc[]): LegacyDoc[] {
  return [...new Map(docs.map((doc) => [doc.path, doc])).values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  // One iterator shared by the workers: each takes the next item when it is free.
  const queue = items.entries();
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (const [index, item] of queue) results[index] = await fn(item);
  });
  await Promise.all(workers);
  return results;
}

/**
 * Reads everything the migration could touch for one user: their profile, dashboard items and
 * integrations; every workflow they are a member of (or legacy owner of) with its cards,
 * attachments, checklist templates and Storage objects; their referrers and workspaces; the names
 * of the other users the data references; and whether linked cards outside those workflows exist.
 * The audit decides scope afterwards, so shared boards are read too (counts only end up in the report).
 */
export async function collectSnapshot(
  reader: LegacyReader,
  uid: string,
  { concurrency = 8 }: { concurrency?: number } = {},
): Promise<LegacySnapshot> {
  const [profile, dashboardItems, integrations, byMember, byOwner, referrers, workspaces, profileImages, auth] =
    await Promise.all([
      reader.get(`profiles/${uid}`),
      reader.list(`profiles/${uid}/dashboard-checklist-items`),
      reader.list(`profiles/${uid}/integrations`),
      reader.query('workflows', 'uids', 'array-contains', uid),
      reader.query('workflows', 'owner', '==', uid),
      reader.query('referrers', 'uids', 'array-contains', uid),
      reader.query('workspaces', 'uids', 'array-contains', uid),
      reader.objects(`profile-images/${uid}`),
      reader.authUser?.(uid),
    ]);
  const workflows = uniqueByPath([...byMember, ...byOwner]);

  const perWorkflow = await mapLimit(workflows, concurrency, async (workflow) => {
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

  const people: LegacySnapshot['people'] = {};
  const others = [...referencedUids({ uid, workflows, cards, attachments }).keys()].sort();
  await mapLimit(others, concurrency, async (other) => {
    const doc = await reader.get(`profiles/${other}`);
    // Names only: nothing else from another user's profile is kept.
    people[other] = { exists: doc !== null, name: profileName(doc?.data) };
  });

  const known = new Set(cards.map((card) => cardKeyOf(card.path)));
  const elsewhere = [...new Set(cards.flatMap(linkedCardKeys))].filter((key) => !known.has(key)).sort();
  const linkedCardsElsewhere: LegacySnapshot['linkedCardsElsewhere'] = {};
  await mapLimit(elsewhere, concurrency, async (key) => {
    const [workflowId, cardId] = key.split('/');
    linkedCardsElsewhere[key] = (await reader.get(`workflows/${workflowId}/cards/${cardId}`)) !== null;
  });

  return {
    uid,
    profile,
    workspaces: uniqueByPath(workspaces),
    workflows,
    cards: uniqueByPath(cards),
    attachments: uniqueByPath(attachments),
    checklistTemplates: uniqueByPath(perWorkflow.flatMap((w) => w.checklistTemplates)),
    referrers: uniqueByPath(referrers),
    dashboardItems: uniqueByPath(dashboardItems),
    integrations: uniqueByPath(integrations),
    storageObjects: [...perWorkflow.flatMap((w) => w.objects), ...profileImages].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    people,
    linkedCardsElsewhere,
    ...(auth ? { auth } : {}),
  };
}
