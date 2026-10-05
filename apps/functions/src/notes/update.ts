import {
  DomainError,
  NoteRevision,
  parseMentions,
  PERMISSIONS,
  UpdateNoteInput,
  type SaveNoteResult,
} from '@materia/domain';

import {
  assertMayMarkPrivileged,
  liveNote,
  millis,
  notePath,
  noteMentions,
  notifyMentions,
  readPeople,
  toDate,
} from './shared';
import { audit } from '../audit/audit';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { liveMatter, matterPath } from '../matters/shared';

const iso = (value: unknown) => toDate(value)?.toISOString() ?? null;

/**
 * `notes-update` (CORE-13, `note.write`, idempotent). Replaces a note's text and, for roles with
 * `privileged.view`, its privileged flag (PERMISSION_DENIED otherwise; a note on a privileged
 * matter stays privileged). In one transaction:
 *
 * - a missing, deleted or hidden note, or one on a deleted matter, is NOT_FOUND;
 * - unchanged text and flag is a no-op (no revision, no write, no notification);
 * - if the note's `updatedAt` isn't `expectedUpdatedAt` (to the millisecond), someone saved it in
 *   the meantime: FAILED_PRECONDITION with `details: {reason: 'note_conflict', updatedAt,
 *   updatedBy}`, unless `overwrite` is set;
 * - the previous text is appended to `notes/{id}/revisions/{requestId}` (who wrote it and when),
 *   then the note gets the new text, mentions and flag, `editedAt`/`editedBy` and the stamp;
 * - members mentioned for the first time get a `mention` notification (see `notifyMentions`).
 *
 * Audited as `note.edited` (no note text).
 */
export const updateDefinition = {
  name: 'notes-update',
  input: UpdateNoteInput,
  roles: PERMISSIONS['note.write'],
  idempotent: true,
  handler: async (ctx): Promise<SaveNoteResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const clock = await orgClock(db, orgId, ctx.clock);
    const now = clock.now();
    const matterRef = db.doc(matterPath(orgId, input.matterId));
    const noteRef = db.doc(notePath(orgId, input.matterId, input.noteId));
    const revisionRef = db.doc(`${noteRef.path}/revisions/${requestId}`);
    const notifyCtx = { db, orgId, clock, log, ports: ctx.ports };

    const outcome = await db.runTransaction(async (tx) => {
      const matter = liveMatter(await tx.get(matterRef), role, input.matterId);
      const note = liveNote(await tx.get(noteRef), role, input.noteId);
      const wasPrivileged = note['privileged'] === true;
      const privileged = matter['privileged'] === true || (input.privileged ?? wasPrivileged);
      if (privileged !== wasPrivileged) assertMayMarkPrivileged(role);
      if (note['bodyMd'] === input.bodyMd && privileged === wasPrivileged) {
        return { changed: false as const, updatedAt: iso(note['updatedAt']) ?? now.toISOString() };
      }
      if (!input.overwrite && millis(note['updatedAt']) !== Date.parse(input.expectedUpdatedAt)) {
        throw new DomainError('FAILED_PRECONDITION', 'Someone else saved this note while you were editing it', {
          reason: 'note_conflict',
          noteId: input.noteId,
          updatedAt: iso(note['updatedAt']),
          updatedBy: typeof note['updatedBy'] === 'string' ? note['updatedBy'] : null,
        });
      }

      const people = await readPeople(tx, db, orgId, [uid, ...parseMentions(input.bodyMd).uids]);
      const mentions = noteMentions(input.bodyMd, people);
      const before = (note['mentions'] as { uids?: unknown } | undefined)?.uids;
      // The version being replaced: who wrote that text and when (its last edit, else its creation).
      tx.set(
        revisionRef,
        NoteRevision.schema.parse({
          bodyMd: typeof note['bodyMd'] === 'string' ? note['bodyMd'] : '',
          privileged: wasPrivileged,
          editedAt: toDate(note['editedAt']) ?? toDate(note['createdAt']) ?? now,
          editedBy: String(note['editedBy'] ?? note['createdBy'] ?? 'system'),
          createdAt: now,
          createdBy: uid,
          updatedAt: now,
          updatedBy: uid,
          schemaVersion: NoteRevision.version,
        }),
      );
      tx.update(noteRef, {
        bodyMd: input.bodyMd,
        mentions,
        privileged,
        editedAt: now,
        editedBy: uid,
        ...stamp(uid, now, requestId),
      });
      const sent = await notifyMentions(notifyCtx, {
        tx,
        orgId,
        matterId: input.matterId,
        noteId: input.noteId,
        matter,
        author: uid,
        privileged,
        before: Array.isArray(before) ? before.filter((id): id is string => typeof id === 'string') : [],
        after: mentions.uids,
        people,
      });
      return { changed: true as const, ...sent, privileged, mentioned: mentions.uids.length };
    });

    if (!outcome.changed) {
      log.info('note unchanged', { matterId: input.matterId, noteId: input.noteId });
      return { noteId: input.noteId, updatedAt: outcome.updatedAt, notified: [], unreachable: [] };
    }
    await outcome.dispatch();
    await audit(
      { uid, orgId, requestId, db, clock },
      {
        action: 'note.edited',
        entity: { path: noteRef.path },
        summary: `Note ${input.noteId} edited on matter ${input.matterId}`,
        data: {
          privileged: outcome.privileged,
          mentioned: outcome.mentioned,
          notified: outcome.notified.length,
          revisionId: revisionRef.id,
          ...(input.overwrite ? { overwrite: true } : {}),
        },
      },
    );
    log.info('note edited', {
      matterId: input.matterId,
      noteId: input.noteId,
      notified: outcome.notified.length,
      unreachable: outcome.unreachable.length,
    });
    return {
      noteId: input.noteId,
      updatedAt: now.toISOString(),
      notified: outcome.notified,
      unreachable: outcome.unreachable,
    };
  },
} satisfies CallableDefinition<typeof UpdateNoteInput, SaveNoteResult>;

export const update = defineCallable(updateDefinition);
