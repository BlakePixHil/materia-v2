import type { ContextManifest } from '@materia/domain';

import type { ClerkStore, FinalMessage, MessageSink, MeterEntry, OrgClerkSettings } from './store';

interface MemoryMessage {
  writes: string[];
  final?: FinalMessage;
  closed: boolean;
  stop: () => void;
  manifest?: ContextManifest;
}

/** An in-memory ClerkStore for unit tests (the Firestore one is covered by integration tests). */
export class MemoryClerkStore implements ClerkStore {
  settings: OrgClerkSettings = {};
  readonly hits = new Map<string, number[]>();
  readonly meters: { period: string; entry: MeterEntry }[] = [];
  readonly messages = new Map<string, MemoryMessage>();
  tokensUsed = 0;

  async orgSettings(): Promise<OrgClerkSettings> {
    return this.settings;
  }

  async takeRateSlot(
    _orgId: string,
    uid: string,
    nowMs: number,
    limit: { requests: number; windowMs: number },
  ): Promise<boolean> {
    const hits = (this.hits.get(uid) ?? []).filter((at) => at > nowMs - limit.windowMs);
    if (hits.length >= limit.requests) return false;
    this.hits.set(uid, [...hits, nowMs]);
    return true;
  }

  async periodTokens(): Promise<number> {
    return this.tokensUsed;
  }

  async meter(_orgId: string, period: string, entry: MeterEntry): Promise<void> {
    this.meters.push({ period, entry });
    const u = entry.usage;
    this.tokensUsed += u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
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
      closed: false,
      stop: () => listeners.forEach((l) => l()),
      ...(init?.manifest ? { manifest: init.manifest } : {}),
    };
    this.messages.set(key, record);
    return {
      write: (text) => void record.writes.push(text),
      onStop: (listener) => void listeners.push(listener),
      finish: async (final) => {
        record.final = final;
      },
      close: () => {
        record.closed = true;
      },
    };
  }
}
