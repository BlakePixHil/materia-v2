import { randomUUID } from 'node:crypto';

import { Timestamp } from 'firebase-admin/firestore';
import type { HttpsError } from 'firebase-functions/v2/https';

import { NOTE_BODY_MAX, type Role, type SaveNoteResult } from '@materia/domain';

import { createDefinition } from './create';
import { canOpenNote, millis, noteMentions } from './shared';
import { updateDefinition } from './update';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts, type FakeTaskQueue } from '../ports/fakes';

/** Unit tests for the notes callables (CORE-13). Every org, person, matter and note is fictional. */

const ORG = 'org-a';
const M = `orgs/${ORG}/matters`;
const NOTES = `${M}/m1/notes`;
// 11:00 on 5 October 2026 in Melbourne: outside quiet hours, so email goes out at once.
const NOW = new Date('2026-10-05T00:00:00.000Z');
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };
const member = (role: Role, displayName: string, status = 'active') => ({ ...meta, role, status, displayName });
const matter = (extra: Record<string, unknown> = {}) => ({
  ...meta,
  number: 'RM-2026-0001',
  title: 'Estate of Fictional Wren',
  type: 'probate',
  status: 'open',
  privileged: false,
  deletedAt: null,
  ...extra,
});

type Data = Record<string, unknown>;

function world(initial: Record<string, Data> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Bayside Legal', timezone: 'Australia/Melbourne' },
    [`orgs/${ORG}/members/user-owner`]: member('owner', 'Priya Fictional'),
    [`orgs/${ORG}/members/user-lawyer`]: member('lawyer', 'Jordan Fictional'),
    [`orgs/${ORG}/members/user-paralegal`]: member('paralegal', 'Dana Fictional'),
    [`orgs/${ORG}/members/user-readonly`]: member('readonly', 'Sam Fictional'),
    [`orgs/${ORG}/members/user-gone`]: member('lawyer', 'Former Fictional', 'removed'),
    [`${M}/m1`]: matter(),
    [`${M}/m-priv`]: matter({ number: 'RM-2026-0002', privileged: true }),
    [`${M}/m-gone`]: matter({ number: 'RM-2026-0003', deletedAt: NOW }),
    ...initial,
  });
  const clock = new FakeClock(NOW);
  const ports = fakePorts();
  const deps = (): CallableDeps => ({
    db: () => store.db,
    clock,
    ports: () => ports,
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const call = (def: CallableDefinition<never, SaveNoteResult>, data: Data, role: Role = 'lawyer') =>
    runCallable(
      def,
      { data: { requestId: randomUUID(), ...data }, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } },
      deps(),
    );
  const create = (data: Data, role: Role = 'lawyer') =>
    call(createDefinition as never, { matterId: 'm1', ...data }, role);
  const update = (data: Data, role: Role = 'lawyer') =>
    call(updateDefinition as never, { matterId: 'm1', ...data }, role);
  const under = (path: string) =>
    [...store.docs.entries()]
      .filter(([p]) => p.startsWith(`${path}/`) && p.split('/').length === path.split('/').length + 1)
      .map(([p, data]): Data & { id: string } => ({ ...data, id: p.split('/').at(-1) as string }));
  const doc = (path: string) => store.docs.get(path) as Data | undefined;
  const notifications = () => under(`orgs/${ORG}/notifications`);
  const audits = () => under(`orgs/${ORG}/audit`);
  const queued = () => (ports.tasks as FakeTaskQueue).queued;
  return { ...store, clock, create, update, under, doc, notifications, audits, queued };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return { code: (error as HttpsError).code, details: (error as HttpsError).details as Data };
  }
  throw new Error('expected a failure');
};

const iso = (value: unknown) => new Date(millis(value) as number).toISOString();

describe('notes helpers', () => {
  it('keeps mentions of active members only, and matter mentions as written', () => {
    const people = new Map([
      ['user-a', { active: true, role: 'lawyer' as const, displayName: 'A' }],
      ['user-b', { active: false, role: 'lawyer' as const, displayName: 'B' }],
    ]);
    expect(noteMentions('@[user-a] @[user-b] @[nobody] #[m-x] #[m-x]', people)).toEqual({
      uids: ['user-a'],
      matterIds: ['m-x'],
    });
  });

  it('a privileged note opens for privileged.view roles only', () => {
    expect(canOpenNote('lawyer', true)).toBe(true);
    expect(canOpenNote('paralegal', true)).toBe(false);
    expect(canOpenNote('readonly', false)).toBe(true);
    expect(canOpenNote(undefined, false)).toBe(false);
  });
});

describe('notes-create', () => {
  it('writes the note with server-parsed mentions and returns its updatedAt', async () => {
    const w = world();
    const result = await w.create({ bodyMd: 'Spoke to @[user-paralegal] about #[m-priv]. @[user-gone] @[ghost]' });
    expect(result).toEqual({
      noteId: expect.any(String),
      updatedAt: NOW.toISOString(),
      notified: ['user-paralegal'],
      unreachable: [],
    });
    const note = w.doc(`${NOTES}/${result.noteId}`);
    expect(note).toMatchObject({
      bodyMd: 'Spoke to @[user-paralegal] about #[m-priv]. @[user-gone] @[ghost]',
      mentions: { uids: ['user-paralegal'], matterIds: ['m-priv'] },
      pinned: false,
      privileged: false,
      source: 'manual',
      deletedAt: null,
      createdBy: 'user-lawyer',
      updatedBy: 'user-lawyer',
      _requestId: expect.any(String),
    });
    expect(note).not.toHaveProperty('editedAt');
    expect(iso(note?.['updatedAt'])).toBe(result.updatedAt);
  });

  it('notifies each mentioned member once, never the author, with no note text', async () => {
    const w = world();
    const { noteId } = await w.create({
      bodyMd:
        'Confidential: the executor disputes the will. @[user-lawyer] @[user-paralegal] @[user-paralegal] @[user-owner]',
    });
    const sent = w.notifications();
    expect(sent.map((n) => n['recipientUid']).sort()).toEqual(['user-owner', 'user-paralegal']);
    expect(sent.map((n) => n.id).sort()).toEqual([`mention-${noteId}-user-owner`, `mention-${noteId}-user-paralegal`]);
    for (const notification of sent) {
      expect(notification).toMatchObject({
        kind: 'mention',
        noteId,
        matterId: 'm1',
        title: 'Jordan Fictional mentioned you on RM-2026-0001',
        link: `/matters/m1/notes#note-${noteId}`,
        createdBy: 'user-lawyer',
      });
      expect(JSON.stringify(notification)).not.toMatch(/executor|Wren|Confidential/);
    }
    // Email is enqueued after the transaction commits, once per recipient.
    expect(
      w
        .queued()
        .map((task) => task.payload['notificationId'])
        .sort(),
    ).toEqual(sent.map((n) => n.id).sort());
  });

  it('a privileged note notifies only members who can open it; the rest are unreachable', async () => {
    const w = world();
    const result = await w.create({ bodyMd: '@[user-paralegal] @[user-readonly] @[user-owner]', privileged: true });
    expect(result.notified).toEqual(['user-owner']);
    expect(result.unreachable).toEqual(['user-paralegal', 'user-readonly']);
    expect(w.notifications().map((n) => n['recipientUid'])).toEqual(['user-owner']);
    // They are still mentioned: the note says so, they just aren't told.
    expect(w.doc(`${NOTES}/${result.noteId}`)?.['mentions']).toEqual({
      uids: ['user-paralegal', 'user-readonly', 'user-owner'],
      matterIds: [],
    });
  });

  it('a note on a privileged matter is always privileged', async () => {
    const w = world();
    const result = await w.create({ matterId: 'm-priv', bodyMd: 'Advice drafted. @[user-paralegal]' });
    expect(w.doc(`${M}/m-priv/notes/${result.noteId}`)?.['privileged']).toBe(true);
    expect(result.unreachable).toEqual(['user-paralegal']);
    expect(w.notifications()).toEqual([]);
  });

  it('only privileged.view roles mark a note privileged', async () => {
    const w = world();
    const denied = await failure(w.create({ bodyMd: 'Advice', privileged: true }, 'paralegal'));
    expect(denied).toMatchObject({ code: 'permission-denied', details: { reason: 'privileged_requires_lawyer' } });
    expect(w.under(NOTES)).toEqual([]);
    await expect(w.create({ bodyMd: 'File note' }, 'paralegal')).resolves.toMatchObject({ notified: [] });
  });

  it('needs note.write, a live matter the caller can see, and text within 100 KB', async () => {
    const w = world();
    expect((await failure(w.create({ bodyMd: 'Hello' }, 'readonly'))).code).toBe('permission-denied');
    expect((await failure(w.create({ matterId: 'm-gone', bodyMd: 'Hello' }))).code).toBe('not-found');
    expect((await failure(w.create({ matterId: 'm-priv', bodyMd: 'Hello' }, 'paralegal'))).code).toBe('not-found');
    expect((await failure(w.create({ matterId: 'm-missing', bodyMd: 'Hello' }))).code).toBe('not-found');
    const tooLong = await failure(w.create({ bodyMd: 'x'.repeat(NOTE_BODY_MAX + 1) }));
    expect(tooLong.code).toBe('invalid-argument');
    expect(JSON.stringify(tooLong.details)).toContain('A note can be at most 100 KB');
    expect((await failure(w.create({ bodyMd: '   ' }))).code).toBe('invalid-argument');
    await expect(w.create({ bodyMd: 'x'.repeat(NOTE_BODY_MAX) })).resolves.toMatchObject({ notified: [] });
  });

  it('is audited as note.created without the text', async () => {
    const w = world();
    const { noteId } = await w.create({ bodyMd: 'Fictional secret plan @[user-owner]', pinned: true });
    const [entry] = w.audits();
    expect(entry).toMatchObject({
      action: 'note.created',
      entity: { path: `${NOTES}/${noteId}`, collection: 'notes', id: noteId, matterId: 'm1' },
      data: { privileged: false, pinned: true, mentioned: 1, notified: 1 },
    });
    expect(JSON.stringify(entry)).not.toContain('secret');
  });
});

describe('notes-update', () => {
  /** A note created through the callable, then edited later (the clock moves on). */
  async function seeded(bodyMd = 'First draft @[user-paralegal]', extra: Data = {}) {
    const w = world();
    const created = await w.create({ bodyMd, ...extra });
    w.clock.advance(60_000);
    return { w, noteId: created.noteId, updatedAt: created.updatedAt };
  }

  it('replaces the text, keeps the previous version and stamps the edit', async () => {
    const { w, noteId, updatedAt } = await seeded();
    const result = await w.update({ noteId, bodyMd: 'Second draft', expectedUpdatedAt: updatedAt }, 'paralegal');
    const later = new Date(NOW.getTime() + 60_000).toISOString();
    expect(result).toEqual({ noteId, updatedAt: later, notified: [], unreachable: [] });
    const note = w.doc(`${NOTES}/${noteId}`);
    expect(note).toMatchObject({
      bodyMd: 'Second draft',
      mentions: { uids: [], matterIds: [] },
      editedBy: 'user-paralegal',
      updatedBy: 'user-paralegal',
      createdBy: 'user-lawyer',
    });
    expect(iso(note?.['editedAt'])).toBe(later);
    const revisions = w.under(`${NOTES}/${noteId}/revisions`);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      bodyMd: 'First draft @[user-paralegal]',
      privileged: false,
      editedBy: 'user-lawyer',
      createdBy: 'user-paralegal',
    });
    expect(iso(revisions[0]?.['editedAt'])).toBe(NOW.toISOString());

    // A second edit records the paralegal's version, as theirs.
    w.clock.advance(60_000);
    await w.update({ noteId, bodyMd: 'Third draft', expectedUpdatedAt: result.updatedAt });
    const second = w.under(`${NOTES}/${noteId}/revisions`).find((r) => r['bodyMd'] === 'Second draft');
    expect(second).toMatchObject({ editedBy: 'user-paralegal' });
    expect(iso(second?.['editedAt'])).toBe(later);
  });

  it('notifies only members mentioned for the first time', async () => {
    const { w, noteId, updatedAt } = await seeded();
    expect(w.notifications()).toHaveLength(1);
    const result = await w.update({
      noteId,
      bodyMd: 'Still @[user-paralegal], now also @[user-owner] and me @[user-lawyer]',
      expectedUpdatedAt: updatedAt,
    });
    expect(result.notified).toEqual(['user-owner']);
    expect(
      w
        .notifications()
        .map((n) => n['recipientUid'])
        .sort(),
    ).toEqual(['user-owner', 'user-paralegal']);
  });

  it('refuses a stale edit with note_conflict, unless overwrite', async () => {
    const { w, noteId, updatedAt } = await seeded();
    const first = await w.update({ noteId, bodyMd: 'Owner’s version', expectedUpdatedAt: updatedAt }, 'owner');
    const conflict = await failure(w.update({ noteId, bodyMd: 'Lawyer’s version', expectedUpdatedAt: updatedAt }));
    expect(conflict).toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'note_conflict', noteId, updatedAt: first.updatedAt, updatedBy: 'user-owner' },
    });
    expect(w.doc(`${NOTES}/${noteId}`)?.['bodyMd']).toBe('Owner’s version');
    expect(w.under(`${NOTES}/${noteId}/revisions`)).toHaveLength(1);

    const forced = await w.update({
      noteId,
      bodyMd: 'Lawyer’s version',
      expectedUpdatedAt: updatedAt,
      overwrite: true,
    });
    expect(w.doc(`${NOTES}/${noteId}`)?.['bodyMd']).toBe('Lawyer’s version');
    expect(w.under(`${NOTES}/${noteId}/revisions`).map((r) => r['bodyMd'])).toContain('Owner’s version');
    expect(forced.noteId).toBe(noteId);
    expect(w.audits().at(-1)).toMatchObject({ action: 'note.edited', data: { overwrite: true } });
  });

  it('accepts the same instant with another offset', async () => {
    const { w, noteId } = await seeded();
    await expect(
      w.update({ noteId, bodyMd: 'Edited', expectedUpdatedAt: '2026-10-05T10:00:00.000+10:00' }),
    ).resolves.toMatchObject({ noteId });
  });

  it('unchanged text and flag is a no-op: no revision, write or audit', async () => {
    const { w, noteId, updatedAt } = await seeded();
    const before = w.doc(`${NOTES}/${noteId}`);
    const audits = w.audits().length;
    const result = await w.update({ noteId, bodyMd: 'First draft @[user-paralegal]', expectedUpdatedAt: updatedAt });
    expect(result).toEqual({ noteId, updatedAt, notified: [], unreachable: [] });
    expect(w.doc(`${NOTES}/${noteId}`)).toEqual(before);
    expect(w.under(`${NOTES}/${noteId}/revisions`)).toEqual([]);
    expect(w.audits()).toHaveLength(audits);
  });

  it('changes the privileged flag for privileged.view roles only', async () => {
    const { w, noteId, updatedAt } = await seeded('Plain note');
    const denied = await failure(
      w.update({ noteId, bodyMd: 'Plain note', privileged: true, expectedUpdatedAt: updatedAt }, 'paralegal'),
    );
    expect(denied).toMatchObject({ code: 'permission-denied', details: { reason: 'privileged_requires_lawyer' } });
    const marked = await w.update({
      noteId,
      bodyMd: 'Plain note @[user-paralegal] @[user-owner]',
      privileged: true,
      expectedUpdatedAt: updatedAt,
    });
    expect(marked).toMatchObject({ notified: ['user-owner'], unreachable: ['user-paralegal'] });
    expect(w.doc(`${NOTES}/${noteId}`)?.['privileged']).toBe(true);
    expect(w.under(`${NOTES}/${noteId}/revisions`)[0]).toMatchObject({ bodyMd: 'Plain note', privileged: false });
    // Now hidden from the paralegal altogether.
    const hidden = await failure(
      w.update({ noteId, bodyMd: 'Edit', expectedUpdatedAt: marked.updatedAt }, 'paralegal'),
    );
    expect(hidden.code).toBe('not-found');
  });

  it('a note on a privileged matter stays privileged', async () => {
    const w = world();
    const { noteId, updatedAt } = await w.create({ matterId: 'm-priv', bodyMd: 'Advice' });
    await w.update({
      matterId: 'm-priv',
      noteId,
      bodyMd: 'Advice, revised',
      privileged: false,
      expectedUpdatedAt: updatedAt,
    });
    expect(w.doc(`${M}/m-priv/notes/${noteId}`)?.['privileged']).toBe(true);
  });

  it('is NOT_FOUND for a missing or deleted note, or a deleted matter', async () => {
    const { w, noteId, updatedAt } = await seeded();
    const input = { bodyMd: 'Edit', expectedUpdatedAt: updatedAt };
    expect((await failure(w.update({ ...input, noteId: 'missing' }))).code).toBe('not-found');
    w.docs.set(`${M}/m-gone/notes/n1`, { ...w.doc(`${NOTES}/${noteId}`) });
    expect((await failure(w.update({ ...input, matterId: 'm-gone', noteId: 'n1' }))).code).toBe('not-found');
    w.docs.set(`${NOTES}/${noteId}`, {
      ...w.doc(`${NOTES}/${noteId}`),
      deletedAt: w.doc(`${NOTES}/${noteId}`)?.['updatedAt'],
    });
    expect((await failure(w.update({ ...input, noteId }))).code).toBe('not-found');
  });

  it('a pin since the editor opened the note is a conflict too (updatedAt moved)', async () => {
    const { w, noteId, updatedAt } = await seeded();
    const ts = w.doc(`${NOTES}/${noteId}`)?.['updatedAt'] as Timestamp;
    w.docs.set(`${NOTES}/${noteId}`, {
      ...w.doc(`${NOTES}/${noteId}`),
      pinned: true,
      updatedAt: Timestamp.fromMillis(ts.toMillis() + 5_000),
      updatedBy: 'user-owner',
    });
    expect((await failure(w.update({ noteId, bodyMd: 'Edit', expectedUpdatedAt: updatedAt }))).details).toMatchObject({
      reason: 'note_conflict',
      updatedBy: 'user-owner',
    });
  });

  it('needs note.write', async () => {
    const { w, noteId, updatedAt } = await seeded();
    const denied = await failure(w.update({ noteId, bodyMd: 'Edit', expectedUpdatedAt: updatedAt }, 'readonly'));
    expect(denied.code).toBe('permission-denied');
  });
});
