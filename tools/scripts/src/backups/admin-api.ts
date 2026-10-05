/**
 * The Firestore admin and Cloud Storage REST calls the restore tooling needs (SEC-03): restore a
 * managed backup, clone a point in time, import an export, delete a scratch database, list
 * backups and exports, and list collection ids as of a read time (the Admin SDK can't). Plain
 * fetch with an OAuth token, so tests run against a fake.
 */

const FIRESTORE = 'https://firestore.googleapis.com/v1';
const STORAGE = 'https://storage.googleapis.com/storage/v1';

export interface ApiDeps {
  fetch: typeof fetch;
  token: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface Operation {
  name: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  response?: Record<string, unknown>;
}

export interface Backup {
  /** `projects/{p}/locations/{l}/backups/{id}`. */
  name: string;
  /** `projects/{p}/databases/{id}`. */
  database: string;
  snapshotTime: string;
  state: string;
}

export interface ExportFolder {
  /** `gs://bucket/daily/2026-10-05T14-59-00Z`. */
  uri: string;
  kind: 'daily' | 'monthly';
  snapshotTime: string;
}

/** `daily/2026-10-05T14-59-00Z` → `2026-10-05T14:59:00Z`; null for anything else. */
export function snapshotTimeOfFolder(folder: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(folder);
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}Z` : null;
}

export class AdminApi {
  constructor(
    private readonly deps: ApiDeps,
    readonly project: string,
  ) {}

  private async call<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.deps.fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${await this.deps.token()}`, 'content-type': 'application/json' },
    });
    if (!res.ok)
      throw new Error(
        `${init.method ?? 'GET'} ${url.split('?')[0]}: ${res.status} ${(await res.text()).slice(0, 300)}`,
      );
    return (await res.json()) as T;
  }

  private databaseName(databaseId: string) {
    return `projects/${this.project}/databases/${databaseId}`;
  }

  /** Waits for a long-running operation (polling every `pollMs`) and throws if it failed. */
  async wait(op: Operation, { pollMs = 10_000, timeoutMs = 60 * 60 * 1000 } = {}): Promise<Operation> {
    const started = this.deps.now();
    let current = op;
    while (!current.done) {
      if (this.deps.now() - started > timeoutMs)
        throw new Error(`${op.name} still running after ${timeoutMs / 60_000} minutes`);
      await this.deps.sleep(pollMs);
      current = await this.call<Operation>(`${FIRESTORE}/${op.name}`);
    }
    if (current.error)
      throw new Error(`${op.name} failed: ${current.error.code ?? ''} ${current.error.message ?? ''}`.trim());
    return current;
  }

  /** The database's managed backups that are ready, newest snapshot first. */
  async listBackups(location: string, databaseId = '(default)'): Promise<Backup[]> {
    const res = await this.call<{ backups?: Backup[] }>(
      `${FIRESTORE}/projects/${this.project}/locations/${location}/backups`,
    );
    return (res.backups ?? [])
      .filter((b) => b.database.endsWith(`/databases/${databaseId}`) && b.state === 'READY')
      .sort((a, b) => b.snapshotTime.localeCompare(a.snapshotTime));
  }

  /** Restores a managed backup into a new database. */
  restore(databaseId: string, backup: string): Promise<Operation> {
    return this.call(`${FIRESTORE}/projects/${this.project}/databases:restore`, {
      method: 'POST',
      body: JSON.stringify({ databaseId, backup }),
    });
  }

  /** Clones (default) as of a PITR snapshot time into a new database. */
  clone(databaseId: string, snapshotTime: string, sourceDatabaseId = '(default)'): Promise<Operation> {
    return this.call(`${FIRESTORE}/projects/${this.project}/databases:clone`, {
      method: 'POST',
      body: JSON.stringify({
        databaseId,
        pitrSnapshot: { database: this.databaseName(sourceDatabaseId), snapshotTime },
      }),
    });
  }

  /** Creates an empty Native-mode database. */
  createDatabase(databaseId: string, locationId: string): Promise<Operation> {
    return this.call(`${FIRESTORE}/projects/${this.project}/databases?databaseId=${encodeURIComponent(databaseId)}`, {
      method: 'POST',
      body: JSON.stringify({ locationId, type: 'FIRESTORE_NATIVE' }),
    });
  }

  /** Imports an export into a database. */
  importDocuments(databaseId: string, inputUriPrefix: string): Promise<Operation> {
    return this.call(`${FIRESTORE}/${this.databaseName(databaseId)}:importDocuments`, {
      method: 'POST',
      body: JSON.stringify({ inputUriPrefix }),
    });
  }

  deleteDatabase(databaseId: string): Promise<Operation> {
    return this.call(`${FIRESTORE}/${this.databaseName(databaseId)}`, { method: 'DELETE' });
  }

  /** Every export folder in the bucket that finished (has its overall metadata file), newest first. */
  async listExports(bucket: string): Promise<ExportFolder[]> {
    const folders: ExportFolder[] = [];
    for (const kind of ['daily', 'monthly'] as const) {
      let pageToken: string | undefined;
      do {
        const query = new URLSearchParams({ prefix: `${kind}/`, matchGlob: `${kind}/*/*.overall_export_metadata` });
        if (pageToken) query.set('pageToken', pageToken);
        const res = await this.call<{ items?: { name: string }[]; nextPageToken?: string }>(
          `${STORAGE}/b/${bucket}/o?${query}`,
        );
        for (const item of res.items ?? []) {
          const folder = item.name.split('/')[1] ?? '';
          const snapshotTime = snapshotTimeOfFolder(folder);
          if (snapshotTime) folders.push({ uri: `gs://${bucket}/${kind}/${folder}`, kind, snapshotTime });
        }
        pageToken = res.nextPageToken;
      } while (pageToken);
    }
    return folders.sort((a, b) => b.snapshotTime.localeCompare(a.snapshotTime));
  }

  /** The collection ids under a document (or the root, for `''`), as of `readTime` when given. */
  async listCollectionIds(databaseId: string, docPath: string, readTime?: string): Promise<string[]> {
    const parent = `${this.databaseName(databaseId)}/documents${docPath ? `/${docPath}` : ''}`;
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.call<{ collectionIds?: string[]; nextPageToken?: string }>(
        `${FIRESTORE}/${parent}:listCollectionIds`,
        {
          method: 'POST',
          body: JSON.stringify({
            pageSize: 300,
            ...(pageToken ? { pageToken } : {}),
            ...(readTime ? { readTime } : {}),
          }),
        },
      );
      ids.push(...(res.collectionIds ?? []));
      pageToken = res.nextPageToken;
    } while (pageToken);
    return ids;
  }
}
