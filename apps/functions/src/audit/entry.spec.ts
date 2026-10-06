import { createHash } from 'node:crypto';

import { Timestamp } from 'firebase-admin/firestore';

import {
  buildWriteEntry,
  changedFields,
  classifyWrite,
  entityFromPath,
  expiryFor,
  hashText,
  LONG_TEXT_CHARS,
  redactFields,
  sameValue,
  toActor,
  type DocData,
} from './entry';

const AT = new Date('2026-10-04T01:02:03.000Z');
const EXPIRE = new Date('2033-10-04T01:02:03.000Z');
const ORG = 'orgs/org-a';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const meta = (uid: string, extra: DocData = {}): DocData => ({
  createdAt: Timestamp.fromDate(new Date('2026-01-01')),
  createdBy: uid,
  updatedAt: Timestamp.fromDate(AT),
  updatedBy: uid,
  schemaVersion: 1,
  ...extra,
});

const build = (path: string, before: DocData | undefined, after: DocData | undefined) =>
  buildWriteEntry({ path, before, after, at: AT, expireAt: EXPIRE });

const entryOf = (result: ReturnType<typeof build>) => {
  if ('skip' in result) throw new Error(`skipped: ${result.skip}`);
  return result.entry;
};

describe('sameValue', () => {
  it('compares Firestore values structurally', () => {
    expect(sameValue(Timestamp.fromMillis(5), Timestamp.fromMillis(5))).toBe(true);
    expect(sameValue(Timestamp.fromMillis(5), Timestamp.fromMillis(6))).toBe(false);
    expect(sameValue(new Date(1), new Date(1))).toBe(true);
    expect(sameValue(new Date(1), { getTime: () => 1 })).toBe(false);
    expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(sameValue([1], { 0: 1 })).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue(null, {})).toBe(false);
    expect(sameValue('a', 'a')).toBe(true);
  });

  it('gives up (as changed) beyond the depth limit', () => {
    let deep: DocData = { v: 1 };
    for (let i = 0; i < 12; i++) deep = { n: deep };
    expect(sameValue(deep, structuredClone(deep))).toBe(false);
  });
});

describe('changedFields', () => {
  it('lists changed top-level fields, sorted, without meta', () => {
    expect(
      changedFields(
        meta('u1', { status: 'open', title: 'A' }),
        meta('u2', { status: 'closed', title: 'A', priority: 'high' }),
      ),
    ).toEqual(['priority', 'status']);
    expect(changedFields(undefined, meta('u1', { title: 'A' }))).toEqual(['title']);
  });
});

describe('classifyWrite', () => {
  it('tells creates, updates, deletes, soft deletes and restores apart', () => {
    expect(classifyWrite(undefined, undefined)).toBeNull();
    expect(classifyWrite(undefined, {})).toBe('create');
    expect(classifyWrite({}, undefined)).toBe('delete');
    expect(classifyWrite({ a: 1 }, { a: 2 })).toBe('update');
    expect(classifyWrite({ deletedAt: null }, { deletedAt: Timestamp.now() })).toBe('soft_delete');
    expect(classifyWrite({ deletedAt: Timestamp.now() }, {})).toBe('restore');
  });
});

describe('redaction', () => {
  it('hashes bodyMd and narrative, drops secrets, and hashes any long string', () => {
    const bodyMd = 'File note: spoke with the executor about the house sale.';
    const narrative = 'Attend to telephone call with executor.';
    const long = 'x'.repeat(LONG_TEXT_CHARS + 1);
    const redacted = redactFields(
      {
        bodyMd,
        narrative,
        status: 'draft',
        encryptedRefreshToken: 'enc',
        tokenHash: 'hash',
        nested: { descriptionMd: 'Private', refreshToken: 'r', short: 'ok' },
        list: [{ quote: 'quoted words' }, long],
        at: Timestamp.fromMillis(1),
        when: new Date(2),
      },
      [
        'bodyMd',
        'narrative',
        'status',
        'encryptedRefreshToken',
        'tokenHash',
        'nested',
        'list',
        'at',
        'when',
        'missing',
      ],
    );
    expect(redacted).toEqual({
      bodyMd: { len: bodyMd.length, sha256: sha(bodyMd) },
      narrative: { len: narrative.length, sha256: sha(narrative) },
      status: 'draft',
      nested: { descriptionMd: { len: 7, sha256: sha('Private') }, short: 'ok' },
      list: [{ quote: { len: 12, sha256: sha('quoted words') } }, { len: long.length, sha256: sha(long) }],
      at: Timestamp.fromMillis(1),
      when: new Date(2),
    });
    expect(JSON.stringify(redacted)).not.toContain('executor');
    expect(hashText('abc')).toEqual({ len: 3, sha256: sha('abc') });
  });
});

describe('toActor and entityFromPath', () => {
  it('maps actors', () => {
    expect(toActor('user-1')).toEqual({ uid: 'user-1' });
    expect(toActor('system')).toBe('system');
    expect(toActor('clerk')).toBe('clerk');
    expect(toActor(undefined)).toBe('system');
    expect(toActor('')).toBe('system');
  });

  it('parses org and matter paths', () => {
    expect(entityFromPath(`${ORG}/contacts/c1`)).toEqual({
      path: `${ORG}/contacts/c1`,
      collection: 'contacts',
      id: 'c1',
    });
    expect(entityFromPath(`${ORG}/matters/m1`)).toEqual({
      path: `${ORG}/matters/m1`,
      collection: 'matters',
      id: 'm1',
      matterId: 'm1',
    });
    expect(entityFromPath(`${ORG}/matters/m1/tasks/t1`)).toEqual({
      path: `${ORG}/matters/m1/tasks/t1`,
      collection: 'tasks',
      id: 't1',
      matterId: 'm1',
    });
    expect(entityFromPath('orgs/org-a')).toEqual({ path: 'orgs/org-a' });
  });
});

describe('buildWriteEntry', () => {
  it('records a create with the creator, all fields and no before', () => {
    const entry = entryOf(
      build(`${ORG}/contacts/c1`, undefined, meta('user-1', { kind: 'person', notes: 'Prefers email' })),
    );
    expect(entry).toMatchObject({
      at: AT,
      actor: { uid: 'user-1' },
      action: 'create',
      entity: { path: `${ORG}/contacts/c1`, collection: 'contacts', id: 'c1' },
      changedFields: ['kind', 'notes'],
      after: { kind: 'person', notes: { len: 13, sha256: sha('Prefers email') } },
      source: 'client',
      expireAt: EXPIRE,
      createdBy: 'user-1',
      schemaVersion: 1,
    });
    expect(entry).not.toHaveProperty('before');
  });

  it('records an update with only the changed fields, before and after', () => {
    const entry = entryOf(
      build(
        `${ORG}/matters/m1`,
        meta('user-1', { status: 'open', title: 'Estate', priority: 'normal' }),
        meta('user-2', { status: 'closed', title: 'Estate', priority: 'normal' }),
      ),
    );
    expect(entry).toMatchObject({
      actor: { uid: 'user-2' },
      action: 'update',
      entity: { matterId: 'm1' },
      changedFields: ['status'],
      before: { status: 'open' },
      after: { status: 'closed' },
    });
  });

  it('attributes soft deletes and hard deletes', () => {
    const live = meta('user-1', { title: 'Call executor' });
    const soft = entryOf(
      build(`${ORG}/matters/m1/tasks/t1`, live, {
        ...live,
        deletedAt: Timestamp.fromDate(AT),
        deletedBy: 'user-3',
        updatedBy: 'user-3',
      }),
    );
    expect(soft).toMatchObject({
      action: 'soft_delete',
      actor: { uid: 'user-3' },
      changedFields: ['deletedAt', 'deletedBy'],
    });
    const restored = entryOf(
      build(
        `${ORG}/matters/m1/tasks/t1`,
        { ...live, deletedAt: Timestamp.fromDate(AT) },
        meta('user-4', { title: 'Call executor' }),
      ),
    );
    expect(restored).toMatchObject({ action: 'restore', actor: { uid: 'user-4' } });
    const hard = entryOf(build(`${ORG}/matters/m1/tasks/t1`, { ...live, deletedBy: 'user-5' }, undefined));
    expect(hard).toMatchObject({ action: 'delete', actor: { uid: 'user-5' }, before: { title: 'Call executor' } });
    expect(hard).not.toHaveProperty('after');
    const hardNoDeleter = entryOf(build(`${ORG}/matters/m1/tasks/t1`, live, undefined));
    expect(hardNoDeleter['actor']).toEqual({ uid: 'user-1' });
  });

  it('marks callable and system writes, and leaves the migration load to its one entry per run', () => {
    const callable = entryOf(
      build(`${ORG}/invoices/i1`, undefined, meta('user-1', { status: 'issued', _requestId: 'req-1' })),
    );
    expect(callable).toMatchObject({ source: 'callable', requestId: 'req-1', changedFields: ['status'] });
    const system = entryOf(
      build(`${ORG}/invoices/i1`, meta('user-1', { status: 'draft' }), meta('system', { status: 'void' })),
    );
    expect(system).toMatchObject({ source: 'trigger', actor: 'system' });
    const clerk = entryOf(build(`${ORG}/matters/m1/tasks/t2`, undefined, meta('clerk', { title: 'Suggested' })));
    expect(clerk).toMatchObject({ source: 'trigger', actor: 'clerk' });
    const migration = { runId: 'run-7', legacyPath: 'legacy/x', loadedAt: Timestamp.fromDate(AT) };
    expect(build(`${ORG}/contacts/c9`, undefined, meta('system', { kind: 'person', migration }))).toEqual({
      skip: 'migration load',
    });
    // A re-load restamps `loadedAt`: still the load.
    const reloaded = { ...migration, loadedAt: Timestamp.fromDate(new Date(AT.getTime() + 60_000)) };
    expect(
      build(
        `${ORG}/contacts/c9`,
        meta('system', { kind: 'person', migration }),
        meta('system', { kind: 'org', migration: reloaded }),
      ),
    ).toEqual({ skip: 'migration load' });
    // A later edit of a migrated document is an ordinary write.
    const edited = entryOf(
      build(
        `${ORG}/contacts/c9`,
        meta('system', { kind: 'person', migration }),
        meta('user-1', { kind: 'org', migration }),
      ),
    );
    expect(edited).toMatchObject({ source: 'client' });
    expect(edited).not.toHaveProperty('runId');
  });

  it('skips excluded collections, meta-only and denormalised-only updates', () => {
    expect(build(`${ORG}/audit/a1`, undefined, { x: 1 })).toEqual({ skip: 'excluded collection' });
    expect(build(`${ORG}/metrics/day-2026-10-04`, undefined, { x: 1 })).toEqual({ skip: 'excluded collection' });
    expect(build(`${ORG}/migrations/run-1`, undefined, { status: 'running' })).toEqual({ skip: 'excluded collection' });
    expect(build(`${ORG}/matters/m1/activity/a1`, undefined, { x: 1 })).toEqual({ skip: 'excluded collection' });
    expect(build(`${ORG}/matters/m1`, undefined, undefined)).toEqual({ skip: 'no data' });
    expect(build(`${ORG}/matters/m1`, meta('u1', { a: 1 }), meta('u2', { a: 1 }))).toEqual({ skip: 'meta only' });
    expect(
      build(
        `${ORG}/matters/m1`,
        meta('u1', { nextDeadline: null, openTaskCount: 1 }),
        meta('system', { nextDeadline: 'x', openTaskCount: 2 }),
      ),
    ).toEqual({
      skip: 'denormalised fields only',
    });
    expect(build(`${ORG}/matters/m1/tasks/t1`, meta('u1', { order: 1 }), meta('u1', { order: 2 }))).toEqual({
      skip: 'denormalised fields only',
    });
    // A real change alongside a denormalised one is audited.
    expect(
      entryOf(
        build(`${ORG}/matters/m1/tasks/t1`, meta('u1', { order: 1, title: 'A' }), meta('u1', { order: 2, title: 'B' })),
      )['changedFields'],
    ).toEqual(['order', 'title']);
  });
});

describe('expiryFor', () => {
  it('adds calendar years', () => {
    expect(expiryFor(AT, 7)).toEqual(EXPIRE);
    expect(expiryFor(new Date('2028-02-29T00:00:00Z'), 1).toISOString()).toBe('2029-03-01T00:00:00.000Z');
  });
});
