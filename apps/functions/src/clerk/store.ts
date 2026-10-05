import type { ClerkCitation, ClerkUsage } from '@materia/clerk';
import type { ContextManifest } from '@materia/domain';

/** The org's Clerk settings (`orgs/{orgId}.settings.clerk`). */
export interface OrgClerkSettings {
  enabled?: boolean;
  monthlyTokenBudget?: number;
  userRateLimit?: { requests: number; windowMinutes: number };
}

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
  /** Takes a slot in the user's sliding window; false when the window is full. */
  takeRateSlot(
    orgId: string,
    uid: string,
    nowMs: number,
    limit: { requests: number; windowMs: number },
  ): Promise<boolean>;
  /** Tokens metered so far in a `clerk-YYYY-MM` period. */
  periodTokens(orgId: string, period: string): Promise<number>;
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
