import { DomainError } from '@materia/domain';

import {
  activityItem,
  activityKind,
  activityTitle,
  applyFormat,
  insertMention,
  insertText,
  matchMembers,
  mentionAt,
  mentionsAcross,
  nameList,
  noteAuthor,
  noteErrorCopy,
  noteSize,
  pastedText,
  tooLong,
  unreachableMentions,
  versionOf,
  type MentionQuery,
  type NoteMember,
} from './note-view';

/** The notes feature's pure helpers (CORE-13). Fictional data only. */

const MEMBERS: NoteMember[] = [
  { uid: 'u-priya', name: 'Priya Shah', role: 'owner', status: 'active' },
  { uid: 'u-jordan', name: 'Jordan Price', role: 'lawyer', status: 'active' },
  { uid: 'u-daniel', name: 'Daniel Kim', role: 'paralegal', status: 'active' },
  { uid: 'u-sam', name: 'Sam Lee', role: 'readonly', status: 'active' },
  { uid: 'u-zoe', name: 'Zoë Fictional', role: 'lawyer', status: 'suspended' },
];

describe('mentionAt', () => {
  it('finds the @ or # being typed at the caret', () => {
    expect(mentionAt('Call @pri', 9)).toEqual({ sigil: '@', query: 'pri', start: 5, end: 9 });
    expect(mentionAt('@', 1)).toEqual({ sigil: '@', query: '', start: 0, end: 1 });
    expect(mentionAt('See #M-2026', 11)).toEqual({ sigil: '#', query: 'M-2026', start: 4, end: 11 });
    expect(mentionAt('(#estate of', 11)).toEqual({ sigil: '#', query: 'estate of', start: 1, end: 11 });
    expect(mentionAt('Line\n@da', 8)).toEqual({ sigil: '@', query: 'da', start: 5, end: 8 });
  });

  it('ignores emails, headings, finished tokens and other lines', () => {
    expect(mentionAt('avery@example', 13)).toBeNull();
    expect(mentionAt('# Heading', 9)).toBeNull();
    expect(mentionAt('@[u-priya] ', 11)).toBeNull();
    expect(mentionAt('@pri\nnext', 9)).toBeNull();
    expect(mentionAt('@two  spaces', 12)).toBeNull();
    expect(mentionAt('Call @pri later', 4)).toBeNull();
  });
});

describe('editing helpers', () => {
  it('inserts a mention token with one trailing space', () => {
    const at = mentionAt('Call @pri', 9) as MentionQuery;
    expect(insertMention('Call @pri', at, '@[u-priya]')).toEqual({ text: 'Call @[u-priya] ', caret: 16 });
    const middle = mentionAt('Call @pri today', 9) as MentionQuery;
    expect(insertMention('Call @pri today', middle, '@[u-priya]')).toEqual({
      text: 'Call @[u-priya] today',
      caret: 15,
    });
  });

  it('formats the selection', () => {
    expect(applyFormat('a will b', 2, 6, 'bold')).toEqual({ text: 'a **will** b', selectionStart: 4, selectionEnd: 8 });
    expect(applyFormat('ab', 1, 1, 'italic')).toEqual({ text: 'a**b', selectionStart: 2, selectionEnd: 2 });
    expect(applyFormat('see the Act', 4, 11, 'link')).toEqual({
      text: 'see [the Act](https://)',
      selectionStart: 14,
      selectionEnd: 22,
    });
    expect(applyFormat('', 0, 0, 'link').text).toBe('[link text](https://)');
    expect(applyFormat('one\ntwo\n- three', 0, 15, 'list')).toEqual({
      text: '- one\n- two\n- three',
      selectionStart: 0,
      selectionEnd: 19,
    });
    expect(applyFormat('intro\nitem', 10, 10, 'list')).toEqual({
      text: 'intro\n- item',
      selectionStart: 12,
      selectionEnd: 12,
    });
  });

  it('pastes plain text only', () => {
    const clipboard = {
      getData: (type: string) => (type === 'text/plain' ? 'line one\r\nline two' : '<b>line one</b><script>x</script>'),
    };
    expect(pastedText(clipboard)).toBe('line one\nline two');
    expect(pastedText(null)).toBe('');
    expect(insertText('ab', 1, 1, 'XY')).toEqual({ text: 'aXYb', selectionStart: 3, selectionEnd: 3 });
  });

  it('measures the note against 100 KB', () => {
    expect(noteSize(120)).toBe('0.1 KB');
    expect(noteSize(12_400)).toBe('12 KB');
    expect(tooLong('x'.repeat(100_000))).toBe(false);
    expect(tooLong('x'.repeat(100_001))).toBe(true);
  });
});

describe('members', () => {
  it('suggests active members by a word of their name', () => {
    expect(matchMembers(MEMBERS, 'pri').map((m) => m.name)).toEqual(['Priya Shah', 'Jordan Price']);
    expect(matchMembers(MEMBERS, 'kim').map((m) => m.name)).toEqual(['Daniel Kim']);
    expect(matchMembers(MEMBERS, 'zoe')).toEqual([]);
    expect(matchMembers(MEMBERS, '')).toHaveLength(4);
  });

  it('finds mentions who can’t open a privileged note', () => {
    const body = 'For @[u-daniel], @[u-sam] and @[u-priya]';
    expect(unreachableMentions(body, false, MEMBERS)).toEqual([]);
    expect(unreachableMentions(body, true, MEMBERS).map((m) => m.name)).toEqual(['Daniel Kim', 'Sam Lee']);
    expect(nameList(['Daniel Kim'])).toBe('Daniel Kim');
    expect(nameList(['Daniel Kim', 'Sam Lee', 'Zoë Fictional'])).toBe('Daniel Kim, Sam Lee and Zoë Fictional');
  });

  it('names a note’s author, imported ones by their legacy name', () => {
    const name = (uid: string) => (uid === 'u-priya' ? 'Priya Shah' : 'Former member');
    expect(noteAuthor({ createdBy: 'u-priya' }, name)).toBe('Priya Shah');
    expect(noteAuthor({ createdBy: 'migration', legacyAuthor: 'Morgan Fictional' }, name)).toBe(
      'Morgan Fictional (imported)',
    );
    expect(mentionsAcross(['@[a] #[m-1]', '#[m-1] #[m-2] `#[m-3]`'])).toEqual({
      uids: ['a'],
      matterIds: ['m-1', 'm-2'],
    });
  });
});

describe('activity', () => {
  const name = (uid: string) => (uid === 'u-priya' ? 'Priya Shah' : 'Former member');

  it('puts the actor in front of the summary', () => {
    expect(activityTitle('u-priya', 'Added a note', name)).toBe('Priya Shah added a note');
    expect(activityTitle('u-priya', 'PDF uploaded', name)).toBe('Priya Shah PDF uploaded');
    expect(activityTitle('system', 'Opened the matter', name)).toBe('Opened the matter');
    expect(activityTitle('clerk', 'Drafted a letter', name)).toBe('Clerk drafted a letter');
  });

  it('maps kinds to timeline nodes', () => {
    expect(activityKind('note.created')).toBe('note');
    expect(activityKind('notes.soft_delete')).toBe('note');
    expect(activityKind('document.uploaded')).toBe('document');
    expect(activityKind('deadline.done')).toBe('deadline');
    expect(activityKind('task.created')).toBe('activity');
    const at = new Date('2026-10-04T01:00:00Z');
    expect(
      activityItem(
        { id: 'a1', kind: 'note.created', summary: 'Added a note', actorUid: 'u-priya', at, refs: {} },
        name,
      ),
    ).toEqual({ id: 'a1', kind: 'note', title: 'Priya Shah added a note', at });
  });
});

describe('save errors', () => {
  it('names a refused privileged flag, a note or matter that’s gone, and a refused body', () => {
    const denied = new DomainError('PERMISSION_DENIED', 'x', { reason: 'privileged_requires_lawyer' });
    expect(noteErrorCopy(denied, 'create')).toBe(
      'Only lawyers can mark notes privileged. Untick Privileged to save it.',
    );
    expect(noteErrorCopy(new DomainError('NOT_FOUND'), 'edit')).toContain(
      'This note was deleted, or you can no longer open it',
    );
    expect(noteErrorCopy(new DomainError('NOT_FOUND'), 'create')).toContain('This matter was deleted');
    const invalid = new DomainError('INVALID_ARGUMENT', 'x', { fields: { bodyMd: ['Write something first'] } });
    expect(noteErrorCopy(invalid, 'create')).toBe('Write something first');
    expect(noteErrorCopy(new DomainError('INVALID_ARGUMENT'), 'create')).toBe(
      'Some details need fixing. Check the highlighted fields.',
    );
    expect(noteErrorCopy(new DomainError('PERMISSION_DENIED'), 'edit')).toContain('Your role can’t do this');
  });

  it('names the other side of a conflict', () => {
    expect(versionOf('Priya Shah')).toBe('Priya Shah’s version');
    expect(versionOf('You')).toBe('your saved version');
  });
});
