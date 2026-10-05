import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { keyFactPatch } from '@materia/domain';

import { CallableClient } from './callable-client';
import {
  forMatter,
  MATTER_ACTIVITY_QUERY,
  MATTER_PARTIES_QUERY,
  matterActivityRepository,
  matterCallables,
  matterDeadlinesRepository,
  matterDetailRepository,
  matterPartiesRepository,
  matterTasksRepository,
  matterTemplatesRepository,
  matterTemplateLoader,
  matterTemplateStagesLoader,
  OPEN_DEADLINES_QUERY,
  OPEN_TASKS_QUERY,
  RECENT_ACTIVITY_QUERY,
} from './matter-detail';
import { OrgContext } from './org-context';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';

/** The matter screen's reads and callables (CORE-06). Fictional data only. */

const meta = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: 'u-jordan',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  updatedBy: 'u-priya',
  schemaVersion: 1,
};
const M = 'orgs/org-a/matters/m-1';

function setup() {
  const fs = new InMemoryFirestore();
  fs.set(M, {
    number: 'M-2026-0300',
    title: 'Estate of Fictional Quill',
    type: 'probate',
    status: 'open',
    clientContactIds: ['c-1'],
    jurisdiction: 'VIC',
    responsibleUid: 'u-jordan',
    teamUids: ['u-priya'],
    labels: ['grant'],
    privileged: true,
    priority: 'high',
    fee: { arrangement: 'hourly', history: [] },
    costsDisclosure: { status: 'required' },
    conflictCheck: { status: 'clear' },
    deceased: { contactId: 'c-2', dateOfDeath: '2026-08-01', domicile: 'VIC', lastAddress: '1 Fictional St' },
    estate: { grantType: 'probate', grossValueCents: 125_000_00 },
    wipCents: 1200,
    deletedAt: null,
    ...meta,
  });
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  TestBed.inject(OrgContext).setSession({ uid: 'u-jordan', orgId: 'org-a', role: 'lawyer' });
  return fs;
}

describe('matterDetailRepository', () => {
  it('reads the header, key facts and who changed it last, dropping the rest', async () => {
    setup();
    const matter = await TestBed.runInInjectionContext(() => matterDetailRepository()).get('m-1');
    expect(matter).toMatchObject({
      number: 'M-2026-0300',
      privileged: true,
      teamUids: ['u-priya'],
      estate: { grantType: 'probate', grossValueCents: 125_000_00 },
      updatedBy: 'u-priya',
    });
    expect(matter).not.toHaveProperty('wipCents');
  });

  it('writes a key fact without touching the other fields', async () => {
    const fs = setup();
    const repo = TestBed.runInInjectionContext(() => matterDetailRepository());
    const matter = await repo.get('m-1');
    if (!matter) throw new Error('no matter');
    await repo.update('m-1', keyFactPatch(matter, 'grantDate', '2026-09-30'));
    expect(fs.writes.at(-1)?.data).not.toHaveProperty('labels');
    expect(fs.get(M)).toMatchObject({
      estate: { grantType: 'probate', grossValueCents: 125_000_00, grantDate: '2026-09-30' },
      labels: ['grant'],
      privileged: true,
      priority: 'high',
    });
  });
});

describe('a matter’s records', () => {
  it('follow the matter id and wait without one', () => {
    const fs = setup();
    fs.set(`${M}/parties/client-c-1`, { contactId: 'c-1', role: 'client', orgId: 'org-a', matterId: 'm-1', ...meta });
    fs.set(`${M}/parties/beneficiary-c-3`, {
      contactId: 'c-3',
      role: 'beneficiary',
      share: 'One half',
      orgId: 'org-a',
      matterId: 'm-1',
      deletedAt: new Date(),
      ...meta,
    });
    const id = signal<string | null>(null);
    const parties = TestBed.runInInjectionContext(() =>
      matterPartiesRepository(id).watchQuery(forMatter(id, MATTER_PARTIES_QUERY)),
    );
    TestBed.tick();
    expect(fs.listenerCount).toBe(0);
    id.set('m-1');
    TestBed.tick();
    expect(fs.listenerCount).toBe(1);
    expect(parties.value().map((p) => p.id)).toEqual(['client-c-1']);
    id.set(null);
    TestBed.tick();
    expect(fs.listenerCount).toBe(0);
  });

  it('read open tasks, open deadlines and the latest activity', async () => {
    const fs = setup();
    const at = (day: number) => new Date(Date.UTC(2026, 9, day));
    const task = (id: string, status: string) =>
      fs.set(`${M}/tasks/${id}`, { title: id, status, priority: 'none', order: 1, checklist: [], ...meta });
    task('t-open', 'todo');
    task('t-done', 'done');
    const deadline = (id: string, status: string) =>
      fs.set(`${M}/deadlines/${id}`, {
        title: id,
        dueDate: '2026-10-10',
        critical: false,
        status,
        kind: 'statutory',
        assigneeUid: 'u-jordan',
        ...meta,
      });
    deadline('d-open', 'upcoming');
    deadline('d-done', 'done');
    // Missed is closed (CORE-10): a lawyer confirmed it.
    deadline('d-missed', 'missed');
    for (let day = 1; day <= 7; day++) {
      fs.set(`${M}/activity/a${day}`, { kind: 'note', summary: `Day ${day}`, actorUid: 'u-jordan', at: at(day) });
    }
    const id = () => 'm-1';
    const [tasks, deadlines, activity] = TestBed.runInInjectionContext(() => [
      matterTasksRepository(id).query(OPEN_TASKS_QUERY),
      matterDeadlinesRepository(id).query(OPEN_DEADLINES_QUERY),
      matterActivityRepository(id).query(RECENT_ACTIVITY_QUERY),
    ]);
    expect((await tasks).map((t) => t.id)).toEqual(['t-open']);
    expect((await deadlines).map((d) => d.id)).toEqual(['d-open']);
    // The Overview shows the three latest (CORE-13); `refs` default to none.
    expect((await activity).map((a) => a.summary)).toEqual(['Day 7', 'Day 6', 'Day 5']);
    expect((await activity)[0]?.refs).toEqual({});
  });

  it('pages the whole activity feed, newest first, with refs (CORE-13)', async () => {
    const fs = setup();
    for (let n = 1; n <= 30; n++) {
      fs.set(`${M}/activity/a${String(n).padStart(2, '0')}`, {
        kind: 'note.created',
        summary: `Added note ${n}`,
        actorUid: 'u-jordan',
        at: new Date(Date.UTC(2026, 9, 1, 0, n)),
        refs: { noteId: `n-${n}` },
      });
    }
    const feed = TestBed.runInInjectionContext(() =>
      matterActivityRepository(() => 'm-1').watchQuery(MATTER_ACTIVITY_QUERY),
    );
    await vi.waitFor(() => expect(feed.value()).toHaveLength(25));
    expect(feed.value()[0]).toMatchObject({ summary: 'Added note 30', refs: { noteId: 'n-30' } });
    expect(feed.hasMore()).toBe(true);
    await feed.loadMore();
    await vi.waitFor(() => expect(feed.value()).toHaveLength(30));
    expect(feed.value().at(-1)?.summary).toBe('Added note 1');
    expect(feed.hasMore()).toBe(false);
  });

  it('reads a template’s stages', async () => {
    const fs = setup();
    fs.set('orgs/org-a/templates/tpl-1', {
      name: 'Probate (fictional practice)',
      matterType: 'probate',
      version: 1,
      stages: [{ id: 'intake', title: 'Getting started' }],
      tasks: [],
      published: true,
      source: 'org',
      ...meta,
    });
    const found = await TestBed.runInInjectionContext(() => matterTemplatesRepository()).get('tpl-1');
    expect(found?.stages).toEqual([{ id: 'intake', title: 'Getting started' }]);
  });

  it('loads a matter’s template stages: system bundle, published version, else the draft (CORE-07)', async () => {
    const fs = setup();
    const draft = { name: 'Fictional wills', matterType: 'will', tasks: [], deadlineRuleIds: [], ...meta };
    fs.set('orgs/org-a/templates/tpl-2', {
      ...draft,
      version: 1,
      published: true,
      source: 'org',
      stages: [{ id: 'start', name: 'Draft start', order: 1 }],
    });
    fs.set('orgs/org-a/templates/tpl-2/versions/1', {
      ...draft,
      templateId: 'tpl-2',
      version: 1,
      published: true,
      source: 'org',
      stages: [
        { id: 'start', name: 'Start', order: 1 },
        { id: 'end', name: 'End', order: 2, entryRequires: { facts: ['willDate'] }, terminal: true },
      ],
    });
    const load = TestBed.runInInjectionContext(() => matterTemplateStagesLoader());
    expect((await load('system-will'))?.map((s) => s.id)).toEqual([
      'instructions',
      'draft',
      'client_review',
      'execution',
      'safe_custody',
      'closed',
    ]);
    expect(await load('tpl-2', 1)).toEqual([
      { id: 'start', name: 'Start' },
      { id: 'end', name: 'End', entryRequires: { facts: ['willDate'] }, terminal: true },
    ]);
    expect(await load('tpl-2', 7)).toEqual([{ id: 'start', name: 'Draft start' }]);
    expect(await load('tpl-2')).toEqual([{ id: 'start', name: 'Draft start' }]);
    expect(await load('tpl-missing')).toBeNull();
  });

  it('loads a matter’s template outline with its tasks’ names (CORE-07)', async () => {
    const fs = setup();
    fs.set('orgs/org-a/templates/tpl-3/versions/2', {
      name: 'Fictional probate',
      matterType: 'probate',
      templateId: 'tpl-3',
      version: 2,
      published: true,
      source: 'org',
      deadlineRuleIds: [],
      stages: [{ id: 'start', name: 'Start', order: 1 }],
      tasks: [{ key: 'call_client', title: 'Call the client', stageId: 'start', assignTo: null, priority: 'low' }],
      ...meta,
    });
    const load = TestBed.runInInjectionContext(() => matterTemplateLoader());
    expect(await load('tpl-3', 2)).toEqual({
      stages: [{ id: 'start', name: 'Start' }],
      tasks: [{ key: 'call_client', title: 'Call the client' }],
    });
    expect((await load('system-will'))?.tasks[0]).toEqual({
      key: 'take_instructions',
      title: 'Take will instructions',
    });
  });
});

describe('matterCallables', () => {
  it('calls each callable by name with a request id', async () => {
    const calls: { name: string; data: unknown }[] = [];
    let n = 0;
    const client = new CallableClient(
      {
        call: async <T>(name: string, data: unknown) => {
          calls.push({ name, data });
          return { ok: name } as T;
        },
        refreshClaims: async () => undefined,
      },
      { newId: () => `00000000-0000-4000-8000-00000000000${++n}` },
    );
    const api = matterCallables(client);
    await api.changeStage({ matterId: 'm-1', stageId: 'grant_issued' });
    await api.upsertParty({ matterId: 'm-1', contactId: 'c-3', role: 'beneficiary', share: 'One half' });
    await api.removeParty({ matterId: 'm-1', partyId: 'beneficiary-c-3' });
    await api.changeStatus({ matterId: 'm-1', to: 'closed', reason: 'Estate finalised' });
    await api.upgradeTemplate({ matterId: 'm-1', version: 2 });
    await api.renumber({ matterId: 'm-1', number: '3E-104233' });
    expect(calls.map((c) => c.name)).toEqual([
      'matters-changeStage',
      'matters-upsertParty',
      'matters-removeParty',
      'matters-changeStatus',
      'matters-upgradeTemplate',
      'matters-renumber',
    ]);
    expect(calls[0]?.data).toEqual({
      matterId: 'm-1',
      stageId: 'grant_issued',
      requestId: '00000000-0000-4000-8000-000000000001',
    });
  });
});
