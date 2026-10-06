import type { CitedChunk, CitedDocument, ClerkCitation, ClerkUsage } from '@materia/clerk';
import type { ContextManifest, OrgClerkSettings } from '@materia/domain';

import type { ClerkContentBlock, ClerkTurn } from '../ports';

/** The org's Clerk settings (`orgs/{orgId}.settings.clerk`, AI-02a and AI-13). */
export type { OrgClerkSettings };

/** What the gateway's limits need from the person's request counters. */
export interface RateLimit {
  /** The sliding window (AI-02). */
  requests: number;
  windowMs: number;
  /** The org's per-person daily cap (AI-13), counted per metering day. */
  daily?: { limit: number; day: string };
}

/** Why `takeRateSlot` refused: the sliding window or the daily cap. */
export type RateSlot = 'ok' | 'window' | 'daily';

export type ClerkMessageStatus = 'done' | 'error' | 'stopped' | 'refused' | 'truncated' | 'invalid_output';

/** The documents and passages of an exchange, in request order (the API numbers each kind so). */
export interface ExchangeSources {
  documents: CitedDocument[];
  searchResults: CitedChunk[];
}

/**
 * One question and its answer as the model saw them (AI-06): the user turn as sent (without cache
 * markers), then every assistant turn and tool-result turn, verbatim. A later question in the
 * thread replays it unchanged (preserved thinking); it is never edited.
 */
export interface StoredExchange {
  user: ClerkContentBlock[];
  turns: ClerkTurn[];
  sources: ExchangeSources;
  /** The model that answered: thinking blocks only replay to the same model. */
  model: string;
}

export interface FinalMessage {
  status: ClerkMessageStatus;
  text: string;
  citations: ClerkCitation[];
  usage: ClerkUsage;
  model: string;
  fallbackUsed: boolean;
  /** The assistant turn verbatim (stored server-side for replay; never shown or edited). */
  raw: readonly unknown[];
  /** The whole exchange, for a conversation's later turns (AI-06). */
  exchange?: StoredExchange;
}

/** A tool Clerk ran while answering, shown as the working step (AI-06). */
export interface ToolCallState {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
}

/** Where a streamed reply goes: `clerkThreads/{t}/messages/{m}`. */
export interface MessageSink {
  /** The text so far; written at most every STREAM_FLUSH_MS. */
  write(text: string): void;
  /** Called once when the thread owner sets `stopRequested`. */
  onStop(listener: () => void): void;
  /** The tools run so far and their state. */
  tools(calls: readonly ToolCallState[]): void;
  finish(final: FinalMessage): Promise<void>;
  close(): void;
}

export interface MeterEntry {
  feature: string;
  uid: string;
  usage: ClerkUsage;
  costMicros: number;
  costEstimated: boolean;
  /** Citations checked against the chunks (AI-05): counted as `citation_verified`/`citation_unverified`. */
  citations?: { verified: number; unverified: number };
}

/** The gateway's persistence (Firestore in production, in memory in unit tests). */
export interface ClerkStore {
  orgSettings(orgId: string): Promise<OrgClerkSettings>;
  /** Takes a slot in the user's sliding window (and daily count); says which limit refused it. */
  takeRateSlot(orgId: string, uid: string, nowMs: number, limit: RateLimit): Promise<RateSlot>;
  /** Tokens and cost metered so far in a `clerk-YYYY-MM` period. */
  periodUsage(orgId: string, period: string): Promise<{ tokens: number; costMicros: number }>;
  meter(orgId: string, period: string, entry: MeterEntry, at: Date): Promise<void>;
  /** Creates (or adopts) the assistant message (never overwrites a finished one: history is append-only). */
  openMessage(
    orgId: string,
    target: { threadId: string; messageId: string },
    init: {
      uid: string;
      promptRef: string;
      requestId: string;
      /** What Clerk was shown (AI-03); stored for audit, and its `privileged` marks the message. */
      manifest?: ContextManifest;
      /**
       * Take over a message `clerk-sendMessage` already created as `streaming` (AI-06), instead of
       * creating it. Anything else (missing, finished) is refused.
       */
      adopt?: boolean;
    },
  ): Promise<MessageSink>;
}
