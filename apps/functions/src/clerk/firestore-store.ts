import { FieldValue, type Firestore } from 'firebase-admin/firestore';

import { DomainError } from '@materia/domain';

import { STREAM_FLUSH_MS } from './features';
import type { ClerkStore, FinalMessage, MessageSink, MeterEntry, OrgClerkSettings, RateSlot } from './store';

const SYSTEM = 'system';

/** Metric names under `values`, per call. Keys with dots are literal (set with merge). */
function meterValues(entry: MeterEntry): Record<string, FieldValue> {
  const { usage } = entry;
  const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const base: Record<string, number> = {
    calls: 1,
    tokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    costMicros: entry.costMicros,
    ...(entry.costEstimated ? { estimatedCostCalls: 1 } : {}),
  };
  const values: Record<string, FieldValue> = {};
  for (const [name, value] of Object.entries(base)) {
    values[name] = FieldValue.increment(value);
    if (name === 'estimatedCostCalls') continue;
    if (['calls', 'tokens', 'costMicros'].includes(name)) {
      values[`feature.${entry.feature}.${name}`] = FieldValue.increment(value);
      values[`user.${entry.uid}.${name}`] = FieldValue.increment(value);
    }
  }
  // Citation verification (AI-05): quotes found on their page, and those dropped from the UI.
  if (entry.citations) {
    for (const [name, value] of [
      ['citation_verified', entry.citations.verified],
      ['citation_unverified', entry.citations.unverified],
    ] as const) {
      if (!value) continue;
      values[name] = FieldValue.increment(value);
      values[`feature.${entry.feature}.${name}`] = FieldValue.increment(value);
    }
  }
  return values;
}

/**
 * The gateway's Firestore persistence (AI-02):
 * - the per-user window and daily count in `orgs/{orgId}/counters/clerk-rate-{uid}` (server-only);
 * - metering in `orgs/{orgId}/metrics/clerk-{YYYY-MM}` (totals, `feature.<f>.*`, `user.<uid>.*`,
 *   and `citation_verified`/`citation_unverified` from AI-05's verification);
 * - streamed replies in `clerkThreads/{t}/messages/{m}`, with the verbatim assistant turn in the
 *   server-only `messages/{m}/private/raw` for replay.
 */
export function firestoreClerkStore(db: Firestore, now: () => number = Date.now): ClerkStore {
  return {
    async orgSettings(orgId): Promise<OrgClerkSettings> {
      const org = await db.doc(`orgs/${orgId}`).get();
      return (org.get('settings.clerk') as OrgClerkSettings | undefined) ?? {};
    },

    async takeRateSlot(orgId, uid, nowMs, limit): Promise<RateSlot> {
      const ref = db.doc(`orgs/${orgId}/counters/clerk-rate-${uid}`);
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const hits = ((snapshot.get('hits') as number[] | undefined) ?? []).filter((at) => at > nowMs - limit.windowMs);
        if (hits.length >= limit.requests) return 'window';
        const day = limit.daily?.day ?? (snapshot.get('day') as string | undefined) ?? null;
        const dayCount = snapshot.get('day') === day ? ((snapshot.get('dayCount') as number | undefined) ?? 0) : 0;
        if (limit.daily && dayCount >= limit.daily.limit) return 'daily';
        tx.set(ref, { hits: [...hits, nowMs], day, dayCount: dayCount + 1, updatedAt: FieldValue.serverTimestamp() });
        return 'ok';
      });
    },

    async periodUsage(orgId, period): Promise<{ tokens: number; costMicros: number }> {
      const snapshot = await db.doc(`orgs/${orgId}/metrics/${period}`).get();
      const values = (snapshot.get('values') as Record<string, unknown> | undefined) ?? {};
      const num = (value: unknown) => (typeof value === 'number' ? value : 0);
      return { tokens: num(values['tokens']), costMicros: num(values['costMicros']) };
    },

    async meter(orgId, period, entry, at): Promise<void> {
      const ref = db.doc(`orgs/${orgId}/metrics/${period}`);
      await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const meta = snapshot.exists
          ? { updatedAt: at, updatedBy: SYSTEM }
          : { period, createdAt: at, createdBy: SYSTEM, updatedAt: at, updatedBy: SYSTEM, schemaVersion: 1 };
        tx.set(ref, { ...meta, values: meterValues(entry) }, { merge: true });
      });
    },

    async openMessage(orgId, { threadId, messageId }, init): Promise<MessageSink> {
      const thread = db.doc(`orgs/${orgId}/clerkThreads/${threadId}`);
      if (!(await thread.get()).exists) throw new DomainError('NOT_FOUND', 'Clerk thread not found');
      const ref = thread.collection('messages').doc(messageId);
      const at = new Date(now());
      try {
        await ref.create({
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          citations: [],
          status: 'streaming',
          stopRequested: false,
          toolCalls: [],
          promptId: init.promptRef,
          ...(init.manifest ? { manifest: init.manifest, privileged: init.manifest.privileged } : {}),
          createdAt: at,
          createdBy: init.uid,
          updatedAt: at,
          updatedBy: init.uid,
          schemaVersion: 1,
          _requestId: init.requestId,
        });
      } catch (error) {
        if ((error as { code?: number }).code === 6)
          throw new DomainError('ALREADY_EXISTS', 'That Clerk message already exists');
        throw error;
      }

      let latest = '';
      let flushedAt = 0;
      let flushed = '';
      let chain: Promise<unknown> = Promise.resolve();
      const stopListeners: (() => void)[] = [];
      let stopped = false;
      const unsubscribe = ref.onSnapshot(
        (snapshot) => {
          if (!stopped && snapshot.get('stopRequested') === true) {
            stopped = true;
            for (const listener of stopListeners) listener();
          }
        },
        () => undefined,
      );
      const flush = () => {
        const text = latest;
        if (text === flushed) return;
        flushed = text;
        flushedAt = now();
        chain = chain.then(() => ref.update({ content: [{ type: 'text', text }] })).catch(() => undefined);
      };

      return {
        write(text) {
          latest = text;
          if (now() - flushedAt >= STREAM_FLUSH_MS) flush();
        },
        onStop(listener) {
          stopListeners.push(listener);
          if (stopped) listener();
        },
        async finish(final: FinalMessage) {
          await chain;
          const done = new Date(now());
          await ref.update({
            content: [{ type: 'text', text: final.text }],
            status: final.status,
            citations: final.citations,
            usage: final.usage,
            model: final.model,
            fallbackUsed: final.fallbackUsed,
            updatedAt: done,
          });
          // A JSON string: the turn must replay byte-for-byte, and Firestore can't hold every shape
          // the API returns (nested arrays, `undefined`).
          await ref
            .collection('private')
            .doc('raw')
            .set({ model: final.model, contentJson: JSON.stringify(final.raw), createdAt: done });
          await thread.update({ lastMessageAt: done });
        },
        close() {
          unsubscribe();
        },
      };
    },
  };
}
