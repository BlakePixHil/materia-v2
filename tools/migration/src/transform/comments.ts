import { domain } from '../domain.ts';
import {
  cutAt,
  fit,
  MIGRATION_ACTOR,
  migratedMeta,
  migId,
  type TransformContext,
  type TransformedRecord,
} from './context.ts';
import { instantOr, optionalInstant } from './dates.ts';
import { escapeText, htmlToMarkdown, type HtmlOptions, type InlineImage } from './html.ts';
import { arr, obj, str } from '../legacy/snapshot.ts';

const { NOTE_BODY_MAX, parseMentions } = domain;

/**
 * Card comments → matter notes (`source: 'migration'`, CORE-13), and the note builder the card's
 * own notes use (its description, the original assignee, the fee). A comment's author is a uid
 * when they are a member (the user), else `legacyAuthor` with their name. `edited`/`editDate`
 * carry over as `editedAt`.
 */

export interface MatterRef {
  orgId: string;
  matterId: string;
  /** The card's legacy path. */
  cardPath: string;
  /** The card's dates, for records that have none of their own. */
  createdAt: Date;
  updatedAt: Date;
}

export interface NoteInput {
  legacyPath: string;
  bodyMd: string;
  pinned?: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** The author's uid when they are a member; otherwise their name goes in `legacyAuthor`. */
  authorUid?: string;
  legacyAuthor?: string;
  editedAt?: Date;
}

export function buildNote(ctx: TransformContext, matter: MatterRef, input: NoteInput): TransformedRecord {
  const id = migId(input.legacyPath);
  let bodyMd = input.bodyMd;
  if (bodyMd.length > NOTE_BODY_MAX) {
    ctx.warnings.add('MIG_W_NOTE_TRUNCATED', input.legacyPath);
    bodyMd = cutAt(bodyMd, NOTE_BODY_MAX);
    // Never half a mention: a cut `@[uid` would read as text, and a cut uid as someone else.
    const open = /[@#]\[[^\]\s]*$/.exec(bodyMd);
    if (open) bodyMd = bodyMd.slice(0, open.index);
  }
  const by = input.authorUid ?? MIGRATION_ACTOR;
  return {
    entity: 'notes',
    path: `orgs/${matter.orgId}/matters/${matter.matterId}/notes/${id}`,
    legacyPath: input.legacyPath,
    data: {
      bodyMd,
      mentions: parseMentions(bodyMd),
      pinned: input.pinned ?? false,
      privileged: false,
      source: 'migration',
      ...(input.editedAt ? { editedAt: input.editedAt, editedBy: by } : {}),
      ...(input.legacyAuthor ? { legacyAuthor: fit(ctx, input.legacyAuthor, 200, input.legacyPath) } : {}),
      deletedAt: null,
      ...migratedMeta(ctx, {
        legacyPath: input.legacyPath,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        by,
      }),
    },
  };
}

/**
 * How rich text names people: `@[uid]` for a member, `@Name (imported)` as plain text for anyone
 * else (the name the mention showed, else their profile name).
 */
export function mentionText(ctx: TransformContext, uid: string, shown: string): string {
  if (ctx.members.has(uid)) return domain.memberMentionToken(uid);
  const name = shown || ctx.people.get(uid) || 'a former colleague';
  return `@${escapeText(name)} (imported)`;
}

/** Rich text to Markdown with the warnings it raises recorded against `legacyPath`. */
export function richText(
  ctx: TransformContext,
  html: unknown,
  legacyPath: string,
  imageText: HtmlOptions['imageText'] = () => '',
): { markdown: string; images: InlineImage[] } {
  if (typeof html !== 'string' || !html.trim()) return { markdown: '', images: [] };
  const result = htmlToMarkdown(html, { mention: (uid, shown) => mentionText(ctx, uid, shown), imageText });
  if (result.unsafeRemoved) ctx.warnings.add('MIG_W_HTML_UNSAFE_REMOVED', legacyPath);
  if (result.remoteImages) ctx.warnings.add('MIG_W_REMOTE_IMAGE_DROPPED', legacyPath);
  return { markdown: result.markdown, images: result.images };
}

export function mapComments(
  ctx: TransformContext,
  matter: MatterRef,
  comments: unknown,
  subjectName: string,
): TransformedRecord[] {
  const notes: TransformedRecord[] = [];
  arr(comments).forEach((raw, index) => {
    const comment = obj(raw);
    if (!comment) return;
    const legacyPath = `${matter.cardPath}#comment/${str(comment['id']) || index}`;
    const { markdown } = richText(ctx, comment['comment'], legacyPath);
    // An empty comment (Quill's `<p><br></p>`) makes no note.
    if (!markdown) return;
    const author = str(comment['uid']) ?? '';
    const member = ctx.members.has(author);
    const createdAt = instantOr(ctx, comment['date'], legacyPath);
    const editedAt = comment['edited'] === true ? optionalInstant(ctx, comment['editDate'], legacyPath) : undefined;
    const name = author === ctx.uid ? subjectName : ctx.people.get(author);
    notes.push(
      buildNote(ctx, matter, {
        legacyPath,
        bodyMd: markdown,
        createdAt,
        updatedAt: editedAt && editedAt > createdAt ? editedAt : createdAt,
        ...(member ? { authorUid: author } : { legacyAuthor: name || 'A former colleague' }),
        ...(editedAt ? { editedAt } : {}),
      }),
    );
  });
  return notes;
}
