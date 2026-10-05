import type { DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';

import { can, DomainError, newlyMentioned, parseMentions, ROLES, type NoteMentions, type Role } from '@materia/domain';

import { matterPath } from '../matters/shared';
import { notify, type NotifyContext } from '../notifications/notify';

/** Shared helpers for the notes callables (CORE-13). */

type Data = Record<string, unknown>;

const isRole = (value: unknown): value is Role => (ROLES as readonly unknown[]).includes(value);

export const notesPath = (orgId: string, matterId: string) => `${matterPath(orgId, matterId)}/notes`;
export const notePath = (orgId: string, matterId: string, noteId: string) => `${notesPath(orgId, matterId)}/${noteId}`;

/** A Timestamp or Date in milliseconds (undefined for anything else). */
export function millis(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  const toMillis = (value as { toMillis?: () => number } | undefined)?.toMillis;
  return typeof toMillis === 'function' ? toMillis.call(value) : undefined;
}

/** A Timestamp or Date as a Date (undefined for anything else). */
export function toDate(value: unknown): Date | undefined {
  const ms = millis(value);
  return ms === undefined ? undefined : new Date(ms);
}

/** Only roles with `privileged.view` may mark a note privileged, or clear the flag. */
export function assertMayMarkPrivileged(role: Role): void {
  if (!can(role, 'privileged.view')) {
    throw new DomainError('PERMISSION_DENIED', 'Only a lawyer or above can change whether a note is privileged', {
      reason: 'privileged_requires_lawyer',
      action: 'privileged.view',
    });
  }
}

/** A member as the notes callables see them: active or not, their role and display name. */
export interface NotePerson {
  active: boolean;
  role: Role | undefined;
  displayName: string | undefined;
}

/** The author and every mentioned uid's member document, read in the transaction. */
export async function readPeople(
  tx: Transaction,
  db: Firestore,
  orgId: string,
  uids: readonly string[],
): Promise<Map<string, NotePerson>> {
  const unique = [...new Set(uids)];
  const snaps: DocumentSnapshot[] = unique.length
    ? await tx.getAll(...unique.map((uid) => db.doc(`orgs/${orgId}/members/${uid}`)))
    : [];
  const people = new Map<string, NotePerson>();
  for (const snap of snaps) {
    const role = snap.get('role');
    const name = snap.get('displayName');
    people.set(snap.id, {
      active: snap.exists && snap.get('status') === 'active',
      role: isRole(role) ? role : undefined,
      displayName: typeof name === 'string' && name.trim() ? name.trim() : undefined,
    });
  }
  return people;
}

/**
 * The note's mentions, parsed from its Markdown on the server: member mentions of anyone who isn't
 * an active member of the org are dropped (a typo or someone who left is just text); matter
 * mentions are kept as written (the reader's own access decides how they show).
 */
export function noteMentions(bodyMd: string, people: ReadonlyMap<string, NotePerson>): NoteMentions {
  const parsed = parseMentions(bodyMd);
  return { uids: parsed.uids.filter((uid) => people.get(uid)?.active === true), matterIds: parsed.matterIds };
}

/** Whether a member with this role can open a note with this flag (the rules' `visible()`). */
export const canOpenNote = (role: Role | undefined, privileged: boolean) =>
  !!role && can(role, 'matter.view', { privileged });

export interface MentionOutcome {
  notified: string[];
  unreachable: string[];
  /** Enqueues email and push; call it once the transaction has committed. */
  dispatch: () => Promise<void>;
}

export interface MentionInput {
  tx: Transaction;
  orgId: string;
  matterId: string;
  noteId: string;
  matter: Data;
  author: string;
  privileged: boolean;
  before: readonly string[];
  after: readonly string[];
  people: ReadonlyMap<string, NotePerson>;
}

/**
 * Sends a `mention` notification, in the transaction, to each member mentioned for the first time
 * (never the author). Someone who can't open the note (privileged, without `privileged.view`) is
 * left out and returned as unreachable. The title names the author and the matter number only, and
 * the body is generic: never the note's text or the matter's title, either of which may be
 * privileged. One notification per note and member (`mention-{noteId}-{uid}`), so a retry rewrites
 * it rather than sending another.
 */
export async function notifyMentions(ctx: NotifyContext, input: MentionInput): Promise<MentionOutcome> {
  const { tx, matterId, noteId, matter, author, privileged, people } = input;
  const recipients = newlyMentioned(input.before, input.after).filter((uid) => uid !== author);
  const reachable = recipients.filter((uid) => canOpenNote(people.get(uid)?.role, privileged));
  const unreachable = recipients.filter((uid) => !reachable.includes(uid));
  const authorName = people.get(author)?.displayName ?? 'A colleague';
  const number = typeof matter['number'] === 'string' && matter['number'] ? matter['number'] : 'a matter';
  const notified: string[] = [];
  const dispatches: (() => Promise<void>)[] = [];
  for (const uid of reachable) {
    const sent = await notify(
      ctx,
      {
        kind: 'mention',
        noteId,
        matterId,
        recipients: [uid],
        title: `${authorName} mentioned you on ${number}`,
        body: 'You were mentioned in a matter note. Open it to read it.',
        link: `/matters/${matterId}/notes#note-${noteId}`,
        key: `mention-${noteId}-${uid}`,
        actor: author,
      },
      { tx },
    );
    if (sent.ids.length || sent.collapsed.length) notified.push(uid);
    dispatches.push(sent.dispatch);
  }
  return {
    notified,
    unreachable,
    dispatch: async () => {
      for (const dispatch of dispatches) await dispatch();
    },
  };
}

/** The current note when the caller may edit it: it exists, is live and they can open it. */
export function liveNote(snap: DocumentSnapshot, role: Role, noteId: string): Data {
  const data = snap.data();
  const deleted = data?.['deletedAt'] !== undefined && data?.['deletedAt'] !== null;
  if (!snap.exists || !data || deleted || !canOpenNote(role, data['privileged'] === true)) {
    throw new DomainError('NOT_FOUND', 'Note not found', { noteId });
  }
  return data;
}
