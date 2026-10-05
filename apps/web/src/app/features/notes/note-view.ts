import type { MatterActivity, NoteItem, WithId } from '@materia/data-access/repository';
import {
  can,
  DomainError,
  importedAuthorLabel,
  matterMentionToken,
  memberMentionToken,
  NOTE_BODY_MAX,
  parseMentions,
  type Role,
} from '@materia/domain';
import type { TimelineItemVm, TimelineKind } from '@materia/ui/timeline';

import { errorCodeOf, errorCopy } from '../../core/error-copy';

/**
 * Matter notes (CORE-13): what the editor and the lists compute from text and records, kept pure so
 * it's tested without rendering.
 */

export type NoteRecord = WithId<NoteItem>;

/** A member as the editor offers and checks them. */
export interface NoteMember {
  uid: string;
  name: string;
  role: Role;
  status: string;
}

/** A matter as `#` offers it. */
export interface MatterOption {
  id: string;
  number: string;
  title: string;
}

/** How many suggestions the `@`/`#` list shows. */
export const MENTION_SUGGESTIONS = 8;
/** `#` searches matters once this many characters are typed. */
export const MATTER_QUERY_MIN = 2;

// ---------- mentions while typing ----------

/** The `@name` or `#matter` being typed at the caret: the sigil, what follows it, and where it starts. */
export interface MentionQuery {
  sigil: '@' | '#';
  query: string;
  /** Index of the sigil. */
  start: number;
  /** The caret (the query's end). */
  end: number;
}

/**
 * The mention being typed before the caret: `@` or `#` at the start of a line or after a space or
 * `(`, then up to 30 characters on the same line (spaces allowed, so "@priya sh" still matches).
 * Completed tokens (`@[…]`) and Markdown headings (`# `) don't count.
 */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const match = /(^|[\s(])([@#])([^\n@#[\]]{0,30})$/.exec(before);
  if (!match) return null;
  const sigil = match[2] as '@' | '#';
  const query = match[3] ?? '';
  // `# Heading` at the start of a line is Markdown, not a matter.
  if (sigil === '#' && query.startsWith(' ')) return null;
  if (/^\s|\s\s/.test(query)) return null;
  const start = caret - query.length - 1;
  return { sigil, query, start, end: caret };
}

/** Replaces the typed `@name`/`#matter` with a token and a space; the caret goes after the space. */
export function insertMention(text: string, at: MentionQuery, token: string): { text: string; caret: number } {
  const after = text.slice(at.end);
  const inserted = `${token}${after.startsWith(' ') ? '' : ' '}`;
  return { text: text.slice(0, at.start) + inserted + after, caret: at.start + inserted.length };
}

export const memberToken = memberMentionToken;
export const matterToken = matterMentionToken;

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Active members whose name (or a word of it) starts with what was typed, at most eight. */
export function matchMembers(members: readonly NoteMember[], query: string): NoteMember[] {
  const typed = fold(query.trim());
  return members
    .filter((member) => member.status === 'active')
    .filter((member) => {
      if (!typed) return true;
      const name = fold(member.name);
      return name.startsWith(typed) || name.split(/\s+/).some((word) => word.startsWith(typed));
    })
    .slice(0, MENTION_SUGGESTIONS);
}

/**
 * Members a note mentions who can't open it: when it's privileged, those whose role lacks
 * privileged.view. They aren't notified (the server returns them as `unreachable` too).
 */
export function unreachableMentions(bodyMd: string, privileged: boolean, members: readonly NoteMember[]): NoteMember[] {
  if (!privileged) return [];
  const byUid = new Map(members.map((member) => [member.uid, member]));
  return parseMentions(bodyMd)
    .uids.map((uid) => byUid.get(uid))
    .filter((member): member is NoteMember => !!member && !can(member.role, 'privileged.view'));
}

/** "Daniel Kim", "Daniel Kim and Sam Lee", "Daniel Kim, Sam Lee and Alex Fictional". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ---------- editing ----------

/** The text after an edit, with the selection to restore. */
export interface TextEdit {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

export type NoteFormat = 'bold' | 'italic' | 'list' | 'link';

/**
 * A toolbar action on the selection: wrap it in `**`/`*`, start each selected line with `- `, or
 * make it a link's text (`[text](https://)`, the URL selected to type over). With nothing selected,
 * the markers go in with the caret between them.
 */
export function applyFormat(text: string, start: number, end: number, format: NoteFormat): TextEdit {
  const selected = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (format === 'bold' || format === 'italic') {
    const marker = format === 'bold' ? '**' : '*';
    const next = `${before}${marker}${selected}${marker}${after}`;
    return { text: next, selectionStart: start + marker.length, selectionEnd: end + marker.length };
  }
  if (format === 'link') {
    const label = selected || 'link text';
    const url = 'https://';
    const next = `${before}[${label}](${url})${after}`;
    const urlStart = start + label.length + 3;
    return { text: next, selectionStart: urlStart, selectionEnd: urlStart + url.length };
  }
  // A list: from the start of the first selected line to the end of the last.
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lines = text.slice(lineStart, end).split('\n');
  const listed = lines.map((line) => (/^\s*[-*+]\s/.test(line) ? line : `- ${line}`)).join('\n');
  const next = text.slice(0, lineStart) + listed + after;
  const grown = listed.length - (end - lineStart);
  return { text: next, selectionStart: start === end ? end + grown : lineStart, selectionEnd: end + grown };
}

/** Inserts plain text over the selection (pasting), the caret after it. */
export function insertText(text: string, start: number, end: number, inserted: string): TextEdit {
  const caret = start + inserted.length;
  return { text: text.slice(0, start) + inserted + text.slice(end), selectionStart: caret, selectionEnd: caret };
}

/** What a paste puts in a note: the clipboard's plain text only (never its HTML), with CRLF as LF. */
export function pastedText(data: Pick<DataTransfer, 'getData'> | null | undefined): string {
  return (data?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
}

/** "0.2 KB", "12 KB": a note's size against the 100 KB limit (`NOTE_BODY_MAX` characters). */
export function noteSize(length: number): string {
  const kb = length / 1000;
  return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
}

export const NOTE_LIMIT_TEXT = `${NOTE_BODY_MAX / 1000} KB`;

export function tooLong(text: string): boolean {
  return text.length > NOTE_BODY_MAX;
}

// ---------- lists ----------

/** Who wrote a note: a migrated note's author by name ("Alex Fictional (imported)"), else the member. */
export function noteAuthor(
  note: Pick<NoteItem, 'legacyAuthor' | 'createdBy'>,
  memberName: (uid: string) => string,
): string {
  return note.legacyAuthor ? importedAuthorLabel(note.legacyAuthor) : memberName(note.createdBy);
}

/** The member ids and matter ids mentioned across some notes' text, each once. */
export function mentionsAcross(bodies: readonly string[]): { uids: string[]; matterIds: string[] } {
  const uids = new Set<string>();
  const matterIds = new Set<string>();
  for (const body of bodies) {
    const found = parseMentions(body);
    found.uids.forEach((uid) => uids.add(uid));
    found.matterIds.forEach((id) => matterIds.add(id));
  }
  return { uids: [...uids], matterIds: [...matterIds] };
}

// ---------- activity ----------

/**
 * An activity line with its actor in front of the actor-less summary: "Priya Shah added a note",
 * "Clerk drafted …". Lines the system wrote (`system`) read as the summary alone.
 */
export function activityTitle(actorUid: string, summary: string, memberName: (uid: string) => string): string {
  const trimmed = summary.trim();
  if (actorUid === 'system') return trimmed;
  const name = actorUid === 'clerk' ? 'Clerk' : memberName(actorUid);
  if (!trimmed) return name;
  // "Added a note" → "added a note"; an acronym ("PDF …") or a name keeps its capitals.
  const first = /^[A-Z][a-z]/.test(trimmed) ? trimmed.charAt(0).toLowerCase() : trimmed.charAt(0);
  return `${name} ${first}${trimmed.slice(1)}`;
}

/** The timeline node for an activity kind (`note.created` → note, `deadline.done` → deadline). */
export function activityKind(kind: string): TimelineKind {
  const group = kind.split(/[._]/)[0];
  if (group === 'note' || group === 'notes') return 'note';
  if (group === 'document' || group === 'documents') return 'document';
  if (group === 'deadline' || group === 'deadlines') return 'deadline';
  if (group === 'email') return 'email';
  if (group === 'clerk' || group === 'suggestion') return 'clerk';
  return 'activity';
}

/** An activity item on the Activity tab's timeline. */
export function activityItem(entry: WithId<MatterActivity>, memberName: (uid: string) => string): TimelineItemVm {
  return {
    id: entry.id,
    kind: activityKind(entry.kind),
    title: activityTitle(entry.actorUid, entry.summary, memberName),
    at: entry.at,
  };
}

// ---------- errors ----------

/**
 * What a failed `notes-create`/`notes-update` says (CORE-13): a refused privileged flag, a note or
 * matter that's gone (deleted, or hidden from the reader), and the field message for a body the
 * server refused. The draft is always kept; the copy says so where it matters.
 */
export function noteErrorCopy(error: unknown, action: 'create' | 'edit'): string {
  const details = error instanceof DomainError ? error.details : undefined;
  const code = errorCodeOf(error);
  if (code === 'PERMISSION_DENIED' && details?.['reason'] === 'privileged_requires_lawyer') {
    return 'Only lawyers can mark notes privileged. Untick Privileged to save it.';
  }
  if (code === 'NOT_FOUND') {
    return action === 'edit'
      ? 'This note was deleted, or you can no longer open it. Your draft is still in the editor; copy it before closing.'
      : 'This matter was deleted, or you can no longer open it. Your draft is still in the editor.';
  }
  if (code === 'INVALID_ARGUMENT') {
    const message = details?.fields?.['bodyMd']?.[0] ?? Object.values(details?.fields ?? {})[0]?.[0];
    if (message) return message;
  }
  return errorCopy(error);
}

/** "Priya Shah’s version", or "your saved version" when the reader changed it last (a conflict's other side). */
export function versionOf(by: string): string {
  return by === 'You' ? 'your saved version' : `${by}’s version`;
}
