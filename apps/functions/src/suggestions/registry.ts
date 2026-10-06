import type { Firestore } from 'firebase-admin/firestore';

import type { CitationInput, Role, SuggestionKind, SuggestionPayloadOf } from '@materia/domain';

import type { Reader } from './shared';
import type { Log } from '../core/log';
import type { TxJoin } from '../core/tx-join';
import type { Clock, Ports } from '../ports';

/**
 * The accept-handler registry (AI-07, ADR-037). Each suggestion kind that can be accepted has one
 * handler, which applies the payload through the same domain logic as the manual path (never a
 * raw write) and joins the suggestion's re-check and resolution to that logic's transaction.
 * Kinds without a handler (the litigation kinds until their LIT tickets) are refused with SUGGESTION_UNSUPPORTED. A feature ticket registers its handler with
 * `registerSuggestionHandler` from its module, imported by `suggestions/handlers.ts`.
 */

/** What a handler gets to apply a suggestion. */
export interface ApplyContext<K extends SuggestionKind> {
  db: Firestore;
  orgId: string;
  matterId: string;
  /** The person accepting: every write is theirs. */
  uid: string;
  role: Role;
  requestId: string;
  clock: Clock;
  log: Log;
  ports: Ports;
  /** The payload to apply (the edited one when the person edited it). */
  payload: SuggestionPayloadOf<K>;
  /**
   * The suggestion: whether it is privileged, what Clerk cited and the payload it proposed (before
   * any edit), so a handler can keep the sources with what they support (key facts, CORE-06a).
   */
  suggestion: {
    id: string;
    privileged: boolean;
    citations: readonly CitationInput[];
    proposed: Readonly<Record<string, unknown>>;
  };
  /**
   * Must be joined to the transaction that makes the domain write: `read` before the writes (it
   * re-checks the suggestion and its basis, and throws to abort), `write` after them with the
   * path of the record created or changed.
   */
  join: TxJoin;
}

export interface ApplyResult {
  /** The record created or changed (a document path), stored as the suggestion's `resultRef`. */
  resultRef: string;
}

/** Arguments of a handler's duplicate check, read inside `proposeSuggestions`' transaction. */
export interface ExistsContext<K extends SuggestionKind> {
  db: Firestore;
  read: Reader;
  orgId: string;
  matterId: string;
  matter: Record<string, unknown>;
  payload: SuggestionPayloadOf<K>;
}

export interface SuggestionHandler<K extends SuggestionKind = SuggestionKind> {
  kind: K;
  /**
   * Whether the domain already has what the suggestion proposes (a live task with the same title
   * and due date, the fact already set to that value): `proposeSuggestions` skips it.
   */
  exists?(ctx: ExistsContext<K>): Promise<boolean>;
  apply(ctx: ApplyContext<K>): Promise<ApplyResult>;
}

const handlers = new Map<SuggestionKind, SuggestionHandler>();

/** Registers (or replaces) the accept handler of a kind. */
export function registerSuggestionHandler<K extends SuggestionKind>(handler: SuggestionHandler<K>): void {
  handlers.set(handler.kind, handler as unknown as SuggestionHandler);
}

/** The handler of a kind, or undefined while none is registered. */
export function suggestionHandler(kind: SuggestionKind): SuggestionHandler | undefined {
  return handlers.get(kind);
}

/** For tests: remove a kind's handler. */
export function unregisterSuggestionHandler(kind: SuggestionKind): void {
  handlers.delete(kind);
}

/** The kinds with a handler, sorted. */
export function handledSuggestionKinds(): SuggestionKind[] {
  return [...handlers.keys()].sort();
}
