import type { ClerkCitation, ClerkUsage } from '@materia/clerk';
import type { ContextManifest, OrgClerkSettings } from '@materia/domain';

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

export interface FinalMessage {
  status: ClerkMessageStatus;
  text: string;
  citations: ClerkCitation[];
  usage: ClerkUsage;
  model: string;
  fallbackUsed: boolean;
  /** The assistant turn verbatim (stored server-side for replay; never shown or edited). */
  raw: readonly unknown[];
}

/** Where a streamed reply goes: `clerkThreads/{t}/messages/{m}`. */
export interface MessageSink {
  /** The text so far; written at most every STREAM_FLUSH_MS. */
  write(text: string): void;
  /** Called once when the thread owner sets `stopRequested`. */
  onStop(listener: () => void): void;
  finish(final: FinalMessage): Promise<void>;
  close(): void;
}

export interface MeterEntry {
  feature: string;
  uid: string;
  usage: ClerkUsage;
  costMicros: number;
  costEstimated: boolean;
}

/** The gateway's persistence (Firestore in production, in memory in unit tests). */
export interface ClerkStore {
  orgSettings(orgId: string): Promise<OrgClerkSettings>;
  /** Takes a slot in the user's sliding window (and daily count); says which limit refused it. */
  takeRateSlot(orgId: string, uid: string, nowMs: number, limit: RateLimit): Promise<RateSlot>;
  /** Tokens and cost metered so far in a `clerk-YYYY-MM` period. */
  periodUsage(orgId: string, period: string): Promise<{ tokens: number; costMicros: number }>;
  meter(orgId: string, period: string, entry: MeterEntry, at: Date): Promise<void>;
  /** Creates the assistant message (never overwrites one: history is append-only). */
  openMessage(
    orgId: string,
    target: { threadId: string; messageId: string },
    init: {
      uid: string;
      promptRef: string;
      requestId: string;
      /** What Clerk was shown (AI-03); stored for audit, and its `privileged` marks the message. */
      manifest?: ContextManifest;
    },
  ): Promise<MessageSink>;
}
