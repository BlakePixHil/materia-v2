import { domain } from '../domain.ts';
import { FIXTURE_DIR, FIXTURE_UIDS } from '../legacy/fixtures.ts';
import { loadProfile, type MappingProfile } from '../profile.ts';
import { buildNote, mapComments, mentionText, richText, type MatterRef } from './comments.ts';
import { migId, Warnings, type TransformContext, type WarningCode } from './context.ts';

const { NOTE_BODY_MAX } = domain;
const UID = FIXTURE_UIDS.subject;
const COLLEAGUE = FIXTURE_UIDS.colleague;
const DEPARTED = FIXTURE_UIDS.departed;
const STRANGER = FIXTURE_UIDS.stranger;
const CARD = 'workflows/0b6f1c2e-5d4a-4c3b-9a8e-111111111111/cards/WillsCardAuto0000001';
const AS_OF = new Date('2026-10-06T21:00:00.123Z');
const CREATED = new Date('2025-01-10T00:30:00.000Z');
const UPDATED = new Date('2025-02-10T00:30:00.000Z');

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadProfile(`${FIXTURE_DIR}mapping-profile.json`);
});

function makeCtx(over: Partial<TransformContext> = {}): TransformContext {
  return {
    runId: 'run1',
    uid: UID,
    orgId: 'org1',
    profile,
    timeZone: 'Australia/Melbourne',
    asOf: AS_OF,
    // Jordan has a profile; the departed user's is gone.
    people: new Map<string, string | null>([
      [COLLEAGUE, 'Jordan Ellis'],
      [DEPARTED, null],
    ]),
    members: new Set([UID]),
    warnings: new Warnings(),
    ...over,
  };
}

function warned(ctx: TransformContext): Partial<Record<WarningCode, string[]>> {
  return Object.fromEntries(
    Object.entries(ctx.warnings.summary())
      .filter(([, entry]) => entry.count > 0)
      .map(([code, entry]) => [code, entry.paths]),
  );
}

const matter: MatterRef = {
  orgId: 'org1',
  matterId: migId(CARD),
  cardPath: CARD,
  createdAt: CREATED,
  updatedAt: UPDATED,
};

const mention = (uid: string, name: string) =>
  `<span class="mention" data-index="0" data-denotation-char="@" data-id="${uid}" data-value="${name}">\uFEFF` +
  `<span contenteditable="false"><span class="ql-mention-denotation-char">@</span>${name}</span>\uFEFF</span>`;

describe('buildNote', () => {
  const input = { legacyPath: `${CARD}#description`, bodyMd: 'Hello', createdAt: CREATED, updatedAt: UPDATED };

  it('builds a migrated note under the matter, with a deterministic id', () => {
    const ctx = makeCtx();
    const note = buildNote(ctx, matter, { ...input, authorUid: UID });
    const id = migId(`${CARD}#description`);
    expect(note.entity).toBe('notes');
    expect(note.path).toBe(`orgs/org1/matters/${matter.matterId}/notes/${id}`);
    expect(note.legacyPath).toBe(`${CARD}#description`);
    expect(note.data).toEqual({
      bodyMd: 'Hello',
      mentions: { uids: [], matterIds: [] },
      pinned: false,
      privileged: false,
      source: 'migration',
      deletedAt: null,
      createdAt: CREATED,
      createdBy: UID,
      updatedAt: UPDATED,
      updatedBy: UID,
      schemaVersion: 1,
      migration: { runId: 'run1', legacyPath: `${CARD}#description`, loadedAt: AS_OF },
    });
    expect(domain.NoteSchema.parse(note.data)).toEqual(note.data);
    expect(warned(ctx)).toEqual({});
    expect(buildNote(makeCtx(), matter, { ...input, authorUid: UID }).path).toBe(note.path);
  });

  it('parses member mentions from @[uid] tokens', () => {
    const note = buildNote(makeCtx(), matter, {
      ...input,
      bodyMd: `Ask @[${UID}] and @[${UID}] about #[matter42]`,
      authorUid: UID,
    });
    expect(note.data?.['mentions']).toEqual({ uids: [UID], matterIds: ['matter42'] });
  });

  it('pins a note when asked', () => {
    expect(buildNote(makeCtx(), matter, { ...input, pinned: true }).data?.['pinned']).toBe(true);
  });

  it('is written by the migration, naming the legacy author, when the author is not a member', () => {
    const note = buildNote(makeCtx(), matter, { ...input, legacyAuthor: 'Jordan Ellis' });
    expect(note.data).toMatchObject({ createdBy: 'migration', updatedBy: 'migration', legacyAuthor: 'Jordan Ellis' });
    expect(domain.NoteSchema.parse(note.data)).toEqual(note.data);
  });

  it('cuts a legacy author longer than 200 characters', () => {
    const ctx = makeCtx();
    const note = buildNote(ctx, matter, { ...input, legacyAuthor: 'A'.repeat(250) });
    expect(note.data?.['legacyAuthor']).toBe('A'.repeat(200));
    expect(warned(ctx)).toEqual({ MIG_W_TEXT_TRUNCATED: [`${CARD}#description`] });
  });

  it('stamps editedAt and editedBy with the author', () => {
    const edited = new Date('2025-01-12T06:00:00.000Z');
    expect(buildNote(makeCtx(), matter, { ...input, authorUid: UID, editedAt: edited }).data).toMatchObject({
      editedAt: edited,
      editedBy: UID,
    });
    expect(
      buildNote(makeCtx(), matter, { ...input, legacyAuthor: 'Jordan Ellis', editedAt: edited }).data,
    ).toMatchObject({ editedAt: edited, editedBy: 'migration' });
    expect(buildNote(makeCtx(), matter, input).data).not.toHaveProperty('editedAt');
  });

  it(`cuts a body longer than NOTE_BODY_MAX (${NOTE_BODY_MAX}) with a warning`, () => {
    const ctx = makeCtx();
    const note = buildNote(ctx, matter, { ...input, bodyMd: `${'x'.repeat(NOTE_BODY_MAX)}@[${UID}]` });
    expect(note.data?.['bodyMd']).toBe('x'.repeat(NOTE_BODY_MAX));
    // The mention after the cut is gone with it.
    expect(note.data?.['mentions']).toEqual({ uids: [], matterIds: [] });
    expect(warned(ctx)).toEqual({ MIG_W_NOTE_TRUNCATED: [`${CARD}#description`] });
    expect(() => domain.NoteSchema.parse(note.data)).not.toThrow();
  });

  it('never cuts a note inside a mention or an emoji', () => {
    const ctx = makeCtx();
    const mention = buildNote(ctx, matter, { ...input, bodyMd: `${'x'.repeat(NOTE_BODY_MAX - 5)}@[${UID}] after` });
    expect(mention.data?.['bodyMd']).toBe('x'.repeat(NOTE_BODY_MAX - 5));
    expect(mention.data?.['mentions']).toEqual({ uids: [], matterIds: [] });
    const emoji = buildNote(ctx, matter, { ...input, bodyMd: `${'x'.repeat(NOTE_BODY_MAX - 1)}\u{1F600}` });
    expect(emoji.data?.['bodyMd']).toBe('x'.repeat(NOTE_BODY_MAX - 1));
  });

  it('keeps a body of exactly NOTE_BODY_MAX characters', () => {
    const ctx = makeCtx();
    const note = buildNote(ctx, matter, { ...input, bodyMd: 'y'.repeat(NOTE_BODY_MAX) });
    expect(note.data?.['bodyMd']).toHaveLength(NOTE_BODY_MAX);
    expect(warned(ctx)).toEqual({});
  });
});

describe('mentionText', () => {
  it('keeps a member mention as an @[uid] token', () => {
    expect(mentionText(makeCtx(), UID, 'Alex Rivers')).toBe(`@[${UID}]`);
  });

  it('writes a non-member as plain text from the name the mention showed', () => {
    expect(mentionText(makeCtx(), COLLEAGUE, 'Jordan E.')).toBe('@Jordan E. (imported)');
  });

  it("falls back to the person's profile name, then to a former colleague", () => {
    expect(mentionText(makeCtx(), COLLEAGUE, '')).toBe('@Jordan Ellis (imported)');
    expect(mentionText(makeCtx(), DEPARTED, '')).toBe('@a former colleague (imported)');
    expect(mentionText(makeCtx(), STRANGER, '')).toBe('@a former colleague (imported)');
  });

  it('never lets a shown name read as a mention token', () => {
    const text = mentionText(makeCtx(), COLLEAGUE, `@[${UID}]`);
    expect(text).toBe(`@@\u200B[${UID}] (imported)`);
    expect(domain.parseMentions(text).uids).toEqual([]);
  });

  it('keeps a mention of someone who became a member', () => {
    const ctx = makeCtx({ members: new Set([UID, COLLEAGUE]) });
    expect(mentionText(ctx, COLLEAGUE, 'Jordan Ellis')).toBe(`@[${COLLEAGUE}]`);
  });
});

describe('richText', () => {
  it.each([undefined, null, 42, '', '   '])('gives nothing for %j', (html) => {
    const ctx = makeCtx();
    expect(richText(ctx, html, CARD)).toEqual({ markdown: '', images: [] });
    expect(warned(ctx)).toEqual({});
  });

  it('turns Quill HTML into Markdown with mentions', () => {
    const ctx = makeCtx();
    const html = `<p>Ask ${mention(UID, 'Alex Rivers')} and ${mention(COLLEAGUE, 'Jordan Ellis')} about <strong>the trust</strong>.</p>`;
    expect(richText(ctx, html, CARD)).toEqual({
      markdown: `Ask @[${UID}] and @Jordan Ellis (imported) about **the trust**.`,
      images: [],
    });
    expect(warned(ctx)).toEqual({});
  });

  it('warns when it removes unsafe HTML or drops a remote image', () => {
    const ctx = makeCtx();
    const html =
      '<p>See <a href="https://example.com/brief">the brief</a><img src="https://tracker.example.com/pixel.gif"><script>alert(1)</script></p>';
    expect(richText(ctx, html, CARD).markdown).toBe('See [the brief](https://example.com/brief)');
    expect(warned(ctx)).toEqual({ MIG_W_HTML_UNSAFE_REMOVED: [CARD], MIG_W_REMOTE_IMAGE_DROPPED: [CARD] });
  });

  it('returns inline images, replaced by nothing unless told otherwise', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const html = `<p>Before</p><p><img src="data:image/png;base64,${png}"></p><p>After</p>`;
    const plain = richText(makeCtx(), html, CARD);
    // The paragraph the image was in is empty without it: a paragraph break.
    expect(plain.markdown).toBe('Before\n\nAfter');
    expect(plain.images).toHaveLength(1);
    expect(plain.images[0]).toMatchObject({ mime: 'image/png', extension: 'png', base64: png });
    const named = richText(makeCtx(), html, CARD, (index) => `[image ${index}]`);
    expect(named.markdown).toBe('Before\n[image 0]\nAfter');
  });
});

describe('mapComments', () => {
  const comment = (over: Record<string, unknown> = {}) => ({
    id: 'c0000001-0000-4000-8000-000000000001',
    uid: UID,
    comment: '<p>Called the client.</p>',
    date: '2025-01-12T05:00:00.000Z',
    edited: false,
    editDate: null,
    ...over,
  });
  const path = `${CARD}#comment/c0000001-0000-4000-8000-000000000001`;

  it("keeps a member's comment as their note", () => {
    const ctx = makeCtx();
    const [note, ...rest] = mapComments(ctx, matter, [comment()], 'Alex Rivers');
    expect(rest).toEqual([]);
    expect(note?.legacyPath).toBe(path);
    expect(note?.path).toBe(`orgs/org1/matters/${matter.matterId}/notes/${migId(path)}`);
    expect(note?.data).toMatchObject({
      bodyMd: 'Called the client.',
      pinned: false,
      source: 'migration',
      createdAt: new Date('2025-01-12T05:00:00.000Z'),
      updatedAt: new Date('2025-01-12T05:00:00.000Z'),
      createdBy: UID,
      updatedBy: UID,
    });
    expect(note?.data).not.toHaveProperty('legacyAuthor');
    expect(note?.data).not.toHaveProperty('editedAt');
    expect(domain.NoteSchema.parse(note?.data)).toEqual(note?.data);
    expect(warned(ctx)).toEqual({});
  });

  it("names a non-member author in legacyAuthor and writes the note as the migration's", () => {
    const ctx = makeCtx();
    const html = `<p>Spoke to the client, ${mention(DEPARTED, 'Former Staffer')} has the file.</p>`;
    const [note] = mapComments(ctx, matter, [comment({ uid: COLLEAGUE, comment: html })], 'Alex Rivers');
    expect(note?.data).toMatchObject({
      bodyMd: 'Spoke to the client, @Former Staffer (imported) has the file.',
      mentions: { uids: [], matterIds: [] },
      legacyAuthor: 'Jordan Ellis',
      createdBy: 'migration',
      updatedBy: 'migration',
    });
    expect(domain.NoteSchema.parse(note?.data)).toEqual(note?.data);
  });

  it('names an author with no profile (or an unknown uid) "A former colleague"', () => {
    const notes = mapComments(
      makeCtx(),
      matter,
      [comment({ id: 'a', uid: DEPARTED }), comment({ id: 'b', uid: STRANGER }), comment({ id: 'c', uid: undefined })],
      'Alex Rivers',
    );
    expect(notes.map((note) => note.data?.['legacyAuthor'])).toEqual([
      'A former colleague',
      'A former colleague',
      'A former colleague',
    ]);
  });

  it("uses the subject's own name when the subject is not a member of the target org", () => {
    const ctx = makeCtx({ members: new Set() });
    const [note] = mapComments(ctx, matter, [comment()], 'Alex Rivers');
    expect(note?.data).toMatchObject({ legacyAuthor: 'Alex Rivers', createdBy: 'migration' });
  });

  it("keeps a member's mentions as mentions", () => {
    const html = `<p>Over to ${mention(UID, 'Alex Rivers')}</p>`;
    const [note] = mapComments(makeCtx(), matter, [comment({ uid: COLLEAGUE, comment: html })], 'Alex Rivers');
    expect(note?.data).toMatchObject({ bodyMd: `Over to @[${UID}]`, mentions: { uids: [UID], matterIds: [] } });
  });

  it('keeps plain text comments', () => {
    const [note] = mapComments(makeCtx(), matter, [comment({ comment: 'Plain text comment' })], 'Alex Rivers');
    expect(note?.data?.['bodyMd']).toBe('Plain text comment');
  });

  it.each(['<p><br></p>', '', '   ', null, '<script>alert(1)</script>'])(
    'makes no note for an empty comment (%j)',
    (html) => {
      expect(mapComments(makeCtx(), matter, [comment({ comment: html })], 'Alex Rivers')).toEqual([]);
    },
  );

  it('carries edited and editDate over as editedAt, and the edit as the update', () => {
    const ctx = makeCtx();
    const [note] = mapComments(
      ctx,
      matter,
      [comment({ uid: COLLEAGUE, edited: true, editDate: '2025-01-12T06:00:00.000Z' })],
      'Alex Rivers',
    );
    expect(note?.data).toMatchObject({
      createdAt: new Date('2025-01-12T05:00:00.000Z'),
      updatedAt: new Date('2025-01-12T06:00:00.000Z'),
      editedAt: new Date('2025-01-12T06:00:00.000Z'),
      editedBy: 'migration',
    });
    expect(domain.NoteSchema.parse(note?.data)).toEqual(note?.data);
    expect(warned(ctx)).toEqual({});
  });

  it('never moves the update before the creation for an edit dated earlier', () => {
    const [note] = mapComments(
      makeCtx(),
      matter,
      [comment({ edited: true, editDate: '2025-01-01T00:00:00.000Z' })],
      'Alex Rivers',
    );
    expect(note?.data).toMatchObject({
      createdAt: new Date('2025-01-12T05:00:00.000Z'),
      updatedAt: new Date('2025-01-12T05:00:00.000Z'),
      editedAt: new Date('2025-01-01T00:00:00.000Z'),
    });
  });

  it('ignores editDate unless edited is true', () => {
    const [note] = mapComments(
      makeCtx(),
      matter,
      [comment({ edited: false, editDate: '2025-01-12T06:00:00.000Z' })],
      'Alex Rivers',
    );
    expect(note?.data).not.toHaveProperty('editedAt');
  });

  it('leaves out an edit date that is missing or invalid, warning for the invalid one', () => {
    const ctx = makeCtx();
    const [missing, invalid] = mapComments(
      ctx,
      matter,
      [comment({ id: 'a', edited: true, editDate: null }), comment({ id: 'b', edited: true, editDate: 'yesterday' })],
      'Alex Rivers',
    );
    expect(missing?.data).not.toHaveProperty('editedAt');
    expect(invalid?.data).not.toHaveProperty('editedAt');
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [`${CARD}#comment/b`] });
  });

  it('dates a comment with an invalid date at the export time, with a warning', () => {
    const ctx = makeCtx();
    const [note] = mapComments(ctx, matter, [comment({ date: '2025-02-30T00:00:00.000Z' })], 'Alex Rivers');
    expect(note?.data).toMatchObject({ createdAt: AS_OF, updatedAt: AS_OF });
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [path] });
  });

  it('reads a Firestore Timestamp date', () => {
    const [note] = mapComments(
      makeCtx(),
      matter,
      [comment({ date: { $timestamp: '2025-01-12T05:00:00.123456Z' } })],
      'Alex Rivers',
    );
    expect(note?.data?.['createdAt']).toEqual(new Date('2025-01-12T05:00:00.123Z'));
  });

  it("keys a comment without an id by its index, and skips entries that aren't objects", () => {
    const notes = mapComments(
      makeCtx(),
      matter,
      [null, 'text', comment({ id: undefined }), comment({ id: '' })],
      'Alex Rivers',
    );
    expect(notes.map((note) => note.legacyPath)).toEqual([`${CARD}#comment/2`, `${CARD}#comment/3`]);
  });

  it.each([undefined, null, {}, 'comments'])('makes nothing of comments that are not a list (%j)', (comments) => {
    expect(mapComments(makeCtx(), matter, comments, 'Alex Rivers')).toEqual([]);
  });

  it('records rich text warnings against the comment', () => {
    const ctx = makeCtx();
    mapComments(ctx, matter, [comment({ comment: '<p>Hi<script>x()</script></p>' })], 'Alex Rivers');
    expect(warned(ctx)).toEqual({ MIG_W_HTML_UNSAFE_REMOVED: [path] });
  });
});
