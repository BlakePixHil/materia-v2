import { mentionUids } from './html.ts';

/**
 * One user's legacy data as the audit (MIG-01) reads it, and as the export (MIG-02) will write it:
 * Firestore documents by path with their decoded data, plus the Storage objects under the user's
 * workflows. Legacy shapes vary by app version, so data stays loosely typed (`LegacyData`) and
 * every reader checks the shape it needs.
 */

export type LegacyData = Record<string, unknown>;

/** A legacy Firestore document: `workflows/{wf}/cards/{card}` and its decoded fields. */
export interface LegacyDoc {
  path: string;
  data: LegacyData;
}

/** A legacy Storage object (no content, no download token). */
export interface StorageObject {
  name: string;
  size: number;
  contentType?: string;
}

/**
 * Firestore values with no JSON form, as the REST decoder and the fixtures write them. The legacy
 * app stores ISO strings, so a `$timestamp` is itself a finding.
 */
export type TaggedValue =
  { $timestamp: string } | { $bytes: number } | { $reference: string } | { $geopoint: [number, number] };

const TAGS = ['$timestamp', '$bytes', '$reference', '$geopoint'] as const;

export function taggedKind(value: unknown): 'timestamp' | 'bytes' | 'reference' | 'geopoint' | undefined {
  if (!isPlainObject(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  const tag = TAGS.find((t) => t === keys[0]);
  return tag ? (tag.slice(1) as 'timestamp' | 'bytes' | 'reference' | 'geopoint') : undefined;
}

export function isPlainObject(value: unknown): value is LegacyData {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A referenced legacy user: whether their profile still exists, and the name it holds. */
export interface Person {
  exists: boolean;
  name: string | null;
}

export interface LegacySnapshot {
  /** The designated user's legacy uid. */
  uid: string;
  profile: LegacyDoc | null;
  workspaces: LegacyDoc[];
  /** Every workflow whose `uids` holds the user, or whose legacy `owner` is the user. */
  workflows: LegacyDoc[];
  cards: LegacyDoc[];
  attachments: LegacyDoc[];
  checklistTemplates: LegacyDoc[];
  referrers: LegacyDoc[];
  dashboardItems: LegacyDoc[];
  integrations: LegacyDoc[];
  /** Objects under `workflows/{wf}/` for the snapshot's workflows, plus `profile-images/{uid}*`. */
  storageObjects: StorageObject[];
  /** Other legacy users the data references, by uid (names only, from their profiles). */
  people: Record<string, Person>;
  /** Linked cards outside the snapshot, by `{workflowId}/{cardId}`: whether the card exists. */
  linkedCardsElsewhere: Record<string, boolean>;
  /** The user's Firebase Auth record, as MIG-04 needs it; absent without `firebaseauth.users.get`. */
  auth?: AuthSummary;
}

/** Sign-in facts for the auth import (MIG-04): provider ids and flags, never hashes or emails. */
export interface AuthSummary {
  found: boolean;
  providers: string[];
  hasPassword: boolean;
  mfaEnrolled: boolean;
  disabled: boolean;
  emailVerified: boolean;
}

// ---------- paths ----------

/** The last path segment: the document id. */
export function docId(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `workflows/{wf}/…` → `wf`; undefined for any other path. */
export function workflowIdOf(path: string): string | undefined {
  return /^workflows\/([^/]+)/.exec(path)?.[1];
}

/** `workflows/{wf}/cards/{card}/…` → `{wf}/{card}`; undefined for any other path. */
export function cardKeyOf(path: string): string | undefined {
  const match = /^workflows\/([^/]+)\/cards\/([^/]+)/.exec(path);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

// ---------- field access ----------

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function obj(value: unknown): LegacyData | undefined {
  return isPlainObject(value) ? value : undefined;
}

/**
 * Every value at a dotted path, where `[]` steps into each array element:
 * `valuesAt(card, 'checklists[].items[].dueDate')`. A missing field yields `undefined`, so callers
 * can count absences; a missing parent yields nothing.
 */
export function valuesAt(data: unknown, path: string): unknown[] {
  let current: unknown[] = [data];
  for (const part of path.split('.')) {
    const isArray = part.endsWith('[]');
    const key = isArray ? part.slice(0, -2) : part;
    const next: unknown[] = [];
    for (const value of current) {
      const parent = obj(value);
      if (!parent) continue;
      const child = parent[key];
      if (isArray) next.push(...arr(child));
      else next.push(child);
    }
    current = next;
  }
  return current;
}

// ---------- linked cards ----------

/** A card's links as `{workflowId}/{cardId}` keys: legacy stores `{cardId, workflowId}`; very old cards stored bare ids. */
export function linkedCardKeys(card: LegacyDoc): string[] {
  const ownWorkflow = workflowIdOf(card.path) ?? '';
  return arr(card.data['linkedCardIds']).flatMap((link) => {
    if (typeof link === 'string') return link ? [`${ownWorkflow}/${link}`] : [];
    const value = obj(link);
    const cardId = str(value?.['cardId']);
    if (!cardId) return [];
    return [`${str(value?.['workflowId']) || ownWorkflow}/${cardId}`];
  });
}

// ---------- referenced users ----------

export const REFERENCE_KINDS = [
  'workflow_member',
  'assignee',
  'comment_author',
  'history_actor',
  'mention',
  'attachment_uploader',
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

type SnapshotData = Pick<LegacySnapshot, 'uid' | 'workflows' | 'cards' | 'attachments'>;

/**
 * Every other legacy user the data references (workflow members, assignees, comment authors,
 * history actors, mention targets, attachment uploaders), with a count per kind. The union of
 * `uids` and `users` counts as membership, since the two drift.
 */
export function referencedUids(snapshot: SnapshotData): Map<string, Partial<Record<ReferenceKind, number>>> {
  const refs = new Map<string, Partial<Record<ReferenceKind, number>>>();
  const add = (uid: unknown, kind: ReferenceKind) => {
    if (typeof uid !== 'string' || !uid || uid === snapshot.uid) return;
    const entry = refs.get(uid) ?? {};
    entry[kind] = (entry[kind] ?? 0) + 1;
    refs.set(uid, entry);
  };
  for (const workflow of snapshot.workflows) {
    const members = new Set([
      ...arr(workflow.data['uids']).filter((u): u is string => typeof u === 'string'),
      ...Object.keys(obj(workflow.data['users']) ?? {}),
    ]);
    for (const uid of members) add(uid, 'workflow_member');
  }
  for (const card of snapshot.cards) {
    add(card.data['assignee'], 'assignee');
    for (const comment of arr(card.data['comments'])) {
      add(obj(comment)?.['uid'], 'comment_author');
      for (const uid of mentionUids(str(obj(comment)?.['comment']) ?? '')) add(uid, 'mention');
    }
    for (const entry of arr(card.data['history'])) add(obj(entry)?.['uid'], 'history_actor');
    for (const uid of mentionUids(str(card.data['description']) ?? '')) add(uid, 'mention');
  }
  for (const attachment of snapshot.attachments) {
    add(attachment.data['uploadedBy'], 'attachment_uploader');
  }
  return refs;
}

/** The name a legacy profile shows: `displayName`, else first and last name; null when it has none. */
export function profileName(data: LegacyData | undefined): string | null {
  if (!data) return null;
  const display = str(data['displayName'])?.trim();
  if (display) return display;
  const full = [str(data['firstName']), str(data['lastName'])]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ');
  return full || null;
}

/** The roles a workflow gives a user (`users[uid].roles`, true flags only), plus `owner` from the legacy `owner` field. */
export function workflowRoles(workflow: LegacyData, uid: string): string[] {
  const roles = obj(obj(obj(workflow['users'])?.[uid])?.['roles']) ?? {};
  const granted = Object.entries(roles)
    .filter(([, on]) => on === true)
    .map(([role]) => role);
  if (workflow['owner'] === uid && !granted.includes('owner')) granted.push('owner');
  return granted.sort();
}
