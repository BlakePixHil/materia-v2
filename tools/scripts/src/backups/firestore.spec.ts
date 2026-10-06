import { walkCollectionIds, type WalkCollection } from './firestore.ts';

/** The drill's collection walk (SEC-03): finds every id while probing a bounded sample. */

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
