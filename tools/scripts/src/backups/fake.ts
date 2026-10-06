import type { ApiDeps } from './admin-api.ts';
import type { RestoreTarget } from './restore-matter.ts';
import type { Data } from './subtree.ts';

/** An in-memory database for the restore tooling's tests. Everything in it is fictional. */
export class FakeDb implements RestoreTarget {
  readonly docs = new Map<string, Data>();
  readonly audits: { orgId: string; entry: Data }[] = [];
  writes: string[] = [];
  deletes: string[] = [];
  running: string[] = [];

  constructor(entries: Record<string, Data> = {}) {
    for (const [path, data] of Object.entries(entries)) this.docs.set(path, structuredClone(data));
  }

  async get(path: string) {
    const data = this.docs.get(path);
    return data ? structuredClone(data) : null;
  }

  /** Subcollections of a document: any stored path one collection deeper. */
  async collections(docPath: string) {
    const depth = docPath.split('/').length;
    const ids = new Set<string>();
    for (const path of this.docs.keys()) {
      const parts = path.split('/');
      if (path.startsWith(`${docPath}/`) && parts.length > depth + 1) ids.add(parts[depth] as string);
    }
    return [...ids].sort();
  }

  /** Documents of a collection, including missing parents of deeper documents. */
  async documents(collectionPath: string) {
    const depth = collectionPath.split('/').length;
    const paths = new Set<string>();
    for (const path of this.docs.keys()) {
      if (path.startsWith(`${collectionPath}/`))
        paths.add(
          path
            .split('/')
            .slice(0, depth + 1)
            .join('/'),
        );
    }
    return [...paths]
      .sort()
      .map((path) => ({ path, data: this.docs.has(path) ? structuredClone(this.docs.get(path) as Data) : null }));
  }

  async write(docs: { path: string; data: Data }[]) {
    for (const { path, data } of docs) {
      this.docs.set(path, structuredClone(data));
      this.writes.push(path);
    }
  }

  async delete(paths: readonly string[]) {
    for (const path of paths) {
      this.docs.delete(path);
      this.deletes.push(path);
    }
  }

  async runningMigrations() {
    return this.running;
  }

  async audit(orgId: string, entry: Data) {
    this.audits.push({ orgId, entry });
    return `audit-${this.audits.length}`;
  }
}

/** A fetch that answers from a script of responses and records each call. */
export function scripted(responses: (object | ((url: string, init?: RequestInit) => object))[]) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  /** Each call's request headers, in call order. */
  const headers: Record<string, string>[] = [];
  const clock = { t: 0 };
  const deps: ApiDeps = {
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      });
      headers.push({ ...(init?.headers as Record<string, string>) });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected call ${url}`);
      const body = typeof next === 'function' ? next(url, init) : next;
      const status = 'status' in body ? Number(body.status) : 200;
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch,
    token: async () => 'token',
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
  };
  return { deps, calls, headers, clock };
}
