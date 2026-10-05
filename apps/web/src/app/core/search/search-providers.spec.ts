import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { OrgContext } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import {
  contactSearchTokens,
  documentSearchTokens,
  matterSearchTokens,
  taskSearchTokens,
  type Role,
} from '@materia/domain';

import { openMatterId, SEARCH_SHOWN, SearchResults } from './search-providers';
import { resultPage, type CommandResult } from '../commands/command-registry';

/** ⌘K's search providers (CORE-15). Every matter, person, task and document is fictional. */

const ME = 'u-jordan';
const ORG = 'orgs/org-a';
const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const meta = (day = 1) => ({ createdAt: at(day), createdBy: ME, updatedAt: at(day), updatedBy: ME, schemaVersion: 1 });

function matter(number: string, title: string, day: number, extra: Record<string, unknown> = {}) {
  return {
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
  };
}

function seed(fs: InMemoryFirestore): void {
  fs.set(`${ORG}/matters/m-142`, matter('M-2026-0142', 'Estate of Margaret Doyle', 5));
  fs.set(`${ORG}/matters/m-143`, matter('M-2026-0143', 'Doyle v Brennan', 6, { privileged: true }));
  fs.set(`${ORG}/contacts/c-1`, {
    kind: 'person',
    givenNames: 'Catherine',
    familyName: 'Doyle',
    emails: [],
    phones: [],
    addresses: [],
    tags: [],
    isReferrer: false,
    search: contactSearchTokens({ givenNames: 'Catherine', familyName: 'Doyle' }),
    ...meta(3),
  });
  const task = (title: string, matterId: string | null, assigneeUid: string) => ({
    orgId: 'org-a',
    matterId,
    title,
    status: 'todo',
    priority: 'none',
    assigneeUid,
    checklist: [],
    order: 1,
    source: 'manual',
    search: taskSearchTokens(title),
    ...meta(4),
  });
  fs.set(`${ORG}/matters/m-142/tasks/t-1`, task('Write to Doyle family', 'm-142', ME));
  fs.set(`${ORG}/matters/m-143/tasks/t-2`, task('Doyle evidence brief', 'm-143', 'u-other'));
  fs.set(`${ORG}/members/${ME}/tasks/p-1`, task('Call Doyle back', null, ME));
  const document = (name: string, matterId: string, privileged = false) => ({
    orgId: 'org-a',
    matterId,
    name,
    category: 'other',
    privileged,
    tags: [],
    version: 1,
    versions: [],
    scan: { status: 'clean' },
    ingest: { status: 'done' },
    source: 'upload',
    search: documentSearchTokens(name),
    ...meta(2),
  });
  fs.set(`${ORG}/matters/m-142/documents/d-1`, document('Will of Margaret Doyle.pdf', 'm-142'));
  fs.set(`${ORG}/matters/m-142/documents/d-2`, document('Doyle advice memo.pdf', 'm-142', true));
}

function setup(role: Role) {
  const fs = new InMemoryFirestore();
  seed(fs);
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideInMemoryFirestore(fs)] });
  TestBed.inject(OrgContext).setSession({ uid: ME, orgId: 'org-a', role });
  const results = TestBed.runInInjectionContext(() => new SearchResults());
  const ask = async (group: string, query: string) => {
    const provider = results.providers.find((p) => p.group === group);
    if (!provider) throw new Error(`No ${group} provider`);
    return resultPage(await provider.search(query, new AbortController().signal));
  };
  const titles = (page: { results: readonly CommandResult[] }) => page.results.map((r) => r.title);
  return { fs, results, ask, titles, router: TestBed.inject(Router) };
}

describe('SearchResults', () => {
  it('finds matters by number in any form, with their actions and their page', async () => {
    const { ask } = setup('lawyer');
    for (const typed of ['142', '2026-0142', 'M-2026-0142']) {
      const page = await ask('Matters', typed);
      expect(page.results[0]?.title, typed).toBe('Estate of Margaret Doyle');
    }
    const [result] = (await ask('Matters', '142')).results;
    expect(result).toMatchObject({ meta: 'M-2026-0142', mono: true, href: '/matters/m-142/overview' });
    expect(result?.children?.().map((c) => c.title)).toEqual(
      expect.arrayContaining(['Add task', 'Add deadline', 'Upload document', 'Close matter…']),
    );
  });

  it('keeps privileged matters, other people’s tasks and documents from a role without privileged.view', async () => {
    const lawyer = setup('lawyer');
    expect(lawyer.titles(await lawyer.ask('Matters', 'doyle'))).toEqual([
      'Doyle v Brennan',
      'Estate of Margaret Doyle',
    ]);
    expect(lawyer.titles(await lawyer.ask('Tasks', 'doyle')).sort()).toEqual(
      ['Call Doyle back', 'Doyle evidence brief', 'Write to Doyle family'].sort(),
    );
    expect(lawyer.titles(await lawyer.ask('Documents', 'doyle')).sort()).toEqual([
      'Doyle advice memo.pdf',
      'Will of Margaret Doyle.pdf',
    ]);
    TestBed.resetTestingModule();

    const paralegal = setup('paralegal');
    expect(paralegal.titles(await paralegal.ask('Matters', 'doyle'))).toEqual(['Estate of Margaret Doyle']);
    expect(paralegal.titles(await paralegal.ask('Tasks', 'doyle')).sort()).toEqual(
      ['Call Doyle back', 'Write to Doyle family'].sort(),
    );
    // Documents only while a matter is open, and its non-privileged ones only.
    expect(paralegal.titles(await paralegal.ask('Documents', 'doyle'))).toEqual([]);
    vi.spyOn(paralegal.router, 'url', 'get').mockReturnValue('/matters/m-142/documents');
    expect(paralegal.titles(await paralegal.ask('Documents', 'doyle'))).toEqual(['Will of Margaret Doyle.pdf']);
  });

  it('labels tasks and documents with their matter, and links each to its page', async () => {
    const { ask } = setup('lawyer');
    const tasks = (await ask('Tasks', 'write doyle')).results;
    expect(tasks[0]).toMatchObject({ meta: 'M-2026-0142', href: '/matters/m-142/tasks?task=t-1' });
    const personal = (await ask('Tasks', 'call')).results;
    expect(personal[0]).toMatchObject({ meta: 'Personal', href: '/tasks?task=p-1' });
    const docs = (await ask('Documents', 'will doyle')).results;
    expect(docs[0]).toMatchObject({ meta: 'M-2026-0142', href: '/matters/m-142/documents/d-1' });
    const people = (await ask('People', 'cath')).results;
    expect(people[0]).toMatchObject({ title: 'Catherine Doyle', href: '/contacts?contact=c-1' });
  });

  it('shows a few per group and says when there are more', async () => {
    const { fs, ask } = setup('lawyer');
    for (let i = 0; i < SEARCH_SHOWN + 2; i++) {
      fs.set(`${ORG}/matters/m-x${i}`, matter(`X-2026-00${10 + i}`, `Estate of Example ${i}`, 10 + i));
    }
    const page = await ask('Matters', 'example');
    expect(page.results).toHaveLength(SEARCH_SHOWN);
    expect(page.more).toBe(true);
    expect((await ask('Matters', 'margaret')).more).toBe(false);
  });

  it('records what is opened, and lists it as recent', async () => {
    const { ask, results, router } = setup('lawyer');
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    await (await ask('People', 'catherine')).results[0]?.run();
    await (await ask('Matters', '142')).results[0]?.run();
    expect(navigate).toHaveBeenCalledWith('/matters/m-142/overview');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const recent = await results.recent();
    expect(recent.map((r) => r.title).sort()).toEqual(['Catherine Doyle', 'Estate of Margaret Doyle']);
  });

  it('answers nothing for one character', async () => {
    const { ask } = setup('lawyer');
    expect((await ask('Matters', 'd')).results).toEqual([]);
  });
});

describe('openMatterId', () => {
  it.each([
    ['/matters/m-142/overview', 'm-142'],
    ['/matters/m-142', 'm-142'],
    ['/matters/new', null],
    ['/matters?view=mine', null],
    ['/contacts', null],
  ])('%s', (url, id) => {
    expect(openMatterId(url)).toBe(id);
  });
});
