import type { LegacyReader } from './reader.ts';
import type { AuthSummary, LegacyData, LegacyDoc, StorageObject } from './snapshot.ts';

/**
 * The legacy project over plain REST with an OAuth token (Firestore, Cloud Storage JSON, Identity
 * Toolkit and IAM testPermissions), so tests run against a fake `fetch`. Every request is a GET
 * or one of the read-only POSTs in READ_ONLY_POSTS; anything else throws before it is sent.
 * Documents are read with `batchGet` and `runQuery` (paged on a `__name__` cursor), which both
 * take a `readTime`, so the export (MIG-02) reads one consistent snapshot.
 */

/** Where the reader sends requests: Google's APIs, or the Firebase emulators in tests. */
export interface Endpoints {
  firestore: string;
  storage: string;
  identity: string;
}

export const GOOGLE_APIS: Endpoints = {
  firestore: 'https://firestore.googleapis.com/v1',
  storage: 'https://storage.googleapis.com/storage/v1',
  identity: 'https://identitytoolkit.googleapis.com/v1',
};

const RESOURCE_MANAGER = 'https://cloudresourcemanager.googleapis.com/v1';

/** The Firestore, Storage and Auth emulators, from the variables `firebase emulators:exec` sets. */
export function emulatorEndpoints(env: NodeJS.ProcessEnv = process.env): Endpoints {
  const host = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set: run under \`firebase emulators:exec\`.`);
    return value.includes('://') ? value : `http://${value}`;
  };
  return {
    firestore: `${host('FIRESTORE_EMULATOR_HOST')}/v1`,
    storage: `${host('FIREBASE_STORAGE_EMULATOR_HOST')}/storage/v1`,
    identity: `${host('FIREBASE_AUTH_EMULATOR_HOST')}/identitytoolkit.googleapis.com/v1`,
  };
}

/** POST endpoints that only read. */
const READ_ONLY_POSTS = [
  /:runQuery$/,
  /:runAggregationQuery$/,
  /\/documents:batchGet$/,
  /\/accounts:lookup$/,
  /:testIamPermissions$/,
];

/** Documents per `runQuery` page. */
const PAGE_SIZE = 300;

export interface RestDeps {
  fetch: typeof fetch;
  token: () => Promise<string>;
}

export interface LegacyProject {
  project: string;
  bucket: string;
}

/** Throws unless the request only reads: a GET, or a POST to a read-only endpoint. */
export function assertReadOnlyRequest(method: string, url: string): void {
  const bare = url.split('?')[0] ?? url;
  if (method === 'GET') return;
  if (method === 'POST' && READ_ONLY_POSTS.some((pattern) => pattern.test(bare))) return;
  throw new Error(`Refusing to ${method} ${bare}: the migration only reads the legacy project.`);
}

async function call<T>(deps: RestDeps, url: string, body?: unknown): Promise<T | null> {
  const bare = url.split('?')[0] ?? url;
  const method = body === undefined ? 'GET' : 'POST';
  assertReadOnlyRequest(method, url);
  const res = await deps.fetch(url, {
    method,
    headers: { authorization: `Bearer ${await deps.token()}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${bare}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

// ---------- Firestore values ----------

interface FirestoreValue {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number | string;
  timestampValue?: string;
  stringValue?: string;
  bytesValue?: string;
  referenceValue?: string;
  geoPointValue?: { latitude?: number; longitude?: number };
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
}

interface FirestoreDocument {
  name: string;
  fields?: Record<string, FirestoreValue>;
}

/**
 * A REST value as plain JSON; values JSON can't hold become tagged objects (see TaggedValue).
 * `lossless` (the export) keeps bytes whole as base64 and tags doubles JSON can't hold; the
 * audit only needs a byte count.
 */
export function decodeValue(value: FirestoreValue, lossless = false): unknown {
  if ('nullValue' in value) return null;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) {
    const double = Number(value.doubleValue);
    return lossless && !Number.isFinite(double) ? { $double: String(double) } : double;
  }
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.timestampValue !== undefined) return { $timestamp: value.timestampValue };
  if (value.bytesValue !== undefined) {
    return { $bytes: lossless ? value.bytesValue : Math.floor((value.bytesValue.length * 3) / 4) };
  }
  if (value.referenceValue !== undefined) return { $reference: value.referenceValue.replace(/^.*?\/documents\//, '') };
  if (value.geoPointValue !== undefined) {
    return { $geopoint: [value.geoPointValue.latitude ?? 0, value.geoPointValue.longitude ?? 0] };
  }
  if (value.arrayValue !== undefined) return (value.arrayValue.values ?? []).map((v) => decodeValue(v, lossless));
  if (value.mapValue !== undefined) return decodeFields(value.mapValue.fields, lossless);
  return null;
}

function decodeFields(fields: Record<string, FirestoreValue> | undefined, lossless: boolean): LegacyData {
  return Object.fromEntries(Object.entries(fields ?? {}).map(([key, v]) => [key, decodeValue(v, lossless)]));
}

function decodeDocument(doc: FirestoreDocument, lossless: boolean): LegacyDoc {
  return {
    path: doc.name.replace(/^projects\/[^/]+\/databases\/[^/]+\/documents\//, ''),
    data: decodeFields(doc.fields, lossless),
  };
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

// ---------- reader ----------

export interface ReaderOptions {
  /** Google's APIs (the default), or the emulators. */
  endpoints?: Endpoints;
  /** Read every document as it was at this time (RFC 3339). Firestore allows the last hour. */
  readTime?: string;
  /** Keep every value whole (the export); the audit only needs shapes. */
  lossless?: boolean;
}

interface Filter {
  field: string;
  op: 'array-contains' | '==';
  value: string;
}

function fieldFilter({ field, op, value }: Filter) {
  return {
    fieldFilter: {
      field: { fieldPath: field },
      op: op === '==' ? 'EQUAL' : 'ARRAY_CONTAINS',
      value: { stringValue: value },
    },
  };
}

interface RunQueryRow {
  document?: FirestoreDocument;
  readTime?: string;
}

const databaseRoot = (project: string) => `projects/${project}/databases/(default)/documents`;

export function restReader(
  deps: RestDeps,
  { project, bucket }: LegacyProject,
  { endpoints = GOOGLE_APIS, readTime, lossless = false }: ReaderOptions = {},
): LegacyReader {
  const root = databaseRoot(project);
  const documents = `${endpoints.firestore}/${root}`;
  const at = readTime ? { readTime } : {};
  const decode = (doc: FirestoreDocument) => decodeDocument(doc, lossless);

  /** Every document a query matches, a page at a time from a `__name__` cursor. */
  async function runQuery(parent: string, collectionId: string, filter?: Filter): Promise<LegacyDoc[]> {
    const url = parent ? `${documents}/${encodePath(parent)}:runQuery` : `${documents}:runQuery`;
    const out: LegacyDoc[] = [];
    let after: string | undefined;
    for (;;) {
      const rows = await call<RunQueryRow[]>(deps, url, {
        structuredQuery: {
          from: [{ collectionId }],
          ...(filter ? { where: fieldFilter(filter) } : {}),
          orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
          ...(after ? { startAt: { values: [{ referenceValue: after }], before: false } } : {}),
          limit: PAGE_SIZE,
        },
        ...at,
      });
      const page = (rows ?? []).flatMap((row) => (row.document ? [row.document] : []));
      out.push(...page.map(decode));
      const last = page.at(-1);
      if (page.length < PAGE_SIZE || !last) return out;
      after = last.name;
    }
  }

  return {
    async get(path) {
      const rows = await call<{ found?: FirestoreDocument }[]>(deps, `${documents}:batchGet`, {
        documents: [`${root}/${path}`],
        ...at,
      });
      const found = rows?.find((row) => row.found)?.found;
      return found ? decode(found) : null;
    },
    async list(collectionPath) {
      const slash = collectionPath.lastIndexOf('/');
      return runQuery(slash < 0 ? '' : collectionPath.slice(0, slash), collectionPath.slice(slash + 1));
    },
    async query(collectionId, field, op, value) {
      return runQuery('', collectionId, { field, op, value });
    },
    async count(collectionId, field, op, value) {
      const rows = await call<{ result?: { aggregateFields?: Record<string, FirestoreValue> } }[]>(
        deps,
        `${documents}:runAggregationQuery`,
        {
          structuredAggregationQuery: {
            structuredQuery: { from: [{ collectionId }], where: fieldFilter({ field, op, value }) },
            aggregations: [{ alias: 'count', count: {} }],
          },
          ...at,
        },
      );
      return Number(rows?.[0]?.result?.aggregateFields?.['count']?.integerValue ?? 0);
    },
    async objects(prefix) {
      const out: StorageObject[] = [];
      let pageToken = '';
      do {
        const query = new URLSearchParams({
          prefix,
          fields: 'items(name,size,contentType,md5Hash,crc32c,generation,updated),nextPageToken',
          ...(pageToken ? { pageToken } : {}),
        });
        const page = await call<{
          items?: (Omit<StorageObject, 'size'> & { size: string })[];
          nextPageToken?: string;
        }>(deps, `${endpoints.storage}/b/${encodeURIComponent(bucket)}/o?${query}`);
        for (const item of page?.items ?? []) {
          out.push({
            name: item.name,
            size: Number(item.size),
            ...(item.contentType ? { contentType: item.contentType } : {}),
            ...(item.md5Hash ? { md5Hash: item.md5Hash } : {}),
            ...(item.crc32c ? { crc32c: item.crc32c } : {}),
            ...(item.generation ? { generation: item.generation } : {}),
            ...(item.updated ? { updated: item.updated } : {}),
          });
        }
        pageToken = page?.nextPageToken ?? '';
      } while (pageToken);
      return out;
    },
    async authUser(uid) {
      const user = await lookupAuthUser(deps, project, uid, endpoints);
      if (!user)
        return {
          found: false,
          providers: [],
          hasPassword: false,
          mfaEnrolled: false,
          disabled: false,
          emailVerified: false,
        };
      return {
        found: true,
        providers: providerIds(user),
        hasPassword: Boolean(user.passwordHash),
        mfaEnrolled: (user.mfaInfo ?? []).length > 0,
        disabled: user.disabled === true,
        emailVerified: user.emailVerified === true,
      } satisfies AuthSummary;
    },
    async authRecord(uid) {
      const user = await lookupAuthUser(deps, project, uid, endpoints);
      return user ? exportAuthRecord(user) : null;
    },
  };
}

/**
 * The time Firestore reads at now, which pins the export's snapshot. It comes from the server so
 * a fast local clock can't ask for the future. The query matches at most the user's own profile
 * and returns only its name.
 */
export async function serverReadTime(
  deps: RestDeps,
  project: string,
  uid: string,
  endpoints: Endpoints = GOOGLE_APIS,
): Promise<string> {
  const root = databaseRoot(project);
  const rows = await call<RunQueryRow[]>(deps, `${endpoints.firestore}/${root}:runQuery`, {
    structuredQuery: {
      from: [{ collectionId: 'profiles' }],
      select: { fields: [{ fieldPath: '__name__' }] },
      where: {
        fieldFilter: {
          field: { fieldPath: '__name__' },
          op: 'EQUAL',
          value: { referenceValue: `${root}/profiles/${uid}` },
        },
      },
    },
  });
  const readTime = rows?.find((row) => row.readTime)?.readTime;
  if (!readTime) throw new Error('Firestore returned no readTime.');
  return readTime;
}

// ---------- Auth ----------

/** An Identity Toolkit account as `accounts:lookup` returns it (`src/auth/record.ts` parses it). */
export interface IdentityToolkitUser {
  passwordHash?: string;
  providerUserInfo?: { providerId: string; [field: string]: unknown }[];
  mfaInfo?: unknown[];
  disabled?: boolean;
  emailVerified?: boolean;
  [field: string]: unknown;
}

/** The full Auth record of one legacy user (MIG-04), or null if there is none. Read-only. */
export async function lookupAuthUser(
  deps: RestDeps,
  project: string,
  uid: string,
  endpoints: Endpoints = GOOGLE_APIS,
): Promise<IdentityToolkitUser | null> {
  const res = await call<{ users?: IdentityToolkitUser[] }>(
    deps,
    `${endpoints.identity}/projects/${project}/accounts:lookup`,
    { localId: [uid] },
  );
  return res?.users?.[0] ?? null;
}

function providerIds(user: IdentityToolkitUser): string[] {
  return [...new Set((user.providerUserInfo ?? []).map((p) => p.providerId))].sort();
}

/** Identity Toolkit's milliseconds since the epoch as an ISO time; null when absent. */
function isoFromMillis(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const millis = Number(value);
  return value !== '' && Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

/**
 * What the export keeps of the Auth record (MIG-02): providers, email, whether it is verified and
 * the account's dates. Never a password hash, salt, provider id or token: the auth import
 * (MIG-04) reads those itself.
 */
export function exportAuthRecord(user: IdentityToolkitUser): LegacyData {
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
  return {
    email: text(user['email']),
    emailVerified: user.emailVerified === true,
    disabled: user.disabled === true,
    displayName: text(user['displayName']),
    photoUrl: text(user['photoUrl']),
    providers: providerIds(user),
    hasPassword: Boolean(user.passwordHash),
    mfaEnrolled: (user.mfaInfo ?? []).length > 0,
    createdAt: isoFromMillis(user['createdAt']),
    lastSignInAt: isoFromMillis(user['lastLoginAt']),
  };
}

// ---------- IAM ----------

/** Asks IAM which of `permissions` the caller holds, on the project and on the bucket. */
export interface IamTester {
  project(permissions: readonly string[]): Promise<string[]>;
  bucket(permissions: readonly string[]): Promise<string[]>;
}

export function restIamTester(deps: RestDeps, { project, bucket }: LegacyProject): IamTester {
  return {
    async project(permissions) {
      const res = await call<{ permissions?: string[] }>(
        deps,
        `${RESOURCE_MANAGER}/projects/${project}:testIamPermissions`,
        { permissions },
      );
      return res?.permissions ?? [];
    },
    async bucket(permissions) {
      const query = new URLSearchParams(permissions.map((p): [string, string] => ['permissions', p]));
      const res = await call<{ permissions?: string[] }>(
        deps,
        `${GOOGLE_APIS.storage}/b/${encodeURIComponent(bucket)}/iam/testPermissions?${query}`,
      );
      return res?.permissions ?? [];
    },
  };
}
