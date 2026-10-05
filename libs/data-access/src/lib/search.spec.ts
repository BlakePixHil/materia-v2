import { TestBed } from '@angular/core/testing';

import {
  contactSearchTokens,
  documentSearchTokens,
  matterSearchTokens,
  parseSearchQuery,
  SEARCH_RESULT_LIMIT,
  taskSearchTokens,
} from '@materia/domain';

import { OrgContext } from './org-context';
import {
  contactHit,
  contactSearchQuery,
  contactSearchRepository,
  documentHit,
  documentSearchQuery,
  documentSearchRepository,
  liveContact,
  matterDocumentSearchRepository,
  matterHit,
  matterSearchQuery,
  matterSearchRepository,
  matterTaskSearchQuery,
  myTaskSearchQuery,
  rankRows,
  recentTargets,
  taskHit,
  taskSearchRepository,
} from './search';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';

/** ⌘K search reads (CORE-15). Every matter, person, task and document is fictional. */

const ME = 'u-jordan';
const ORG = 'orgs/org-a';
const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const meta = (day = 1) => ({ createdAt: at(day), createdBy: ME, updatedAt: at(day), updatedBy: ME, schemaVersion: 1 });

const matter = (number: string, title: string, day: number, extra: Record<string, unknown> = {}) => ({
  number,
  title,
  type: 'probate',
  status: 'open',
  privileged: false,
  search: matterSearchTokens({ number, title }),
  lastActivityAt: at(day),
  deletedAt: null,
  ...meta(day),
  ...extra,
});
const task = (title: string, matterId: string | null, day: number, extra: Record<string, unknown> = {}) => ({
  orgId: 'org-a',
  matterId,
  title,
  status: 'todo',
  priority: 'none',
  assigneeUid: ME,
  checklist: [],
  order: 1,
  source: 'manual',
  search: taskSearchTokens(title),
  ...meta(day),
  ...extra,
});
const document = (name: string, matterId: string, day: number, extra: Record<string, unknown> = {}) => ({
  orgId: 'org-a',
  matterId,
  name,
  category: 'other',
  privileged: false,
  tags: [],
  version: 1,
  versions: [],
  scan: { status: 'clean' },
  ingest: { status: 'done' },
  source: 'upload',
  search: documentSearchTokens(name),
  ...meta(day),
  ...extra,
});

function setup() {
  const fs = new InMemoryFirestore();
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  TestBed.inject(OrgContext).setSession({ uid: ME, orgId: 'org-a', role: 'lawyer' });
  const run = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);
  return { fs, run };
}

describe('matter search', () => {
  it('reads live matters by token, privileged ones only for privileged.view, and ranks the exact number first', async () => {
    const { fs, run } = setup();
    fs.set(`${ORG}/matters/m-142`, matter('M-2026-0142', 'Estate of Margaret Doyle', 2));
    fs.set(`${ORG}/matters/m-1420`, matter('M-2026-1420', 'Estate of Fictional 142 Trust', 9));
    fs.set(`${ORG}/matters/m-priv`, matter('M-2026-0143', 'Doyle v Brennan', 8, { privileged: true }));
    fs.set(`${ORG}/matters/m-gone`, matter('M-2026-0144', 'Estate of Old Doyle', 7, { deletedAt: at(7) }));
    const repo = run(() => matterSearchRepository());
    const doyle = parseSearchQuery('doyle');
    const read = async (privileged: boolean) =>
      (await repo.query(matterSearchQuery(doyle.token as string, privileged))).map((r) => r.id);
    expect(await read(true)).toEqual(['m-priv', 'm-142']);
    expect(await read(false)).toEqual(['m-142']);
    const query = parseSearchQuery('142');
    const rows = await repo.query(matterSearchQuery(query.token as string, true));
    expect(rankRows(rows, query, matterHit).rows.map((r) => r.id)).toEqual(['m-142', 'm-1420']);
  });

  it('flags a hot token when the provider read the whole limit', async () => {
    const { fs, run } = setup();
    for (let i = 0; i < SEARCH_RESULT_LIMIT + 5; i++) {
      fs.set(`${ORG}/matters/m-${i}`, matter(`M-2026-${String(i).padStart(4, '0')}`, `Estate of Example ${i}`, 1));
    }
    const query = parseSearchQuery('estate');
    const rows = await run(() => matterSearchRepository()).query(matterSearchQuery('estate', true));
    expect(rows).toHaveLength(SEARCH_RESULT_LIMIT);
    expect(rankRows(rows, query, matterHit).more).toBe(true);
    expect(rankRows(rows.slice(0, 3), query, matterHit).more).toBe(false);
  });
});

describe('contact search', () => {
  it('reads contacts by token, newest first, without merge tombstones', async () => {
    const { fs, run } = setup();
    const person = (givenNames: string, familyName: string, day: number, extra: Record<string, unknown> = {}) => ({
      kind: 'person',
      givenNames,
      familyName,
      emails: [],
      phones: [],
      addresses: [],
      tags: [],
      isReferrer: false,
      search: contactSearchTokens({ givenNames, familyName }),
      ...meta(day),
      ...extra,
    });
    fs.set(`${ORG}/contacts/c-zoe`, person('Zoë', 'Ångström', 3));
    fs.set(`${ORG}/contacts/c-old`, person('Zoe', 'Angstrom', 1, { mergedInto: 'c-zoe' }));
    const rows = await run(() => contactSearchRepository()).query(contactSearchQuery('angstrom'));
    const page = rankRows(rows.filter(liveContact), parseSearchQuery('ångström'), contactHit);
    expect(page.rows.map((r) => r.id)).toEqual(['c-zoe']);
  });
});

describe('task search', () => {
  it('reads my tasks (personal ones too), and every matter task but no one’s personal tasks', async () => {
    const { fs, run } = setup();
    fs.set(`${ORG}/matters/m-1/tasks/t-mine`, task('Lodge the inventory', 'm-1', 3));
    fs.set(
      `${ORG}/matters/m-1/tasks/t-theirs`,
      task('Lodge the probate application', 'm-1', 4, { assigneeUid: 'u-x' }),
    );
    fs.set(`${ORG}/members/${ME}/tasks/p-mine`, task('Lodge my leave form', null, 5));
    fs.set(`${ORG}/members/u-x/tasks/p-theirs`, task('Lodge their tax', null, 6, { assigneeUid: 'u-x' }));
    fs.set(`orgs/org-b/matters/m-9/tasks/t-other-org`, task('Lodge elsewhere', 'm-9', 9, { orgId: 'org-b' }));
    const repo = run(() => taskSearchRepository());
    expect((await repo.query(myTaskSearchQuery(ME, 'lodge'))).map((r) => r.id)).toEqual(['p-mine', 't-mine']);
    const every = await repo.query(matterTaskSearchQuery('lodge'));
    expect(every.map((r) => r.id).sort()).toEqual(['t-mine', 't-theirs']);
    expect(rankRows(every, parseSearchQuery('lodge probate'), taskHit).rows.map((r) => r.id)).toEqual(['t-theirs']);
  });
});

describe('document search', () => {
  it('reads the org’s documents through the group, or one matter’s non-privileged ones', async () => {
    const { fs, run } = setup();
    fs.set(`${ORG}/matters/m-1/documents/d-will`, document('Will of Ada Quill (fictional).pdf', 'm-1', 2));
    fs.set(`${ORG}/matters/m-1/documents/d-priv`, document('Will advice memo.pdf', 'm-1', 3, { privileged: true }));
    fs.set(`${ORG}/matters/m-2/documents/d-other`, document('Will draft v2.docx', 'm-2', 4));
    fs.set(`${ORG}/matters/m-2/documents/d-gone`, document('Will old.pdf', 'm-2', 5, { deletedAt: at(5) }));
    const group = run(() => documentSearchRepository());
    const all = await group.query(documentSearchQuery('will'));
    expect(all.map((r) => r.id)).toEqual(['d-other', 'd-priv', 'd-will']);
    expect(rankRows(all, parseSearchQuery('will quill'), documentHit).rows.map((r) => r.id)).toEqual(['d-will']);
    const one = run(() => matterDocumentSearchRepository(() => 'm-1'));
    expect((await one.query(documentSearchQuery('will', false))).map((r) => r.id)).toEqual(['d-will']);
  });
});

describe('recent targets', () => {
  it('reads what each entry names, leaving out what is gone or deleted', async () => {
    const { fs, run } = setup();
    fs.set(`${ORG}/matters/m-1`, matter('M-2026-0142', 'Estate of Margaret Doyle', 2));
    fs.set(`${ORG}/matters/m-gone`, matter('M-2026-0144', 'Estate of Old Doyle', 7, { deletedAt: at(7) }));
    fs.set(`${ORG}/contacts/c-1`, {
      kind: 'person',
      givenNames: 'Catherine',
      familyName: 'Doyle',
      emails: [],
      phones: [],
      addresses: [],
      tags: [],
      isReferrer: false,
      search: [],
      ...meta(),
    });
    fs.set(`${ORG}/matters/m-1/tasks/t-1`, task('Obtain death certificate', 'm-1', 3));
    fs.set(`${ORG}/members/${ME}/tasks/p-1`, task('Renew practising certificate', null, 3));
    fs.set(`${ORG}/matters/m-1/documents/d-1`, document('Grant of probate.pdf', 'm-1', 3));
    const read = run(() => recentTargets());
    const targets = await read([
      { kind: 'matter', matterId: 'm-1' },
      { kind: 'matter', matterId: 'm-gone' },
      { kind: 'matter', matterId: 'm-missing' },
      { kind: 'contact', entityId: 'c-1' },
      { kind: 'task', matterId: 'm-1', entityId: 't-1' },
      { kind: 'task', entityId: 'p-1' },
      { kind: 'document', matterId: 'm-1', entityId: 'd-1' },
    ]);
    expect(targets.map((t) => [t.ref.kind, t.title, t.number ?? null])).toEqual([
      ['matter', 'Estate of Margaret Doyle', 'M-2026-0142'],
      ['contact', 'Catherine Doyle', null],
      ['task', 'Obtain death certificate', 'M-2026-0142'],
      ['task', 'Renew practising certificate', null],
      ['document', 'Grant of probate.pdf', 'M-2026-0142'],
    ]);
  });
});
