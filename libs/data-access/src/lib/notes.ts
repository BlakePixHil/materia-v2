import { z } from 'zod';

import {
  DomainError,
  NOTE_CALLABLES,
  Note,
  NoteRevision,
  SoftDeleteShape,
  type CreateNoteInput,
  type SaveNoteResult,
  type UpdateNoteInput,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

/**
 * A matter note as the Notes tab reads it (CORE-13): the `Note` fields, with anything else the
 * server keeps dropped rather than rejected, and the soft-delete fields typed.
 */
export const NoteItemSchema = /* @__PURE__ */ z.object({
  ...Note.schema.shape,
  deletedAt: SoftDeleteShape.deletedAt,
  deletedBy: SoftDeleteShape.deletedBy,
});
export type NoteItem = z.infer<typeof NoteItemSchema>;

/** A matter note's repository, plus `restore` (a soft-deleted note back, `deletedAt: null`). */
export interface NoteRepository extends Repository<NoteItem> {
  restore(id: string): Promise<void>;
}

/**
 * A matter's notes (`orgs/{orgId}/matters/{matterId}/notes`, CORE-13): live queries and the
 * client-direct writes the rules allow for note.write roles: pinning (`Note.update`: `pinned`
 * only), soft deletes and restores. There are no client creates or text edits: those go through
 * `notes-create` and `notes-update` (`noteCallables`), which parse mentions and keep revisions.
 */
export function matterNoteRepository(matterId: () => string | null): NoteRepository {
  const path = (orgId: string) => `orgs/${orgId}/matters/${matterId() ?? '-'}/notes`;
  const base = repo(path, { schema: NoteItemSchema, version: Note.version, update: Note.update });
  // Restoring writes the soft-delete fields, which the pin-only update whitelist doesn't allow.
  const deletes = repo(path, { schema: NoteItemSchema, version: Note.version });
  return {
    ...base,
    create: () =>
      Promise.reject(
        new DomainError('FAILED_PRECONDITION', 'Notes are created through notes-create', { reason: 'callable_only' }),
      ),
    restore: (id) => deletes.update(id, { deletedAt: null, deletedBy: null }),
  };
}

export interface NotesQueryOptions {
  /**
   * Whether the reader may see privileged notes (`privileged.view`). Without it the rules only
   * allow queries that prove `privileged == false`, so the query adds that filter.
   */
  privilegedVisible: boolean;
  pageSize?: number;
}

/**
 * A matter's notes, newest first (the tab puts pinned ones on top). Indexed: `createdAt desc`, and
 * `privileged ==, createdAt desc` for roles without privileged.view.
 */
export function matterNotesQuery(options: NotesQueryOptions): QuerySpec<NoteItem> {
  return {
    ...(options.privilegedVisible ? {} : { where: [['privileged', '==', false]] as const }),
    orderBy: [['createdAt', 'desc']],
    pageSize: options.pageSize ?? 100,
  };
}

/**
 * A matter's pinned notes, for the Overview. Equality filters only (no order, so no composite
 * index); the Overview sorts them newest first.
 */
export function pinnedNotesQuery(options: NotesQueryOptions): QuerySpec<NoteItem> {
  return {
    where: [['pinned', '==', true], ...(options.privilegedVisible ? [] : [['privileged', '==', false] as const])],
    pageSize: options.pageSize ?? 20,
  };
}

/** Pinned notes first, then newest first (by when they were written). */
export function compareNotes(a: Pick<NoteItem, 'pinned' | 'createdAt'>, b: Pick<NoteItem, 'pinned' | 'createdAt'>) {
  return Number(b.pinned) - Number(a.pinned) || b.createdAt.getTime() - a.createdAt.getTime();
}

// ---------- revisions ----------

const revision = NoteRevision.schema.shape;

/** An earlier version of a note: its text, privileged flag, and who wrote it when. */
export const NoteRevisionItemSchema = /* @__PURE__ */ z.object({
  bodyMd: revision.bodyMd,
  privileged: revision.privileged,
  editedAt: revision.editedAt,
  editedBy: revision.editedBy,
});
export type NoteRevisionItem = z.infer<typeof NoteRevisionItemSchema>;

/** A note's earlier versions (`notes/{noteId}/revisions`, CORE-13), written by `notes-update`; read-only. */
export function noteRevisionRepository(
  matterId: () => string | null,
  noteId: () => string | null,
): Repository<NoteRevisionItem> {
  return repo((orgId) => `orgs/${orgId}/matters/${matterId() ?? '-'}/notes/${noteId() ?? '-'}/revisions`, {
    schema: NoteRevisionItemSchema,
    version: NoteRevision.version,
  });
}

/**
 * A note's revisions, newest first. A reader sees a revision only when both it and its note are
 * visible to them, so roles without privileged.view prove `privileged == false` (indexed:
 * `privileged ==, editedAt desc`); the others order by `editedAt` alone.
 */
export function noteRevisionsQuery(options: NotesQueryOptions): QuerySpec<NoteRevisionItem> {
  return {
    ...(options.privilegedVisible ? {} : { where: [['privileged', '==', false]] as const }),
    orderBy: [['editedAt', 'desc']],
    pageSize: options.pageSize ?? 50,
  };
}

// ---------- callables ----------

/** Callable input without the request id, which the client adds. */
type Input<T> = Omit<T, 'requestId'>;

/** The `notes-*` callables (CORE-13). Both are idempotent. */
export interface NoteCallables {
  /**
   * `notes-create` (note.write): a note on a live matter. Mentioned members are notified, except
   * those who can't open it (privileged), returned as `unreachable`.
   */
  create(input: Input<CreateNoteInput>, options?: { requestId?: string }): Promise<SaveNoteResult>;
  /**
   * `notes-update` (note.write): new text (and, for lawyers and above, the privileged flag).
   * `expectedUpdatedAt` is the note's `updatedAt` when editing started; if it changed since, the
   * call fails with FAILED_PRECONDITION `note_conflict` (details: `updatedAt`, `updatedBy`)
   * unless `overwrite` is set. Only newly mentioned members are notified.
   */
  update(input: Input<UpdateNoteInput>, options?: { requestId?: string }): Promise<SaveNoteResult>;
}

export function noteCallables(client: Pick<CallableClient, 'call'>): NoteCallables {
  return {
    create: (input, options = {}) =>
      client.call<Input<CreateNoteInput>, SaveNoteResult>(NOTE_CALLABLES.create, input, {
        idempotent: true,
        ...options,
      }),
    update: (input, options = {}) =>
      client.call<Input<UpdateNoteInput>, SaveNoteResult>(NOTE_CALLABLES.update, input, {
        idempotent: true,
        ...options,
      }),
  };
}

/** The `note_conflict` details of a refused `notes-update`, or null for any other error. */
export function noteConflictOf(error: unknown): { updatedAt: string | null; updatedBy: string | null } | null {
  const details = (error as { code?: unknown; details?: Record<string, unknown> } | null)?.details;
  if ((error as { code?: unknown } | null)?.code !== 'FAILED_PRECONDITION' || details?.['reason'] !== 'note_conflict') {
    return null;
  }
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return { updatedAt: text(details['updatedAt']), updatedBy: text(details['updatedBy']) };
}
