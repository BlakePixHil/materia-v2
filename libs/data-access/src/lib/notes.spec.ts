import { TestBed } from '@angular/core/testing';

import { DomainError } from '@materia/domain';

import { CallableClient } from './callable-client';
import {
  compareNotes,
  matterNoteRepository,
  matterNotesQuery,
  noteCallables,
  noteConflictOf,
  noteRevisionRepository,
  noteRevisionsQuery,
  pinnedNotesQuery,
} from './notes';
import { OrgContext } from './org-context';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';

/** Matter notes: reads, pinning, delete and restore, revisions and the notes callables (CORE-13). Fictional data only. */

const meta = {
  createdAt: new Date('2026-10-01T00:00:00Z'),
  createdBy: 'u-jordan',
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  updatedBy: 'u-jordan',
  schemaVersion: 1,
};
const N = 'orgs/org-a/matters/m-1/notes';

function note(bodyMd: string, extra: Record<string, unknown> = {}) {
  return {
    bodyMd,
    mentions: { uids: [], matterIds: [] },
    pinned: false,
    privileged: false,
    source: 'manual',
    deletedAt: null,
    ...meta,
    ...extra,
  };
}

function setup(role: 'lawyer' | 'paralegal' = 'lawyer') {
  const fs = new InMemoryFirestore();
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  TestBed.inject(OrgContext).setSession({ uid: 'u-jordan', orgId: 'org-a', role });
  const run = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);
  return { fs, run };
}

describe('matterNoteRepository', () => {
  it('lists notes newest first, hides removed ones and tolerates server-only fields', async () => {
    const { fs, run } = setup();
    fs.set(`${N}/n-1`, note('Older', { _requestId: 'req-1' }));
    fs.set(`${N}/n-2`, note('Newer', { createdAt: new Date('2026-10-03T00:00:00Z'), editedAt: new Date() }));
    fs.set(`${N}/n-3`, note('Gone', { deletedAt: new Date('2026-10-02T00:00:00Z'), deletedBy: 'u-jordan' }));
    const notes = run(() => matterNoteRepository(() => 'm-1'));
    const rows = await notes.query(matterNotesQuery({ privilegedVisible: true }));
    expect(rows.map((r) => r.bodyMd)).toEqual(['Newer', 'Older']);
  });

  it('pins, soft deletes and restores, and refuses other edits and creates', async () => {
    const { fs, run } = setup();
    fs.set(`${N}/n-1`, note('Called Avery'));
    const notes = run(() => matterNoteRepository(() => 'm-1'));
    await notes.update('n-1', { pinned: true });
    expect(fs.get(`${N}/n-1`)).toMatchObject({ pinned: true, updatedBy: 'u-jordan' });
    await expect(notes.update('n-1', { bodyMd: 'Edited' } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await notes.softDelete('n-1');
    expect(fs.get(`${N}/n-1`)).toMatchObject({ deletedBy: 'u-jordan' });
    await notes.restore('n-1');
    expect(fs.get(`${N}/n-1`)).toMatchObject({ deletedAt: null, deletedBy: null, bodyMd: 'Called Avery' });
    await expect(notes.create({ bodyMd: 'x' })).rejects.toMatchObject({ code: 'FAILED_PRECONDITION' });
  });

  it('reads a note’s revisions newest first', async () => {
    const { fs, run } = setup();
    const revision = (id: string, bodyMd: string, day: number) =>
      fs.set(`${N}/n-1/revisions/${id}`, {
        bodyMd,
        privileged: false,
        editedAt: new Date(Date.UTC(2026, 9, day)),
        editedBy: 'u-priya',
        ...meta,
      });
    revision('r-1', 'First', 1);
    revision('r-2', 'Second', 2);
    fs.set(`${N}/n-1/revisions/r-3`, {
      bodyMd: 'Privileged draft',
      privileged: true,
      editedAt: new Date(Date.UTC(2026, 9, 3)),
      editedBy: 'u-priya',
      ...meta,
    });
    const revisions = run(() =>
      noteRevisionRepository(
        () => 'm-1',
        () => 'n-1',
      ),
    );
    const bodies = async (privilegedVisible: boolean) =>
      (await revisions.query(noteRevisionsQuery({ privilegedVisible }))).map((r) => r.bodyMd);
    expect(await bodies(true)).toEqual(['Privileged draft', 'Second', 'First']);
    expect(await bodies(false)).toEqual(['Second', 'First']);
    expect(noteRevisionsQuery({ privilegedVisible: false })).toEqual({
      where: [['privileged', '==', false]],
      orderBy: [['editedAt', 'desc']],
      pageSize: 50,
    });
    expect(noteRevisionsQuery({ privilegedVisible: true })).toEqual({ orderBy: [['editedAt', 'desc']], pageSize: 50 });
  });
});

describe('notes queries', () => {
  it('prove privileged == false for roles that can’t see privileged notes', () => {
    expect(matterNotesQuery({ privilegedVisible: false })).toEqual({
      where: [['privileged', '==', false]],
      orderBy: [['createdAt', 'desc']],
      pageSize: 100,
    });
    expect(matterNotesQuery({ privilegedVisible: true, pageSize: 20 })).toEqual({
      orderBy: [['createdAt', 'desc']],
      pageSize: 20,
    });
    expect(pinnedNotesQuery({ privilegedVisible: false })).toEqual({
      where: [
        ['pinned', '==', true],
        ['privileged', '==', false],
      ],
      pageSize: 20,
    });
    expect(pinnedNotesQuery({ privilegedVisible: true }).where).toEqual([['pinned', '==', true]]);
  });

  it('read only the notes a paralegal may see', async () => {
    const { fs, run } = setup('paralegal');
    fs.set(`${N}/n-1`, note('Open', { pinned: true }));
    fs.set(`${N}/n-2`, note('Privileged', { pinned: true, privileged: true }));
    const notes = run(() => matterNoteRepository(() => 'm-1'));
    expect((await notes.query(pinnedNotesQuery({ privilegedVisible: false }))).map((r) => r.bodyMd)).toEqual(['Open']);
  });

  it('sort pinned notes first, then newest', () => {
    const at = (day: number) => new Date(Date.UTC(2026, 9, day));
    const rows = [
      { id: 'a', pinned: false, createdAt: at(3) },
      { id: 'b', pinned: true, createdAt: at(1) },
      { id: 'c', pinned: false, createdAt: at(5) },
      { id: 'd', pinned: true, createdAt: at(2) },
    ];
    expect([...rows].sort(compareNotes).map((r) => r.id)).toEqual(['d', 'b', 'c', 'a']);
  });
});

describe('noteCallables', () => {
  it('calls notes-create and notes-update with request ids', async () => {
    const calls: { name: string; data: Record<string, unknown> }[] = [];
    const client = new CallableClient(
      {
        call: async <T>(name: string, data: unknown) => {
          calls.push({ name, data: data as Record<string, unknown> });
          return { noteId: 'n-1', updatedAt: '2026-10-05T00:00:00.000Z', notified: [], unreachable: [] } as T;
        },
        refreshClaims: async () => undefined,
      },
      { newId: () => '00000000-0000-4000-8000-000000000001' },
    );
    const api = noteCallables(client);
    await api.create({ matterId: 'm-1', bodyMd: 'Hi @[u-priya]' });
    await api.update(
      { matterId: 'm-1', noteId: 'n-1', bodyMd: 'Edited', expectedUpdatedAt: '2026-10-01T00:00:00.000Z' },
      { requestId: '00000000-0000-4000-8000-000000000009' },
    );
    expect(calls).toEqual([
      {
        name: 'notes-create',
        data: { matterId: 'm-1', bodyMd: 'Hi @[u-priya]', requestId: '00000000-0000-4000-8000-000000000001' },
      },
      {
        name: 'notes-update',
        data: {
          matterId: 'm-1',
          noteId: 'n-1',
          bodyMd: 'Edited',
          expectedUpdatedAt: '2026-10-01T00:00:00.000Z',
          requestId: '00000000-0000-4000-8000-000000000009',
        },
      },
    ]);
  });

  it('reads the conflict details of a refused update', () => {
    const conflict = new DomainError('FAILED_PRECONDITION', 'Changed', {
      code: 'FAILED_PRECONDITION',
      reason: 'note_conflict',
      updatedAt: '2026-10-05T01:00:00.000Z',
      updatedBy: 'u-priya',
    });
    expect(noteConflictOf(conflict)).toEqual({ updatedAt: '2026-10-05T01:00:00.000Z', updatedBy: 'u-priya' });
    expect(noteConflictOf(new DomainError('FAILED_PRECONDITION', 'Closed', { reason: 'matter_closed' }))).toBeNull();
    expect(noteConflictOf(new Error('boom'))).toBeNull();
  });
});
