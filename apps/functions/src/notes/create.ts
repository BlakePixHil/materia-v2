import type * as z from 'zod';

import { can, CreateNoteInput, Note, parseMentions, PERMISSIONS, type SaveNoteResult } from '@materia/domain';

import { assertMayMarkPrivileged, notesPath, noteMentions, notifyMentions, readPeople } from './shared';
import { audit } from '../audit/audit';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableContext, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import type { TxJoin } from '../core/tx-join';
import { archivedError, liveMatter, matterPath } from '../matters/shared';

/**
 * `notes-create` (CORE-13, `note.write`, idempotent). Adds a note to a live matter the caller can
 * see, in one transaction: the mentions are parsed from the Markdown (member mentions of anyone who
 * isn't an active member are dropped), the note is written, and each mentioned member (not the
 * author) gets a `mention` notification. `privileged` needs `privileged.view` (PERMISSION_DENIED,
 * `details.reason: 'privileged_requires_lawyer'`); a note on a privileged matter is always
 * privileged, and members who can't open it are returned as `unreachable` instead of notified.
 * Audited as `note.created` (no note text). An archived matter (CORE-19) is read-only except for
 * notes added by a lawyer or above (`matter.close` roles), which the audit entry marks `archived`.
 */
export const createDefinition = {
  name: 'notes-create',
  input: CreateNoteInput,
  roles: PERMISSIONS['note.write'],
  idempotent: true,
  handler: (ctx): Promise<SaveNoteResult> => createNote(ctx),
} satisfies CallableDefinition<typeof CreateNoteInput, SaveNoteResult>;

export interface CreateNoteOptions {
  /** `clerk` for a note from an accepted Clerk suggestion (AI-07). */
  source?: 'manual' | 'clerk';
  /** Joins the caller's reads and writes to the note's transaction (AI-07). */
  join?: TxJoin;
}

/** The `notes-create` logic, shared with accepting a Clerk note suggestion. */
export async function createNote(
  ctx: CallableContext<z.output<typeof CreateNoteInput>>,
  options: CreateNoteOptions = {},
): Promise<SaveNoteResult> {
  const { input, orgId, uid, role, db, requestId, log } = ctx;
  if (input.privileged) assertMayMarkPrivileged(role);
  const clock = await orgClock(db, orgId, ctx.clock);
  const now = clock.now();
  const matterRef = db.doc(matterPath(orgId, input.matterId));
  const noteRef = db.collection(notesPath(orgId, input.matterId)).doc();
  const notifyCtx = { db, orgId, clock, log, ports: ctx.ports };

  const outcome = await db.runTransaction(async (tx) => {
    const matter = liveMatter(await tx.get(matterRef), role, input.matterId);
    // An archived matter (CORE-19) takes notes from lawyers and above only, audited as such.
    const archived = matter['status'] === 'archived';
    if (archived && !can(role, 'matter.close')) throw archivedError(input.matterId);
    await options.join?.read(tx);
    const privileged = input.privileged || matter['privileged'] === true;
    const people = await readPeople(tx, db, orgId, [uid, ...parseMentions(input.bodyMd).uids]);
    const mentions = noteMentions(input.bodyMd, people);
    tx.create(
      noteRef,
      Note.schema.parse({
        bodyMd: input.bodyMd,
        mentions,
        pinned: input.pinned,
        privileged,
        source: options.source ?? 'manual',
        deletedAt: null,
        createdAt: now,
        createdBy: uid,
        ...stamp(uid, now, requestId),
        schemaVersion: Note.version,
      }),
    );
    const sent = await notifyMentions(notifyCtx, {
      tx,
      orgId,
      matterId: input.matterId,
      noteId: noteRef.id,
      matter,
      author: uid,
      privileged,
      before: [],
      after: mentions.uids,
      people,
    });
    options.join?.write(tx, noteRef.path);
    return { ...sent, privileged, archived, mentioned: mentions.uids.length };
  });
  await outcome.dispatch();

  await audit(
    { uid, orgId, requestId, db, clock },
    {
      action: 'note.created',
      entity: { path: noteRef.path },
      summary: `Note ${noteRef.id} added to matter ${input.matterId}`,
      data: {
        privileged: outcome.privileged,
        pinned: input.pinned,
        ...(outcome.archived ? { archived: true } : {}),
        mentioned: outcome.mentioned,
        notified: outcome.notified.length,
      },
    },
  );
  log.info('note created', {
    matterId: input.matterId,
    noteId: noteRef.id,
    notified: outcome.notified.length,
    unreachable: outcome.unreachable.length,
  });
  return {
    noteId: noteRef.id,
    updatedAt: now.toISOString(),
    notified: outcome.notified,
    unreachable: outcome.unreachable,
  };
}

export const create = defineCallable(createDefinition);
