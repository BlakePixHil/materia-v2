import * as z from 'zod';

import {
  MetaShape,
  OPEN_SUGGESTION_STATUSES,
  Suggestion,
  SUGGESTION_CALLABLES,
  SuggestionKindSchema,
  SuggestionMetaShape,
  type AcceptManySuggestionsInput,
  type AcceptManySuggestionsResult,
  type AcceptSuggestionInput,
  type AcceptSuggestionResult,
  type DismissSuggestionInput,
  type DismissSuggestionResult,
  type SuggestionStaleDetails,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

/**
 * A Clerk suggestion as the UI reads it (AI-07): the suggestion fields, with the payload kept as a
 * plain record (the card validates it per kind when someone edits it), so one odd payload never
 * breaks the list.
 */
export const SuggestionItemSchema = /* @__PURE__ */ z.object({
  ...SuggestionMetaShape,
  ...MetaShape,
  kind: SuggestionKindSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type SuggestionItem = z.infer<typeof SuggestionItemSchema>;

/**
 * A matter's suggestions (`orgs/{orgId}/matters/{matterId}/suggestions`), read-only: functions
 * write them, and people accept and dismiss them through `suggestionCallables`.
 */
export function matterSuggestionsRepository(matterId: () => string | null): Repository<SuggestionItem> {
  return repo((orgId) => `orgs/${orgId}/matters/${matterId() ?? '-'}/suggestions`, {
    schema: SuggestionItemSchema,
    version: Suggestion.version,
  });
}

export interface SuggestionsQueryOptions {
  /** Whether the reader has `privileged.view`; without it the rules need `privileged == false`. */
  privilegedVisible: boolean;
  /** Include expired ones ("Show expired"). */
  includeExpired?: boolean;
  pageSize?: number;
}

/**
 * A matter's open suggestions (proposed and stale), plus expired ones when asked. Equality filters
 * only, so no composite index; the list sorts them itself.
 */
export function openSuggestionsQuery(options: SuggestionsQueryOptions): QuerySpec<SuggestionItem> {
  const statuses = [...OPEN_SUGGESTION_STATUSES, ...(options.includeExpired ? ['expired'] : [])];
  return {
    where: [['status', 'in', statuses], ...(options.privilegedVisible ? [] : [['privileged', '==', false] as const])],
    pageSize: options.pageSize ?? 100,
  };
}

type Input<T> = Omit<T, 'requestId'>;

/** The `suggestions-*` callables (AI-07), all idempotent. */
export interface SuggestionCallables {
  /**
   * Accepts one suggestion. Fails with SUGGESTION_STALE (`suggestionStaleOf`) when its sources
   * changed: show the changes, then accept with `expectedBasis` set to the new basis.
   */
  accept(input: Input<AcceptSuggestionInput>, options?: { requestId?: string }): Promise<AcceptSuggestionResult>;
  acceptMany(
    input: Input<AcceptManySuggestionsInput>,
    options?: { requestId?: string },
  ): Promise<AcceptManySuggestionsResult>;
  dismiss(input: Input<DismissSuggestionInput>, options?: { requestId?: string }): Promise<DismissSuggestionResult>;
}

export function suggestionCallables(client: Pick<CallableClient, 'call'>): SuggestionCallables {
  return {
    accept: (input, options = {}) =>
      client.call<Input<AcceptSuggestionInput>, AcceptSuggestionResult>(SUGGESTION_CALLABLES.accept, input, {
        idempotent: true,
        ...options,
      }),
    acceptMany: (input, options = {}) =>
      client.call<Input<AcceptManySuggestionsInput>, AcceptManySuggestionsResult>(
        SUGGESTION_CALLABLES.acceptMany,
        input,
        { idempotent: true, ...options },
      ),
    dismiss: (input, options = {}) =>
      client.call<Input<DismissSuggestionInput>, DismissSuggestionResult>(SUGGESTION_CALLABLES.dismiss, input, {
        idempotent: true,
        ...options,
      }),
  };
}

/** The stale details of a refused accept, or null for any other error. */
export function suggestionStaleOf(error: unknown): SuggestionStaleDetails | null {
  const e = error as { code?: unknown; details?: Record<string, unknown> } | null;
  if (e?.code !== 'SUGGESTION_STALE' || typeof e.details?.['basis'] !== 'string') return null;
  const changed = Array.isArray(e.details['changed'])
    ? (e.details['changed'] as SuggestionStaleDetails['changed'])
    : [];
  return { basis: e.details['basis'], changed };
}

/** The field errors of a refused edited accept (keyed by payload path), or null. */
export function suggestionFieldErrorsOf(error: unknown): Record<string, string[]> | null {
  const e = error as { code?: unknown; details?: Record<string, unknown> } | null;
  if (e?.code !== 'INVALID_ARGUMENT' || !e.details?.['fields']) return null;
  return e.details['fields'] as Record<string, string[]>;
}
