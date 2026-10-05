/**
 * `materia-scripts search-load [--matters 500] [--runs 40] [--role lawyer|paralegal] [--budget 300]`
 * (CORE-15): the ⌘K search's latency against the Firestore emulator, with the security rules on.
 * It writes a fictional org (`org-search-load`: 500 matters by default, contacts, tasks and
 * documents) with the rules disabled, then signs in as a member and times the palette's four
 * provider reads, run together as the palette runs them, for a mix of typed queries. Prints
 * p50/p95/max and fails when p95 is over the budget.
 *
 * Run it inside the emulators (it refuses anything else):
 *   firebase emulators:exec --only firestore --project demo-materia --config firebase.json \
 *     "node tools/scripts/bin/materia-scripts.mjs search-load"
 *
 * The queries mirror libs/data-access/src/lib/search.ts (which needs Angular, so isn't imported).
 * The emulator answers them without the composite indexes (firebase/firestore.indexes.json) by
 * scanning the collection, so its latency grows with the collection (about 0.25 ms a matter on a
 * CI-sized machine, rules or not, whatever the query's shape) and serves concurrent reads one after
 * another; production Firestore reads the indexes, whose latency follows the rows returned. The
 * per-read lines show where the time goes. Every name is invented.
 */
import { parseArgs } from 'node:util';

import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  collection,
  collectionGroup,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  writeBatch,
  type Firestore,
  type Query,
  type QueryConstraint,
} from 'firebase/firestore';

import * as D from '@materia/domain';
import * as TestUtilsNs from '@materia/test-utils';

import { stripUndefined } from './seed/dataset.ts';
import { unwrap } from './seed/interop.ts';

const domain = unwrap(D);
const F = unwrap(TestUtilsNs);

const PROJECT_ID = 'demo-materia';
const ORG = 'org-search-load';
const UID = 'load-lawyer';
const OTHER = 'load-paralegal';
const BATCH = 400;

/** What a person types: numbers in each form, names, words and two-word queries. */
export const LOAD_QUERIES = [
  '142',
  '0142',
  '2026-0142',
  'quill',
  'fernsby',
  'estate',
  'estate ashcombe',
  'thistlewood',
  'edith marrow',
  'will',
  'pennyfeather',
  'lockhart trust',
  'bramble',
  'administration',
  'oakhurst',
  'harrowgate imogen',
] as const;

export interface LoadOptions {
  matters: number;
  runs: number;
  role: 'lawyer' | 'paralegal';
  budget: number;
}

export function parseLoadArgs(argv: string[]): LoadOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      matters: { type: 'string', default: '500' },
      runs: { type: 'string', default: '40' },
      role: { type: 'string', default: 'lawyer' },
      budget: { type: 'string', default: '300' },
    },
    strict: true,
  });
  const role = values.role;
  if (role !== 'lawyer' && role !== 'paralegal') throw new Error('--role is lawyer or paralegal');
  const number = (name: string, value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive whole number`);
    return n;
  };
  return {
    matters: number('matters', values.matters),
    runs: number('runs', values.runs),
    role,
    budget: number('budget', values.budget),
  };
}

/** The nearest-rank percentile of `values` (0–100). */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] as number;
}

const meta = (at: Date, uid = UID) => ({ createdAt: at, createdBy: uid, updatedAt: at, updatedBy: uid });

/** The fictional org's documents: members, contacts, the load matters, some tasks and documents. */
export function loadDocs(count: number, now = new Date()): { path: string; data: Record<string, unknown> }[] {
  const docs: { path: string; data: Record<string, unknown> }[] = [];
  const add = (path: string, data: Record<string, unknown>) => docs.push({ path, data: stripUndefined(data) });
  for (const [uid, role] of [
    [UID, 'lawyer'],
    [OTHER, 'paralegal'],
  ] as const) {
    add(
      `orgs/${ORG}/members/${uid}`,
      F.makeMember({ ...meta(now), role, status: 'active', displayName: `Load ${role}` }),
    );
  }
  const people = ['Ada Quill', 'Bertram Fernsby', 'Clementine Ashcombe', 'Desmond Thistlewood', 'Edith Marrow'];
  const contactIds = people.map((_, i) => `c-load-${i + 1}`);
  people.forEach((name, i) => {
    const [givenNames, familyName] = name.split(' ') as [string, string];
    const contact = F.makeContact({ ...meta(now), kind: 'person', givenNames, familyName });
    add(`orgs/${ORG}/contacts/${contactIds[i]}`, { ...contact, search: domain.contactSearchTokens(contact) });
  });
  const load = F.buildLoadMatters({
    orgId: ORG,
    count,
    now,
    year: 2026,
    uids: [UID, OTHER],
    clientContactIds: contactIds,
    contactNames: Object.fromEntries(contactIds.map((id, i) => [id, people[i] as string])),
  });
  for (const matter of load.matters) add(matter.path, matter.data);
  // A task and a document on every 25th matter (the providers' other two reads).
  load.matters.forEach((matter, i) => {
    if (i % 25) return;
    const matterId = matter.path.split('/').at(-1) as string;
    const title = `Lodge the inventory for ${String(matter.data['title'])}`;
    add(`${matter.path}/tasks/t-load-${i}`, {
      orgId: ORG,
      matterId,
      title,
      status: 'todo',
      priority: 'none',
      assigneeUid: i % 50 ? UID : OTHER,
      checklist: [],
      order: 1,
      source: 'manual',
      search: domain.taskSearchTokens(title),
      schemaVersion: 1,
      ...meta(now),
    });
    const name = `Will of ${String(matter.data['title']).replace(/^Estate of /, '')}.pdf`;
    add(`${matter.path}/documents/d-load-${i}`, {
      orgId: ORG,
      matterId,
      name,
      category: 'will',
      privileged: false,
      tags: [],
      version: 1,
      versions: [],
      scan: { status: 'clean' },
      ingest: { status: 'done' },
      source: 'upload',
      search: domain.documentSearchTokens(name),
      schemaVersion: 1,
      ...meta(now),
    });
  });
  return docs;
}

async function seed(env: RulesTestEnvironment, count: number): Promise<number> {
  const docs = loadDocs(count);
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore() as unknown as Firestore;
    for (let i = 0; i < docs.length; i += BATCH) {
      const batch = writeBatch(db);
      for (const { path, data } of docs.slice(i, i + BATCH)) batch.set(doc(db, path), data);
      await batch.commit();
    }
  });
  return docs.length;
}

/** The palette's reads for one typed query (libs/data-access/src/lib/search.ts), by provider. */
function paletteReads(db: Firestore, typed: string, uid: string, privileged: boolean): [string, Query][] {
  const token = domain.parseSearchQuery(typed).token;
  if (!token) return [];
  const page = (...constraints: QueryConstraint[]) => [...constraints, limit(domain.SEARCH_RESULT_LIMIT)];
  const reads: [string, Query][] = [
    [
      'matters',
      query(
        collection(db, `orgs/${ORG}/matters`),
        ...page(
          where('deletedAt', '==', null),
          ...(privileged ? [] : [where('privileged', '==', false)]),
          where('search', 'array-contains', token),
          orderBy('lastActivityAt', 'desc'),
        ),
      ),
    ],
    [
      'contacts',
      query(
        collection(db, `orgs/${ORG}/contacts`),
        ...page(where('search', 'array-contains', token), orderBy('updatedAt', 'desc')),
      ),
    ],
    [
      'my tasks',
      query(
        collectionGroup(db, 'tasks'),
        ...page(
          where('orgId', '==', ORG),
          where('assigneeUid', '==', uid),
          where('search', 'array-contains', token),
          orderBy('updatedAt', 'desc'),
        ),
      ),
    ],
  ];
  if (privileged) {
    reads.push(
      [
        'matter tasks',
        query(
          collectionGroup(db, 'tasks'),
          ...page(where('orgId', '==', ORG), where('search', 'array-contains', token), where('matterId', '!=', null)),
        ),
      ],
      [
        'documents',
        query(
          collectionGroup(db, 'documents'),
          ...page(where('orgId', '==', ORG), where('search', 'array-contains', token), orderBy('updatedAt', 'desc')),
        ),
      ],
    );
  }
  return reads;
}

/** Runs one search's reads together, as the palette does; records each read's time too. */
async function paletteSearch(
  db: Firestore,
  typed: string,
  uid: string,
  privileged: boolean,
  byRead: Map<string, number[]> = new Map(),
): Promise<number> {
  const sizes = await Promise.all(
    paletteReads(db, typed, uid, privileged).map(async ([name, read]) => {
      const t0 = performance.now();
      const snap = await getDocs(read);
      byRead.set(name, [...(byRead.get(name) ?? []), performance.now() - t0]);
      return snap.size;
    }),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

export async function main(argv: string[] = []): Promise<void> {
  const options = parseLoadArgs(argv);
  if (!process.env['FIRESTORE_EMULATOR_HOST']) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set: run search-load inside firebase emulators:exec.');
  }
  const env = await initializeTestEnvironment({ projectId: PROJECT_ID });
  try {
    await env.withSecurityRulesDisabled(async (context) => {
      // Start clean: a previous run's org (the emulator may outlive one run).
      const db = context.firestore() as unknown as Firestore;
      const old = (
        await Promise.all([
          getDocs(collection(db, `orgs/${ORG}/matters`)),
          getDocs(query(collectionGroup(db, 'tasks'), where('orgId', '==', ORG))),
          getDocs(query(collectionGroup(db, 'documents'), where('orgId', '==', ORG))),
        ])
      ).flatMap((snap) => snap.docs);
      for (let i = 0; i < old.length; i += BATCH) {
        const batch = writeBatch(db);
        for (const snap of old.slice(i, i + BATCH)) batch.delete(snap.ref);
        await batch.commit();
      }
    });
    const started = Date.now();
    const written = await seed(env, options.matters);
    console.log(`Seeded ${written} documents (${options.matters} matters) in ${Date.now() - started} ms.`);

    const uid = options.role === 'lawyer' ? UID : OTHER;
    const db = env.authenticatedContext(uid, { orgId: ORG, role: options.role }).firestore() as unknown as Firestore;
    const privileged = options.role === 'lawyer';
    // Warm up (the emulator compiles the rules on the first request).
    for (const typed of LOAD_QUERIES.slice(0, 3)) await paletteSearch(db, typed, uid, privileged);

    const timings: number[] = [];
    const byRead = new Map<string, number[]>();
    let rows = 0;
    for (let run = 0; run < options.runs; run++) {
      for (const typed of LOAD_QUERIES) {
        const t0 = performance.now();
        rows += await paletteSearch(db, typed, uid, privileged, byRead);
        timings.push(performance.now() - t0);
      }
    }
    for (const [name, times] of byRead) {
      console.log(
        `  ${name.padEnd(13)} p50 ${percentile(times, 50).toFixed(0)} ms, p95 ${percentile(times, 95).toFixed(0)} ms`,
      );
    }
    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);
    const max = percentile(timings, 100);
    console.log(
      `⌘K search as ${options.role}: ${timings.length} searches (${rows} rows), ` +
        `p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${max.toFixed(0)} ms (budget p95 < ${options.budget} ms).`,
    );
    if (p95 >= options.budget) throw new Error(`p95 ${p95.toFixed(0)} ms is over the ${options.budget} ms budget.`);
  } finally {
    await env.cleanup();
  }
}
