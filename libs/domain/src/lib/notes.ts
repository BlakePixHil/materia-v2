import { z } from 'zod';

import { DocIdSchema } from './schemas/common';
import { NOTE_BODY_MAX } from './schemas/matter-records';

/**
 * Matter notes (CORE-13, ADR-032): Markdown file notes with `@[uid]` member and `#[matterId]` matter
 * mentions, pinning, append-only revisions and the `notes-*` callables. Notes are created and their
 * text edited only through the callables (which parse mentions, keep revisions and notify the newly
 * mentioned); clients pin, delete and restore directly under the rules.
 */

// ---------- mentions ----------

/** Characters allowed inside a mention token: a Firestore id without `/`, `[` or `]`. */
const TOKEN_ID = '[^\\]\\[/\\s]{1,128}';
/** `@[uid]` or `#[matterId]`; group 1 is the sigil, group 2 the id. */
export const MENTION_TOKEN = new RegExp(`([@#])\\[(${TOKEN_ID})\\]`, 'g');

export const memberMentionToken = (uid: string) => `@[${uid}]`;
export const matterMentionToken = (matterId: string) => `#[${matterId}]`;

export interface NoteMentions {
  uids: string[];
  matterIds: string[];
}

/**
 * The members and matters a note's Markdown mentions, each once in order of first use. Tokens
 * inside code (`` `@[x]` `` or a fenced block) are text, not mentions.
 */
export function parseMentions(bodyMd: string): NoteMentions {
  const uids: string[] = [];
  const matterIds: string[] = [];
  for (const segment of outsideCode(bodyMd)) {
    for (const match of segment.matchAll(MENTION_TOKEN)) {
      const list = match[1] === '@' ? uids : matterIds;
      const id = match[2] as string;
      if (!list.includes(id)) list.push(id);
    }
  }
  return { uids, matterIds };
}

/** The parts of the Markdown outside fenced blocks and inline code spans. */
function outsideCode(src: string): string[] {
  const parts: string[] = [];
  let fence: string | null = null;
  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (fence) {
      if (marker === fence) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    parts.push(...line.split(/`[^`]*`/));
  }
  return parts;
}

/** Uids mentioned in `after` that `before` didn't mention: the ones to notify. */
export function newlyMentioned(before: readonly string[], after: readonly string[]): string[] {
  const seen = new Set(before);
  return after.filter((uid) => !seen.has(uid));
}

/** How a migrated note's author who isn't a member is shown. */
export const importedAuthorLabel = (name: string) => `${name} (imported)`;
/** How a mention of a matter the reader can't open is shown. */
export const RESTRICTED_MATTER_LABEL = 'Restricted matter';

// ---------- callables ----------

const RequestId = z.uuid();
const BodyMd = z
  .string()
  .max(NOTE_BODY_MAX, { message: `A note can be at most ${NOTE_BODY_MAX / 1000} KB` })
  .refine((text) => text.trim().length > 0, { message: 'Write something first' });

/** The `notes-*` callables, as deployed. */
export const NOTE_CALLABLES = {
  create: 'notes-create',
  update: 'notes-update',
} as const;

/**
 * `notes-create` (`note.write`, idempotent): adds a note to a live matter. `privileged` (lawyers and
 * above) marks it privileged; a note on a privileged matter is always privileged. Newly mentioned
 * members get a `mention` notification, except those who can't open a privileged note or matter
 * (returned as `unreachable`).
 */
export const CreateNoteInput = z.strictObject({
  requestId: RequestId,
  matterId: DocIdSchema,
  bodyMd: BodyMd,
  pinned: z.boolean().default(false),
  privileged: z.boolean().default(false),
});
export type CreateNoteInput = z.input<typeof CreateNoteInput>;

/**
 * `notes-update` (`note.write`, idempotent): replaces a note's text (and, for lawyers and above, its
 * privileged flag). The previous version is kept in `notes/{id}/revisions`. `expectedUpdatedAt` is
 * the `updatedAt` the editor started from: if the note changed since, the call fails with
 * FAILED_PRECONDITION `note_conflict` unless `overwrite` is set. Only members mentioned for the
 * first time are notified.
 */
export const UpdateNoteInput = z.strictObject({
  requestId: RequestId,
  matterId: DocIdSchema,
  noteId: DocIdSchema,
  bodyMd: BodyMd,
  privileged: z.boolean().optional(),
  /** ISO 8601. */
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
  overwrite: z.boolean().default(false),
});
export type UpdateNoteInput = z.input<typeof UpdateNoteInput>;

export interface SaveNoteResult {
  noteId: string;
  /** ISO 8601: the editor's next `expectedUpdatedAt`. */
  updatedAt: string;
  /** Members notified by this save. */
  notified: string[];
  /** Mentioned members who can't open the note (privileged), so weren't notified. */
  unreachable: string[];
}
