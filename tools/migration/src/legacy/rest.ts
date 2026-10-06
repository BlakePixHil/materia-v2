import type { LegacyReader } from './reader.ts';
import type { AuthSummary, LegacyData, LegacyDoc, StorageObject } from './snapshot.ts';

/**
 * The legacy project over plain REST with an OAuth token (Firestore, Cloud Storage JSON, Identity
 * Toolkit and IAM testPermissions), so tests run against a fake `fetch`. Every request is a GET
 * or one of the read-only POSTs in READ_ONLY_POSTS; anything else throws before it is sent.
 */

const FIRESTORE = 'https://firestore.googleapis.com/v1';
const STORAGE = 'https://storage.googleapis.com/storage/v1';
const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';
const RESOURCE_MANAGER = 'https://cloudresourcemanager.googleapis.com/v1';

/** POST endpoints that only read. */
const READ_ONLY_POSTS = [/:runQuery$/, /\/accounts:lookup$/, /:testIamPermissions$/];

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
  throw new Error(`Refusing to ${method} ${bare}: the migration audit only reads.`);
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

/** A REST value as plain JSON; values JSON can't hold become tagged objects (see TaggedValue). */
export function decodeValue(value: FirestoreValue): unknown {
  if ('nullValue' in value) return null;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return Number(value.doubleValue);
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.timestampValue !== undefined) return { $timestamp: value.timestampValue };
  if (value.bytesValue !== undefined) return { $bytes: Math.floor((value.bytesValue.length * 3) / 4) };
  if (value.referenceValue !== undefined) return { $reference: value.referenceValue.replace(/^.*?\/documents\//, '') };
  if (value.geoPointValue !== undefined) {
    return { $geopoint: [value.geoPointValue.latitude ?? 0, value.geoPointValue.longitude ?? 0] };
  }
  if (value.arrayValue !== undefined) return (value.arrayValue.values ?? []).map(decodeValue);
  if (value.mapValue !== undefined) return decodeFields(value.mapValue.fields);
  return null;
}

function decodeFields(fields: Record<string, FirestoreValue> | undefined): LegacyData {
  return Object.fromEntries(Object.entries(fields ?? {}).map(([key, v]) => [key, decodeValue(v)]));
}

function decodeDocument(doc: FirestoreDocument): LegacyDoc {
  return {
    path: doc.name.replace(/^projects\/[^/]+\/databases\/[^/]+\/documents\//, ''),
    data: decodeFields(doc.fields),
  };
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

// ---------- reader ----------

export function restReader(deps: RestDeps, { project, bucket }: LegacyProject): LegacyReader {
  const documents = `${FIRESTORE}/projects/${project}/databases/(default)/documents`;
  return {
    async get(path) {
      const doc = await call<FirestoreDocument>(deps, `${documents}/${encodePath(path)}`);
      return doc ? decodeDocument(doc) : null;
    },
    async list(collectionPath) {
      const out: LegacyDoc[] = [];
      let pageToken = '';
      do {
        const query = new URLSearchParams({ pageSize: '300', ...(pageToken ? { pageToken } : {}) });
        const page = await call<{ documents?: FirestoreDocument[]; nextPageToken?: string }>(
          deps,
          `${documents}/${encodePath(collectionPath)}?${query}`,
        );
        out.push(...(page?.documents ?? []).map(decodeDocument));
        pageToken = page?.nextPageToken ?? '';
      } while (pageToken);
      return out;
    },
    async query(collectionId, field, op, value) {
      const rows = await call<{ document?: FirestoreDocument }[]>(deps, `${documents}:runQuery`, {
        structuredQuery: {
          from: [{ collectionId }],
          where: {
            fieldFilter: {
              field: { fieldPath: field },
              op: op === '==' ? 'EQUAL' : 'ARRAY_CONTAINS',
              value: { stringValue: value },
            },
          },
        },
      });
      return (rows ?? []).flatMap((row) => (row.document ? [decodeDocument(row.document)] : []));
    },
    async objects(prefix) {
      const out: StorageObject[] = [];
      let pageToken = '';
      do {
        const query = new URLSearchParams({
          prefix,
          fields: 'items(name,size,contentType),nextPageToken',
          ...(pageToken ? { pageToken } : {}),
        });
        const page = await call<{
          items?: { name: string; size: string; contentType?: string }[];
          nextPageToken?: string;
        }>(deps, `${STORAGE}/b/${encodeURIComponent(bucket)}/o?${query}`);
        for (const item of page?.items ?? []) {
          out.push({
            name: item.name,
            size: Number(item.size),
            ...(item.contentType ? { contentType: item.contentType } : {}),
          });
        }
        pageToken = page?.nextPageToken ?? '';
      } while (pageToken);
      return out;
    },
    async authUser(uid) {
      const res = await call<{
        users?: {
          passwordHash?: string;
          providerUserInfo?: { providerId: string }[];
          mfaInfo?: unknown[];
          disabled?: boolean;
          emailVerified?: boolean;
        }[];
      }>(deps, `${IDENTITY}/projects/${project}/accounts:lookup`, { localId: [uid] });
      const user = res?.users?.[0];
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
        providers: [...new Set((user.providerUserInfo ?? []).map((p) => p.providerId))].sort(),
        hasPassword: Boolean(user.passwordHash),
        mfaEnrolled: (user.mfaInfo ?? []).length > 0,
        disabled: user.disabled === true,
        emailVerified: user.emailVerified === true,
      } satisfies AuthSummary;
    },
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
        `${STORAGE}/b/${encodeURIComponent(bucket)}/iam/testPermissions?${query}`,
      );
      return res?.permissions ?? [];
    },
  };
}
