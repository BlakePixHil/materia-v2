import { Timestamp } from 'firebase-admin/firestore';

import {
  ACTIVITY_BATCH,
  candidateFor,
  contactActivityPage,
  decodeCursor,
  encodeCursor,
  type ActivitySource,
  type AuditDoc,
} from './activity';

/** `contacts-activity` (CORE-01a): mapping audit entries to lines, and paging. Everything is fictional. */

const ORG = 'org-a';
const CONTACT = `orgs/${ORG}/contacts/c-1`;
const PARTY = (matterId: string, partyId: string) => `orgs/${ORG}/matters/${matterId}/parties/${partyId}`;

let clock = Date.parse('2026-10-06T00:00:00Z');
let ids = 0;
/** An audit entry, each one a second older than the last (the log reads newest first). */
function entry(data: Record<string, unknown>): AuditDoc {
  clock -= 1000;
  ids++;
  return {
    id: `a-${String(1000 - ids).padStart(4, '0')}`,
    data: { at: Timestamp.fromMillis(clock), actor: { uid: 'u-priya' }, source: 'client', ...data },
  };
}
const write = (action: string, path: string, extra: Record<string, unknown> = {}) => {
  const parts = path.split('/');
  return entry({
    action,
    entity: {
      path,
      collection: parts.at(-2),
      id: parts.at(-1),
      ...(parts[2] === 'matters' ? { matterId: parts[3] } : {}),
    },
    ...extra,
  });
};
const semantic = (action: string, path: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  write(action, path, { source: 'callable', data, ...extra });

class FakeSource implements ActivitySource {
  reads = 0;
  constructor(
    private readonly entries: AuditDoc[],
    readonly docs: Record<string, Record<string, unknown>> = {},
  ) {}
  async read(cursor: { id: string } | null, size: number) {
    this.reads++;
    const start = cursor ? this.entries.findIndex((e) => e.id === cursor.id) + 1 : 0;
    return this.entries.slice(start, start + size).map((e) => {
      const at = e.data['at'] as Timestamp;
      return { entry: e, cursor: { s: at.seconds, n: at.nanoseconds, id: e.id } };
    });
  }
  async getAll(paths: readonly string[]) {
    return paths.map((path) => this.docs[path]);
  }
}

const page = (source: ActivitySource, options: { limit?: number; canSeePrivileged?: boolean; cursor?: string } = {}) =>
  contactActivityPage(source, {
    orgId: ORG,
    contactId: 'c-1',
    limit: options.limit ?? 20,
    cursor: options.cursor ? decodeCursor(options.cursor) : null,
    canSeePrivileged: options.canSeePrivileged ?? true,
  });

const MATTERS = {
  [`orgs/${ORG}/matters/m-1`]: {
    number: 'HV-2026-0001',
    title: 'Estate of Example One',
    privileged: false,
    deletedAt: null,
  },
  [`orgs/${ORG}/matters/m-secret`]: { number: 'HV-2026-0002', title: 'Privileged estate', privileged: true },
  [`orgs/${ORG}/matters/m-deleted`]: { number: 'HV-2026-0003', title: 'Deleted', deletedAt: new Date() },
  [`orgs/${ORG}/contacts/c-old`]: { kind: 'person', givenNames: 'Avery', familyName: 'Fictional' },
};

describe('candidateFor', () => {
  it('maps the contact’s own writes: added, edits by detail, deleted, restored', () => {
    const map = (e: AuditDoc) => candidateFor(e, ORG, 'c-1')?.line;
    expect(map(write('create', CONTACT))).toMatchObject({ kind: 'created', actorUid: 'u-priya' });
    expect(map(write('update', CONTACT, { changedFields: ['phones', 'emails'] }))).toMatchObject({
      kind: 'updated',
      fields: ['phones', 'emails'],
    });
    expect(map(write('update', CONTACT, { changedFields: ['search'] }))).toBeUndefined();
    expect(map(write('soft_delete', CONTACT, { changedFields: ['deletedAt', 'deletedBy'] }))).toMatchObject({
      kind: 'deleted',
    });
    expect(map(write('restore', CONTACT))).toMatchObject({ kind: 'restored' });
    expect(map(write('update', `orgs/${ORG}/contacts/c-2`, { changedFields: ['phones'] }))).toBeUndefined();
  });

  it('maps merges both ways, once per merge', () => {
    const merged = semantic('contact.merged', CONTACT, { keepId: 'c-1', mergeId: 'c-old', resumed: false });
    expect(candidateFor(merged, ORG, 'c-1')).toMatchObject({ otherId: 'c-old', line: { kind: 'merged_in' } });
    const resumed = semantic('contact.merged', CONTACT, { keepId: 'c-1', mergeId: 'c-old', resumed: true });
    expect(candidateFor(resumed, ORG, 'c-1')).toBeNull();
    const tombstone = write('soft_delete', CONTACT, {
      changedFields: ['deletedAt', 'deletedBy', 'mergedInto'],
      after: { mergedInto: 'c-keep' },
    });
    expect(candidateFor(tombstone, ORG, 'c-1')).toMatchObject({ otherId: 'c-keep', line: { kind: 'merged_away' } });
  });

  it('maps matter links from the parties callables and from intake’s writes', () => {
    const added = semantic('matter.party_added', PARTY('m-1', 'executor-c-1'), {
      matterId: 'm-1',
      contactId: 'c-1',
      role: 'executor',
    });
    expect(candidateFor(added, ORG, 'c-1')).toMatchObject({
      matterId: 'm-1',
      semantic: true,
      line: { kind: 'party_added', role: 'executor' },
    });
    const moved = semantic('matter.party_updated', PARTY('m-1', 'executor-c-1'), {
      matterId: 'm-1',
      contactId: 'c-1',
      role: 'executor',
      previousRole: 'beneficiary',
    });
    expect(candidateFor(moved, ORG, 'c-1')?.line).toMatchObject({
      kind: 'party_role_changed',
      role: 'executor',
      previousRole: 'beneficiary',
    });
    const share = semantic('matter.party_updated', PARTY('m-1', 'beneficiary-c-1'), {
      matterId: 'm-1',
      contactId: 'c-1',
      role: 'beneficiary',
    });
    expect(candidateFor(share, ORG, 'c-1')?.line.kind).toBe('party_updated');
    const removed = semantic('matter.party_removed', PARTY('m-1', 'executor-c-1'), {
      matterId: 'm-1',
      contactId: 'c-1',
      role: 'executor',
    });
    expect(candidateFor(removed, ORG, 'c-1')?.line.kind).toBe('party_removed');
    const intake = write('create', PARTY('m-1', 'client-c-1'), {
      source: 'callable',
      requestId: 'r-intake',
      after: { contactId: 'c-1', role: 'client', matterId: 'm-1' },
    });
    expect(candidateFor(intake, ORG, 'c-1')).toMatchObject({
      semantic: false,
      line: { kind: 'party_added', role: 'client' },
    });
    // Someone else's party, a merge re-pointing a row, and other collections aren't this contact's lines.
    expect(
      candidateFor(
        { ...added, data: { ...added.data, data: { ...(added.data['data'] as object), contactId: 'c-9' } } },
        ORG,
        'c-1',
      ),
    ).toBeNull();
    expect(
      candidateFor(write('update', PARTY('m-1', 'client-c-1'), { after: { contactId: 'c-1' } }), ORG, 'c-1'),
    ).toBeNull();
    expect(
      candidateFor(write('create', `orgs/${ORG}/matters/m-1/notes/n-1`, { after: { contactId: 'c-1' } }), ORG, 'c-1'),
    ).toBeNull();
  });
});

describe('contactActivityPage', () => {
  it('names the matter, leaves out deleted and (without privileged.view) privileged matters', async () => {
    const source = new FakeSource(
      [
        semantic('matter.party_added', PARTY('m-secret', 'executor-c-1'), {
          matterId: 'm-secret',
          contactId: 'c-1',
          role: 'executor',
        }),
        semantic('matter.party_added', PARTY('m-deleted', 'executor-c-1'), {
          matterId: 'm-deleted',
          contactId: 'c-1',
          role: 'executor',
        }),
        semantic('matter.party_added', PARTY('m-1', 'executor-c-1'), {
          matterId: 'm-1',
          contactId: 'c-1',
          role: 'executor',
        }),
        semantic('contact.merged', CONTACT, { keepId: 'c-1', mergeId: 'c-old' }),
        write('create', CONTACT),
      ],
      MATTERS,
    );
    const lawyer = await page(source);
    expect(lawyer.lines.map((line) => [line.kind, line.matter?.id ?? line.other?.name ?? null])).toEqual([
      ['party_added', 'm-secret'],
      ['party_added', 'm-1'],
      ['merged_in', 'Avery Fictional'],
      ['created', null],
    ]);
    expect(lawyer.lines[1]?.matter).toEqual({ id: 'm-1', number: 'HV-2026-0001', title: 'Estate of Example One' });
    expect(lawyer.nextCursor).toBeNull();

    const paralegal = await page(source, { canSeePrivileged: false });
    expect(paralegal.lines.map((line) => line.matter?.id ?? line.kind)).toEqual(['m-1', 'merged_in', 'created']);
  });

  it('keeps one line per event: the semantic entry over the write it explains', async () => {
    const semanticFirst = semantic(
      'matter.party_updated',
      PARTY('m-1', 'executor-c-1'),
      { matterId: 'm-1', contactId: 'c-1', role: 'executor', previousRole: 'beneficiary' },
      { requestId: 'r-1' },
    );
    const itsWrite = write('create', PARTY('m-1', 'executor-c-1'), {
      source: 'callable',
      requestId: 'r-1',
      after: { contactId: 'c-1', role: 'executor' },
    });
    const keepWrite = write('update', CONTACT, { requestId: 'r-merge', changedFields: ['phones'] });
    const merge = semantic('contact.merged', CONTACT, { keepId: 'c-1', mergeId: 'c-old' }, { requestId: 'r-merge' });
    const result = await page(new FakeSource([semanticFirst, itsWrite, keepWrite, merge], MATTERS));
    expect(result.lines.map((line) => line.kind)).toEqual(['party_role_changed', 'merged_in']);
    expect(result.lines.map((line) => line.id)).toEqual([semanticFirst.id, merge.id]);
  });

  it('never splits an event across pages: a full page reads on to fold in the rest of it', async () => {
    const semanticFirst = semantic(
      'matter.party_added',
      PARTY('m-1', 'executor-c-1'),
      { matterId: 'm-1', contactId: 'c-1', role: 'executor' },
      { requestId: 'r-1' },
    );
    const itsWrite = write('create', PARTY('m-1', 'executor-c-1'), {
      requestId: 'r-1',
      after: { contactId: 'c-1', role: 'executor' },
    });
    const keepWrite = write('update', CONTACT, { requestId: 'r-merge', changedFields: ['phones'] });
    const merge = semantic('contact.merged', CONTACT, { keepId: 'c-1', mergeId: 'c-old' }, { requestId: 'r-merge' });
    const created = write('create', CONTACT);
    const source = new FakeSource([semanticFirst, itsWrite, keepWrite, merge, created], MATTERS);
    const first = await page(source, { limit: 1 });
    expect(first.lines.map((line) => line.kind)).toEqual(['party_added']);
    // Page 1 took the party row's write with it; on page 2 the merge's own write gives way to the merge.
    const second = await page(source, { limit: 1, cursor: first.nextCursor as string });
    expect(second.lines.map((line) => [line.id, line.kind])).toEqual([[merge.id, 'merged_in']]);
    const third = await page(source, { limit: 1, cursor: second.nextCursor as string });
    expect(third.lines.map((line) => line.kind)).toEqual(['created']);
    expect(third.nextCursor).toBeNull();
  });

  it('keeps client edits that carry a callable’s old request id as lines of their own', async () => {
    // The contact keeps `_requestId` from contacts-create, so every later edit's entry carries it.
    const laterEdit = write('update', CONTACT, { requestId: 'r-create', changedFields: ['emails'] });
    const edit = write('update', CONTACT, { requestId: 'r-create', changedFields: ['phones'] });
    const created = write('create', CONTACT, { requestId: 'r-create' });
    expect((await page(new FakeSource([laterEdit, edit, created], MATTERS))).lines.map((l) => l.kind)).toEqual([
      'updated',
      'updated',
      'created',
    ]);
    // A merge explains the writes it made, not an edit a minute later that still carries its id.
    const editAfter = write('update', CONTACT, { requestId: 'r-merge', changedFields: ['notes'] });
    clock -= 60_000;
    const keepWrite = write('update', CONTACT, { requestId: 'r-merge', changedFields: ['phones'] });
    const keepWrite2 = write('update', CONTACT, { requestId: 'r-merge', changedFields: ['emails'] });
    const merge = semantic('contact.merged', CONTACT, { keepId: 'c-1', mergeId: 'c-old' }, { requestId: 'r-merge' });
    const lines = (await page(new FakeSource([editAfter, keepWrite, keepWrite2, merge], MATTERS))).lines;
    expect(lines.map((l) => [l.kind, l.fields ?? null])).toEqual([
      ['updated', ['notes']],
      ['merged_in', null],
    ]);
  });

  it('pages newest first with a cursor, reading on past entries that aren’t lines', async () => {
    const entries = [
      ...Array.from({ length: ACTIVITY_BATCH + 5 }, () => write('update', CONTACT, { changedFields: ['search'] })),
      ...Array.from({ length: 30 }, () => write('update', CONTACT, { changedFields: ['notes'] })),
    ];
    const source = new FakeSource(entries, MATTERS);
    const first = await page(source, { limit: 20 });
    expect(first.lines).toHaveLength(20);
    expect(first.lines[0]?.id).toBe(entries[ACTIVITY_BATCH + 5]?.id);
    expect(source.reads).toBe(2);
    const second = await page(source, { limit: 20, cursor: first.nextCursor as string });
    expect(second.lines).toHaveLength(10);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.lines, ...second.lines].map((line) => line.id)).size).toBe(30);
  });

  it('round-trips the cursor and refuses a forged one', () => {
    const cursor = { s: 1_790_000_000, n: 123_000, id: 'a-1' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(() => decodeCursor('not-a-cursor')).toThrow(/Invalid cursor/);
  });
});
