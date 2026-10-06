import { CLERK_DISCLOSURE_VERSION, type ContextManifest } from '@materia/domain';

import type { ClerkKeyring, OrgKey } from './keyring';
import type {
  ClerkStore,
  FinalMessage,
  MessageSink,
  MeterEntry,
  OrgClerkSettings,
  RateLimit,
  RateSlot,
  ToolCallState,
} from './store';

interface MemoryMessage {
  writes: string[];
  final?: FinalMessage;
  closed: boolean;
  stop: () => void;
  manifest?: ContextManifest;
  /** Each update of the tool calls (AI-06). */
  tools: ToolCallState[][];
}

/** Org settings that let every feature run: the current disclosure acknowledged (AI-13). */
export const ACKNOWLEDGED_CLERK_SETTINGS: OrgClerkSettings = { ackVersion: CLERK_DISCLOSURE_VERSION };

/**
 * An in-memory ClerkStore for unit tests (the Firestore one is covered by integration tests). Its
 * org has acknowledged the data-use disclosure unless a test sets `settings` without it.
 */
export class MemoryClerkStore implements ClerkStore {
  settings: OrgClerkSettings = { ...ACKNOWLEDGED_CLERK_SETTINGS };
  readonly hits = new Map<string, number[]>();
  readonly days = new Map<string, { day: string; count: number }>();
  readonly meters: { period: string; entry: MeterEntry }[] = [];
  readonly messages = new Map<string, MemoryMessage>();
  tokensUsed = 0;
  costMicrosUsed = 0;

  async orgSettings(): Promise<OrgClerkSettings> {
    return this.settings;
  }

  async takeRateSlot(_orgId: string, uid: string, nowMs: number, limit: RateLimit): Promise<RateSlot> {
    const hits = (this.hits.get(uid) ?? []).filter((at) => at > nowMs - limit.windowMs);
    if (hits.length >= limit.requests) return 'window';
    const today = this.days.get(uid);
    const count = limit.daily && today && today.day === limit.daily.day ? today.count : 0;
    if (limit.daily && count >= limit.daily.limit) return 'daily';
    this.hits.set(uid, [...hits, nowMs]);
    if (limit.daily) this.days.set(uid, { day: limit.daily.day, count: count + 1 });
    return 'ok';
  }

  async periodUsage(): Promise<{ tokens: number; costMicros: number }> {
    return { tokens: this.tokensUsed, costMicros: this.costMicrosUsed };
  }

  async meter(_orgId: string, period: string, entry: MeterEntry): Promise<void> {
    this.meters.push({ period, entry });
    const u = entry.usage;
    this.tokensUsed += u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    this.costMicrosUsed += entry.costMicros;
  }

  async openMessage(
    _orgId: string,
    target: { threadId: string; messageId: string },
    init?: { manifest?: ContextManifest },
  ): Promise<MessageSink> {
    const key = `${target.threadId}/${target.messageId}`;
    if (this.messages.has(key)) throw new Error('exists');
    const listeners: (() => void)[] = [];
    const record: MemoryMessage = {
      writes: [],
      tools: [],
      closed: false,
      stop: () => listeners.forEach((l) => l()),
      ...(init?.manifest ? { manifest: init.manifest } : {}),
    };
    this.messages.set(key, record);
    return {
      write: (text) => void record.writes.push(text),
      onStop: (listener) => void listeners.push(listener),
      tools: (calls) => void record.tools.push(calls.map((call) => ({ ...call }))),
      finish: async (final) => {
        record.final = final;
      },
      close: () => {
        record.closed = true;
      },
    };
  }
}

/** An in-memory keyring for unit tests: one org key, or none. */
export class MemoryKeyring implements ClerkKeyring {
  key: OrgKey = { state: 'ok', apiKey: 'sk-ant-fictional-unit-test-key-0000', version: 'v1' };
  readonly invalidated: string[] = [];

  async resolve(): Promise<OrgKey> {
    return this.key;
  }

  async markInvalid(_orgId: string, version: string): Promise<void> {
    this.invalidated.push(version);
    if (this.key.state === 'ok' && this.key.version === version) this.key = { state: 'invalid' };
  }
}
