import type { Firestore } from 'firebase-admin/firestore';

import {
  defaultDedupeKey,
  DomainError,
  Suggestion,
  SUGGESTION_PROPOSE_MAX,
  SUGGESTION_TTL_DAYS,
  SuggestionProposalSchema,
  type SuggestionKind,
} from '@materia/domain';

import './handlers';
import { suggestionHandler } from './registry';
import {
  CLERK_ACTOR,
  countOutcomes,
  currentBasis,
  suggestionsPath,
  txReader,
  type Data,
  type MetricEntry,
} from './shared';
import { compact } from '../contacts/shared';
import { isEnabled } from '../core/flags';
import type { Log } from '../core/log';
import { CLOSED_STATUSES } from '../deadlines/shared';
import { matterPath } from '../matters/shared';
import type { Clock } from '../ports';

/** What `proposeSuggestions` needs: the org's Firestore, clock and log (a callable's or job's context). */
export interface ProposeContext {
  db: Firestore;
  orgId: string;
  clock: Clock;
  log: Log;
}

export interface ProposeOptions {
  /**
   * The Clerk context drew on privileged material (`manifest.privileged`, AI-03): every suggestion
   * from it is privileged. A privileged matter or a privileged cited document also makes one so.
   */
  privileged: boolean;
  /** The prompt template and model that produced the proposals (for evals and metrics). */
  promptId: string;
  promptVersion: string;
  model: string;
  /** Days until an unanswered suggestion expires (default 14). */
  ttlDays?: number;
  /**
   * A person's own Claude proposed them through the connector (INT-07): they are written by that
   * person, with their name for the card, instead of by `clerk`.
   */
  requestedBy?: { uid: string; name: string };
}

export type ProposeSkipReason =
  /** Didn't match its kind's payload schema. */
  | 'invalid'
  /** An open or dismissed suggestion (or an earlier proposal in this call) has the same `dedupeKey`. */
  | 'duplicate'
  /** The domain already has it (a live task with the same title and due date, the fact already set). */
  | 'exists'
  /** `clerk.features.suggestions` is off for the org. */
  | 'disabled'
  /** The matter is missing, deleted, closed or archived. */
  | 'matter_unavailable';

export interface ProposeResult {
  created: { index: number; id: string; kind: SuggestionKind; dedupeKey: string; privileged: boolean }[];
  skipped: { index: number; reason: ProposeSkipReason; dedupeKey?: string }[];
}

/** Statuses a new proposal is a duplicate of: open ones, and ones a person already dismissed. */
const BLOCKING_STATUSES = new Set(['proposed', 'stale', 'dismissed']);
const IN_LIMIT = 30;

/**
 * Creates Clerk suggestions on a matter (AI-07, ADR-037): the only way Clerk features write
 * (Clerk rule 3). Server-side only; the caller has already checked the person and built the
 * context. Each proposal is validated against its kind; then, in one transaction (so two runs at
 * once can't both create the same thing):
 *
 * - it is skipped when an open or dismissed suggestion, or an earlier proposal of this call, has
 *   the same `dedupeKey` (default `defaultDedupeKey`), or when the kind's handler finds the domain
 *   already has it;
 * - its `basis` is computed from the sources it depends on (`suggestionBasisParts`);
 * - it is privileged when `options.privileged`, the matter or a cited or targeted document is;
 * - it expires after `ttlDays` (14) and is written as `proposed` by `clerk` (or, for the Claude
 *   connector, by the person whose Claude proposed it: `requestedBy`).
 *
 * Counted as `proposed` in the org's Clerk metrics. Never throws for a bad proposal; the result
 * says what was created and why the rest were skipped.
 */
export async function proposeSuggestions(
  ctx: ProposeContext,
  matterId: string,
  proposals: readonly unknown[],
  options: ProposeOptions,
): Promise<ProposeResult> {
  const { db, orgId, clock, log } = ctx;
  if (proposals.length > SUGGESTION_PROPOSE_MAX) {
    throw new DomainError('INVALID_ARGUMENT', `At most ${SUGGESTION_PROPOSE_MAX} proposals per call`);
  }
  const result: ProposeResult = { created: [], skipped: [] };
  if (!(await isEnabled({ orgId, db, clock }, 'clerk.features.suggestions'))) {
    result.skipped = proposals.map((_, index) => ({ index, reason: 'disabled' }));
    return result;
  }

  const now = clock.now();
  const actor = options.requestedBy?.uid ?? CLERK_ACTOR;
  const ttl = options.ttlDays ?? SUGGESTION_TTL_DAYS;
  const expiresAt = new Date(now.getTime() + ttl * 86_400_000);
  const valid: { index: number; proposal: ReturnType<typeof SuggestionProposalSchema.parse>; dedupeKey: string }[] = [];
  const seen = new Set<string>();
  proposals.forEach((raw, index) => {
    const parsed = SuggestionProposalSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn('invalid suggestion proposal', {
        matterId,
        index,
        paths: parsed.error.issues.map((i) => i.path.join('.')),
      });
      result.skipped.push({ index, reason: 'invalid' });
      return;
    }
    const dedupeKey = parsed.data.dedupeKey ?? defaultDedupeKey(parsed.data);
    if (seen.has(dedupeKey)) {
      result.skipped.push({ index, reason: 'duplicate', dedupeKey });
      return;
    }
    seen.add(dedupeKey);
    valid.push({ index, proposal: parsed.data, dedupeKey });
  });
  if (!valid.length) return result;

  const matterRef = db.doc(matterPath(orgId, matterId));
  const collection = db.collection(suggestionsPath(orgId, matterId));
  const outcome = await db.runTransaction(async (tx) => {
    const created: ProposeResult['created'] = [];
    const skipped: ProposeResult['skipped'] = [];
    const matterSnap = await tx.get(matterRef);
    const matter = matterSnap.data() as Data | undefined;
    const deleted = matter?.['deletedAt'] !== undefined && matter?.['deletedAt'] !== null;
    if (!matter || deleted || CLOSED_STATUSES.has(matter['status'])) {
      return { created, skipped: valid.map(({ index }) => ({ index, reason: 'matter_unavailable' as const })) };
    }

    // ---- reads ----
    const blocked = new Set<string>();
    const keys = valid.map((item) => item.dedupeKey);
    for (let i = 0; i < keys.length; i += IN_LIMIT) {
      const snap = await tx.get(collection.where('dedupeKey', 'in', keys.slice(i, i + IN_LIMIT)));
      for (const doc of snap.docs) {
        if (BLOCKING_STATUSES.has(doc.get('status'))) blocked.add(String(doc.get('dedupeKey')));
      }
    }
    const read = txReader(tx);
    const writes: { index: number; data: Data; kind: SuggestionKind; dedupeKey: string; privileged: boolean }[] = [];
    for (const { index, proposal, dedupeKey } of valid) {
      if (blocked.has(dedupeKey)) {
        skipped.push({ index, reason: 'duplicate', dedupeKey });
        continue;
      }
      const handler = suggestionHandler(proposal.kind);
      if (
        handler?.exists &&
        (await handler.exists({ db, read, orgId, matterId, matter, payload: proposal.payload as never }))
      ) {
        skipped.push({ index, reason: 'exists', dedupeKey });
        continue;
      }
      const basis = await currentBasis(read, db, orgId, matterId, matter, proposal);
      const privileged = options.privileged || basis.privileged;
      writes.push({
        index,
        kind: proposal.kind,
        dedupeKey,
        privileged,
        data: Suggestion.schema.parse(
          compact({
            kind: proposal.kind,
            payload: proposal.payload,
            orgId,
            matterId,
            citations: proposal.citations,
            rationale: proposal.rationale,
            confidence: proposal.confidence,
            status: 'proposed',
            promptId: options.promptId,
            promptVersion: options.promptVersion,
            model: options.model,
            privileged,
            basis: basis.basis,
            basisParts: basis.parts,
            dedupeKey,
            expiresAt,
            requestedBy: options.requestedBy,
            createdAt: now,
            createdBy: actor,
            updatedAt: now,
            updatedBy: actor,
            schemaVersion: Suggestion.version,
          }),
        ) as Data,
      });
    }

    // ---- writes ----
    for (const write of writes) {
      const ref = collection.doc();
      tx.create(ref, compactDeep(write.data));
      created.push({
        index: write.index,
        id: ref.id,
        kind: write.kind,
        dedupeKey: write.dedupeKey,
        privileged: write.privileged,
      });
    }
    return { created, skipped };
  });
  result.created = outcome.created;
  result.skipped = [...result.skipped, ...outcome.skipped].sort((a, b) => a.index - b.index);

  const metrics: MetricEntry[] = outcome.created.map((item) => ({
    kind: item.kind,
    promptId: options.promptId,
    promptVersion: options.promptVersion,
    outcome: 'proposed',
  }));
  await countOutcomes(db, orgId, now, metrics, log);
  log.info('suggestions proposed', {
    matterId,
    created: outcome.created.length,
    skipped: result.skipped.length,
    privileged: outcome.created.filter((item) => item.privileged).length,
  });
  return result;
}

/** Drops `undefined` at every level (Firestore rejects it), keeping Dates as they are. */
function compactDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compactDeep) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, compactDeep(v)]),
    ) as T;
  }
  return value;
}
