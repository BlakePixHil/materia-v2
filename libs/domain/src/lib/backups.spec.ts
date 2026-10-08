import { exportedCollectionIds, FIRESTORE_COLLECTION_IDS, walkCollectionIds, type WalkCollection } from './backups';

/** The collection walk (SEC-03) the drill and the nightly export share, and what the export takes (SEC-07h). */

interface Tree {
  [collection: string]: { [doc: string]: Tree };
}

function walkable(tree: Tree, parent = '', probes: string[] = []): WalkCollection[] {
  return Object.entries(tree).map(([id, docs]) => {
    const path = parent ? `${parent}/${id}` : id;
    return {
      id,
      path,
      async sample(limit) {
        return Object.entries(docs)
          .slice(0, limit)
          .map(([docId, children]) => ({
            listCollections: async () => {
              probes.push(`${path}/${docId}`);
              return walkable(children, `${path}/${docId}`, probes);
            },
          }));
      },
    };
  });
}

const many = (n: number, child: (i: number) => Tree = () => ({})) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`d${i}`, child(i)]));

describe('walkCollectionIds', () => {
  it('finds nested collection ids', async () => {
    const tree: Tree = {
      orgs: {
        o1: { matters: { m1: { tasks: { t1: {} }, documents: { doc1: { chunks: { c1: {} } } } } }, audit: { a1: {} } },
      },
      eventGuards: { g1: {} },
    };
    expect(await walkCollectionIds(walkable(tree))).toEqual([
      'audit',
      'chunks',
      'documents',
      'eventGuards',
      'matters',
      'orgs',
      'tasks',
    ]);
  });

  it('shares one probe budget across collections of the same shape', async () => {
    const probes: string[] = [];
    const tree = {
      orgs: { o1: { matters: many(30, () => ({ tasks: many(30) })) } },
    };
    const ids = await walkCollectionIds(walkable(tree, '', probes), { perShape: 12, perCollection: 5, concurrency: 4 });
    expect(ids).toEqual(['matters', 'orgs', 'tasks']);
    const taskProbes = probes.filter((p) => p.split('/').length === 6);
    const matterProbes = probes.filter((p) => p.split('/').length === 4);
    expect(matterProbes).toHaveLength(5);
    expect(taskProbes).toHaveLength(12);
  });

  it('rejects when a probe fails', async () => {
    const failing: WalkCollection = {
      id: 'orgs',
      path: 'orgs',
      sample: async () => Promise.reject(new Error('denied')),
    };
    await expect(walkCollectionIds([failing])).rejects.toThrow('denied');
  });
});

describe('exportedCollectionIds (SEC-07h)', () => {
  it('leaves out Clerk’s chunks, which a restore rebuilds, and keeps everything else once', () => {
    const ids = exportedCollectionIds(['orgs', 'matters', 'documents', 'chunks', 'versions', 'matters']);
    expect(ids).not.toContain('chunks');
    expect(ids).toEqual([...new Set(ids)].sort());
    expect(ids).toEqual(expect.arrayContaining(['documents', 'matters', 'orgs', 'versions']));
  });

  it('takes every known collection even when the walk misses it, and any the walk finds that isn’t known', () => {
    const ids = exportedCollectionIds(['orgs', 'somethingNew']);
    expect(ids).toEqual(expect.arrayContaining(['somethingNew', 'invoices', 'tasks', 'eventGuards']));
    expect(ids).toHaveLength(FIRESTORE_COLLECTION_IDS.length); // somethingNew in, chunks out
  });
});
