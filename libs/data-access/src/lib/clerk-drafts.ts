import * as z from 'zod';

import {
  CLERK_DRAFT_CALLABLES,
  ClerkDraft,
  clerkDraftsPath,
  SoftDeleteShape,
  type RedraftClerkDraftInput,
  type RedraftClerkDraftResult,
  type RewriteClerkDraftInput,
  type RewriteClerkDraftResult,
  type SaveClerkDraftInput,
  type SaveClerkDraftResult,
  type StartClerkDraftInput,
  type StartClerkDraftResult,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';
import type { WithId } from './resources';

/** A Clerk draft as the editor reads it (AI-10), with its soft-delete fields. */
export const ClerkDraftItemSchema = /* @__PURE__ */ z.object({
  ...ClerkDraft.schema.shape,
  deletedAt: SoftDeleteShape.deletedAt,
  deletedBy: SoftDeleteShape.deletedBy,
});
export type ClerkDraftItem = z.infer<typeof ClerkDraftItemSchema>;

/**
 * A matter's Clerk drafts (`orgs/{orgId}/matters/{matterId}/clerkDrafts`, AI-10): the owner reads
 * them, edits the body and its provenance once Clerk has finished, asks a running draft to stop,
 * and deletes them (`ClerkDraft.update`: `bodyMd`, `provenance` and `stopRequested` only). Drafts
 * are created by `clerk-startDraft` and saved as documents by `clerk-saveDraft`.
 */
export function clerkDraftRepository(matterId: () => string | null): Repository<ClerkDraftItem> {
  return repo((orgId) => clerkDraftsPath(orgId, matterId() ?? '-'), {
    schema: ClerkDraftItemSchema,
    version: ClerkDraft.version,
    update: ClerkDraft.update,
  });
}

/**
 * The reader's drafts on a matter. Equality filters only (no composite index): the rules need the
 * owner, and `privileged == false` without `privileged.view`. `sortDrafts` orders them.
 */
export function clerkDraftsQuery(options: { uid: string; privilegedVisible: boolean }): QuerySpec<ClerkDraftItem> {
  return {
    where: [
      ['ownerUid', '==', options.uid],
      ...(options.privilegedVisible ? [] : [['privileged', '==', false] as const]),
    ],
    pageSize: 100,
  };
}

/** Live drafts, most recently changed first. */
export function sortDrafts(drafts: readonly WithId<ClerkDraftItem>[]): WithId<ClerkDraftItem>[] {
  return drafts
    .filter((draft) => !draft.deletedAt)
    .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
}

type Input<T> = Omit<T, 'requestId'>;

/** The `clerk-*` drafting callables (AI-10), all idempotent. */
export interface ClerkDraftCallables {
  /** Starts a draft; returns at once with its id (Clerk's letter streams into it). */
  start(input: Input<StartClerkDraftInput>, options?: { requestId?: string }): Promise<StartClerkDraftResult>;
  redraft(input: Input<RedraftClerkDraftInput>, options?: { requestId?: string }): Promise<RedraftClerkDraftResult>;
  rewrite(input: Input<RewriteClerkDraftInput>, options?: { requestId?: string }): Promise<RewriteClerkDraftResult>;
  /** Saves the letter on the letterhead to the matter's documents. Never sends it. */
  save(input: Input<SaveClerkDraftInput>, options?: { requestId?: string }): Promise<SaveClerkDraftResult>;
}

export function clerkDraftCallables(client: Pick<CallableClient, 'call'>): ClerkDraftCallables {
  const call =
    <I extends object, O>(name: string) =>
    (input: I, options: { requestId?: string } = {}) =>
      client.call<I, O>(name, input, { idempotent: true, ...options });
  return {
    start: call<Input<StartClerkDraftInput>, StartClerkDraftResult>(CLERK_DRAFT_CALLABLES.start),
    redraft: call<Input<RedraftClerkDraftInput>, RedraftClerkDraftResult>(CLERK_DRAFT_CALLABLES.redraft),
    rewrite: call<Input<RewriteClerkDraftInput>, RewriteClerkDraftResult>(CLERK_DRAFT_CALLABLES.rewrite),
    save: call<Input<SaveClerkDraftInput>, SaveClerkDraftResult>(CLERK_DRAFT_CALLABLES.save),
  };
}
