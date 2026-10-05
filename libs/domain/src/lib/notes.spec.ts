import {
  CreateNoteInput,
  importedAuthorLabel,
  matterMentionToken,
  memberMentionToken,
  MENTION_TOKEN,
  newlyMentioned,
  NOTE_CALLABLES,
  parseMentions,
  RESTRICTED_MATTER_LABEL,
  UpdateNoteInput,
} from './notes';
import { NOTE_BODY_MAX } from './schemas/matter-records';

/** Notes (CORE-13): mention parsing and the callables' inputs. Every name is fictional. */

const REQUEST = '6f1f8f0e-7b1a-4c55-9a1e-3d6f5a2b9c10';

describe('parseMentions', () => {
  it('finds member and matter mentions, each once, in order of first use', () => {
    expect(parseMentions('Ask @[user-b] and @[user-a] about #[m-2] and #[m-1]; cc @[user-b] #[m-2]')).toEqual({
      uids: ['user-b', 'user-a'],
      matterIds: ['m-2', 'm-1'],
    });
  });

  it('round-trips the token helpers', () => {
    const body = `${memberMentionToken('uid_1')} on ${matterMentionToken('matter-42')}`;
    expect(body).toBe('@[uid_1] on #[matter-42]');
    expect(parseMentions(body)).toEqual({ uids: ['uid_1'], matterIds: ['matter-42'] });
  });

  it('ignores tokens in inline code and fenced blocks', () => {
    const body = [
      'Real: @[user-a]',
      'Inline: `@[user-code]` and `#[m-code]`, then #[m-1]',
      '```',
      '@[user-fenced] #[m-fenced]',
      '```',
      '~~~md',
      '@[user-tilde]',
      '~~~',
      'After: @[user-b]',
    ].join('\n');
    expect(parseMentions(body)).toEqual({ uids: ['user-a', 'user-b'], matterIds: ['m-1'] });
  });

  it('treats an unclosed fence as code to the end, and handles CRLF', () => {
    expect(parseMentions('@[user-a]\r\n```\r\n@[user-b]\r\n')).toEqual({ uids: ['user-a'], matterIds: [] });
  });

  it('a ``` fence is not closed by ~~~', () => {
    expect(parseMentions('```\n~~~\n@[user-x]\n```\n@[user-y]')).toEqual({ uids: ['user-y'], matterIds: [] });
  });

  it('rejects malformed tokens: empty, spaces, slashes, brackets or over 128 characters', () => {
    const long = 'u'.repeat(129);
    const body = `@[] @[two words] @[a/b] @[a[b] @(user-a) @user-b [user-c] @[${long}] @[${'v'.repeat(128)}]`;
    expect(parseMentions(body)).toEqual({ uids: ['v'.repeat(128)], matterIds: [] });
  });

  it('finds tokens next to punctuation and Markdown', () => {
    expect(parseMentions('**@[user-a]**, (#[m-1]). _@[user-b]_')).toEqual({
      uids: ['user-a', 'user-b'],
      matterIds: ['m-1'],
    });
  });

  it('MENTION_TOKEN is global and captures the sigil and the id', () => {
    const matches = [...'@[a] #[b]'.matchAll(MENTION_TOKEN)].map((m) => [m[1], m[2]]);
    expect(matches).toEqual([
      ['@', 'a'],
      ['#', 'b'],
    ]);
  });

  it('nothing to find in plain text', () => {
    expect(parseMentions('Called the executor at 2pm. Email: someone@example.test')).toEqual({
      uids: [],
      matterIds: [],
    });
  });
});

describe('newlyMentioned', () => {
  it('lists only the uids the earlier version did not mention, in order', () => {
    expect(newlyMentioned(['user-a'], ['user-b', 'user-a', 'user-c'])).toEqual(['user-b', 'user-c']);
    expect(newlyMentioned([], ['user-a'])).toEqual(['user-a']);
    expect(newlyMentioned(['user-a', 'user-b'], ['user-a'])).toEqual([]);
  });
});

describe('note callables', () => {
  it('are deployed under the notes group', () => {
    expect(NOTE_CALLABLES).toEqual({ create: 'notes-create', update: 'notes-update' });
  });

  it('notes-create defaults to unpinned and not privileged', () => {
    expect(CreateNoteInput.parse({ requestId: REQUEST, matterId: 'm-1', bodyMd: 'File note' })).toEqual({
      requestId: REQUEST,
      matterId: 'm-1',
      bodyMd: 'File note',
      pinned: false,
      privileged: false,
    });
  });

  it('limits a note to 100 KB with a clear message, and refuses an empty one', () => {
    const tooLong = CreateNoteInput.safeParse({
      requestId: REQUEST,
      matterId: 'm-1',
      bodyMd: 'x'.repeat(NOTE_BODY_MAX + 1),
    });
    expect(tooLong.error?.issues[0]).toMatchObject({ path: ['bodyMd'], message: 'A note can be at most 100 KB' });
    expect(
      CreateNoteInput.safeParse({ requestId: REQUEST, matterId: 'm-1', bodyMd: 'x'.repeat(NOTE_BODY_MAX) }).success,
    ).toBe(true);
    const blank = CreateNoteInput.safeParse({ requestId: REQUEST, matterId: 'm-1', bodyMd: ' \n ' });
    expect(blank.error?.issues[0]).toMatchObject({ path: ['bodyMd'], message: 'Write something first' });
  });

  it('notes-create refuses unknown fields and a bad request id', () => {
    expect(CreateNoteInput.safeParse({ requestId: REQUEST, matterId: 'm-1', bodyMd: 'x', mentions: {} }).success).toBe(
      false,
    );
    expect(CreateNoteInput.safeParse({ requestId: 'nope', matterId: 'm-1', bodyMd: 'x' }).success).toBe(false);
    expect(CreateNoteInput.safeParse({ requestId: REQUEST, matterId: 'a/b', bodyMd: 'x' }).success).toBe(false);
  });

  it('notes-update needs an ISO expectedUpdatedAt with an offset, and defaults overwrite off', () => {
    const base = { requestId: REQUEST, matterId: 'm-1', noteId: 'n-1', bodyMd: 'Edited' };
    expect(UpdateNoteInput.parse({ ...base, expectedUpdatedAt: '2026-10-05T00:00:00.000Z' })).toEqual({
      ...base,
      expectedUpdatedAt: '2026-10-05T00:00:00.000Z',
      overwrite: false,
    });
    expect(UpdateNoteInput.safeParse({ ...base, expectedUpdatedAt: '2026-10-05T10:00:00+10:00' }).success).toBe(true);
    expect(UpdateNoteInput.safeParse({ ...base, expectedUpdatedAt: '2026-10-05' }).success).toBe(false);
    expect(UpdateNoteInput.safeParse(base).success).toBe(false);
    expect(
      UpdateNoteInput.parse({ ...base, expectedUpdatedAt: '2026-10-05T00:00:00Z', privileged: true, overwrite: true }),
    ).toMatchObject({ privileged: true, overwrite: true });
  });
});

describe('labels', () => {
  it('names an imported author and a restricted matter', () => {
    expect(importedAuthorLabel('Avery Fictional')).toBe('Avery Fictional (imported)');
    expect(RESTRICTED_MATTER_LABEL).toBe('Restricted matter');
  });
});
