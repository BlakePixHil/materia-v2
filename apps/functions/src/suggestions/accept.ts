import type { Transaction } from 'firebase-admin/firestore';

import {
  AcceptManySuggestionsInput,
  acceptsInBulk,
  AcceptSuggestionInput,
  basisChanges,
  basisPartLabel,
  can,
  DomainError,
  isOpenSuggestion,
  PERMISSIONS,
  SUGGESTION_KIND_ACTION,
  SUGGESTION_KIND_LABELS,
  SUGGESTION_PAYLOADS,
  SuggestionKindSchema,
  type AcceptManyItemResult,
  type AcceptManySuggestionsResult,
  type AcceptSuggestionResult,
  type CitationInput,
  type Role,
  type SuggestionKind,
  type SuggestionStaleDetails,
} from '@materia/domain';

import './handlers';
import { suggestionHandler, type ApplyContext, type ApplyResult } from './registry';
import { asDate, countOutcomes, currentBasis, metricOf, suggestionPath, txReader, type Data } from './shared';
import { audit } from '../audit/audit';
import { defineCallable, type CallableContext, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { requireFlag } from '../core/flags';
import type { TxJoin } from '../core/tx-join';
import { CLOSED_STATUSES } from '../deadlines/shared';
import { matterPath } from '../matters/shared';
import type { Clock } from '../ports';

/**
 * Accepting Clerk suggestions (AI-07, ADR-037): `suggestions-accept` and `suggestions-acceptMany`.
 * The person accepting needs `clerk.use` and the action the manual path needs for the kind
 * (`SUGGESTION_KIND_ACTION`), and privileged suggestions need `privileged.view` (else NOT_FOUND).
 */

/** Thrown inside the domain transaction when the basis no longer holds: the caller marks it stale. */
class StaleBasis extends Error {
  constructor(
    readonly basis: string,
    readonly changed: string[],
    readonly privileged: boolean,
  ) {
    super('stale');
  }
}

const notFound = (suggestionId: string) => new DomainError('NOT_FOUND', 'Suggestion not found', { suggestionId });

/** The suggestion when the caller may see it: it exists and, when privileged, they have `privileged.view`. */
function visibleSuggestion(data: Data | undefined, role: Role, suggestionId: string): Data {
  if (!data || (data['privileged'] === true && !can(role, 'privileged.view'))) throw notFound(suggestionId);
  return data;
}

/** An open suggestion, not past its expiry; anything else is ALREADY_RESOLVED. */
function assertOpen(data: Data, now: Date, suggestionId: string): void {
  const status = data['status'];
  if (!isOpenSuggestion(status)) {
    throw new DomainError('ALREADY_RESOLVED', 'The suggestion was already resolved', { suggestionId, status });
  }
  const expiresAt = asDate(data['expiresAt']);
  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    throw new DomainError('ALREADY_RESOLVED', 'The suggestion has expired', { suggestionId, status: 'expired' });
  }
}

/** A live matter the caller can see (NOT_FOUND otherwise) that isn't closed (MATTER_CLOSED). */
function openMatter(data: Data | undefined, role: Role, matterId: string): Data {
  const deleted = data?.['deletedAt'] !== undefined && data?.['deletedAt'] !== null;
  if (!data || deleted || (data['privileged'] === true && !can(role, 'privileged.view'))) {
    throw new DomainError('NOT_FOUND', 'Matter not found', { matterId });
  }
  if (CLOSED_STATUSES.has(data['status'])) {
    throw new DomainError('MATTER_CLOSED', 'The matter is closed', { matterId, status: data['status'] });
  }
  return data;
}

export interface AcceptOne {
  matterId: string;
  suggestionId: string;
  editedPayload?: Record<string, unknown> | undefined;
  expectedBasis?: string | undefined;
  /** Only a suggestion of this kind: another is INVALID_ARGUMENT (`reason: 'suggestion_kind'`). */
  kind?: SuggestionKind | undefined;
  /** Part of a bulk accept: a kind that isn't accepted in bulk is INVALID_ARGUMENT (`reason: 'suggestion_bulk'`). */
  bulk?: boolean | undefined;
}

/**
 * Applies the suggestion instead of its kind's handler, with the same context: the caller's own
 * domain write, joined to the same re-check and resolution (`clerk-startDraft` starting a letter
 * suggestion with what the person chose on the start page, AI-10b).
 */
export type ApplyOverride = (ctx: ApplyContext<SuggestionKind>) => Promise<ApplyResult>;

/**
 * Accepts one suggestion:
 *
 * 1. Reads it: missing or privileged-hidden is NOT_FOUND; not open (or past `expiresAt`) is
 *    ALREADY_RESOLVED; a kind without a handler is SUGGESTION_UNSUPPORTED; a role without the
 *    kind's action is PERMISSION_DENIED; an `editedPayload` that fails the kind's schema is
 *    INVALID_ARGUMENT with field errors keyed by payload path.
 * 2. Applies it through the kind's handler, whose transaction also (the join) re-reads the
 *    suggestion (still open, else ALREADY_RESOLVED: of two concurrent accepts exactly one commits),
 *    the matter (closed is MATTER_CLOSED) and the basis sources. When the basis differs from
 *    `expectedBasis` (default: the stored one), nothing is applied: the suggestion becomes `stale`
 *    with `staleReview` (the new basis and the changed parts), and the call fails with
 *    SUGGESTION_STALE. A cited document that became privileged makes it privileged too.
 * 3. Otherwise the suggestion is `accepted` (or `edited`), with `resolvedBy`, `resolvedAt` and
 *    `resultRef`, in the same transaction; then audited as `suggestion.accepted` (the person as the
 *    actor, `via: 'clerk'`) and counted in the org's Clerk metrics.
 *
 * `apply` replaces the handler's own apply (the kind still needs a handler).
 */
export async function acceptSuggestion(
  ctx: CallableContext<unknown>,
  clock: Clock,
  one: AcceptOne,
  apply?: ApplyOverride,
): Promise<AcceptSuggestionResult> {
  const { db, orgId, uid, role, requestId, log } = ctx;
  const { matterId, suggestionId } = one;
  const ref = db.doc(suggestionPath(orgId, matterId, suggestionId));
  const now = clock.now();
  const stored = visibleSuggestion((await ref.get()).data(), role, suggestionId);
  assertOpen(stored, now, suggestionId);
  const kindParse = SuggestionKindSchema.safeParse(stored['kind']);
  if (!kindParse.success) throw notFound(suggestionId);
  const kind: SuggestionKind = kindParse.data;
  if (one.kind && one.kind !== kind)
    throw new DomainError('INVALID_ARGUMENT', `The suggestion is a ${kind}, not a ${one.kind}`, {
      reason: 'suggestion_kind',
      kind,
    });
  if (one.bulk && !acceptsInBulk(kind))
    throw new DomainError('INVALID_ARGUMENT', `Accept a ${SUGGESTION_KIND_LABELS[kind].toLowerCase()} on its own`, {
      reason: 'suggestion_bulk',
      kind,
    });
  const handler = suggestionHandler(kind);
  if (!handler) {
    throw new DomainError('SUGGESTION_UNSUPPORTED', `Suggestions of kind ${kind} can't be accepted yet`, { kind });
  }
  const action = SUGGESTION_KIND_ACTION[kind];
  if (!can(role, action)) {
    throw new DomainError('PERMISSION_DENIED', `Role ${role} cannot ${action}`, { action, kind });
  }
  let payload: Record<string, unknown> = (stored['payload'] ?? {}) as Record<string, unknown>;
  const edited = one.editedPayload !== undefined;
  if (one.editedPayload !== undefined) {
    const parsed = SUGGESTION_PAYLOADS[kind].safeParse(one.editedPayload);
    if (!parsed.success) {
      const fields: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) (fields[issue.path.map(String).join('.')] ??= []).push(issue.message);
      throw new DomainError('INVALID_ARGUMENT', 'The edited suggestion has problems', {
        reason: 'edited_payload',
        fields,
      });
    }
    payload = parsed.data as Record<string, unknown>;
  }
  const status = edited ? 'edited' : 'accepted';
  const citations = (stored['citations'] ?? []) as CitationInput[];
  const expected = one.expectedBasis ?? String(stored['basis'] ?? '');
  const storedParts = (stored['basisParts'] ?? {}) as Record<string, string>;
  const matterRef = db.doc(matterPath(orgId, matterId));

  const join: TxJoin = {
    async read(tx: Transaction) {
      const current = visibleSuggestion((await tx.get(ref)).data(), role, suggestionId);
      assertOpen(current, now, suggestionId);
      const matter = openMatter((await tx.get(matterRef)).data(), role, matterId);
      // The basis as proposed: the sources Clerk computed it from must still say the same.
      const sources = await currentBasis(txReader(tx), db, orgId, matterId, matter, {
        kind,
        payload: current['payload'],
        citations,
      });
      const privileged = current['privileged'] === true || sources.privileged;
      if (sources.basis !== expected || (privileged && !can(role, 'privileged.view'))) {
        const changed = basisChanges(storedParts, sources.parts);
        throw new StaleBasis(sources.basis, changed, privileged);
      }
    },
    write(tx: Transaction, resultRef: string) {
      tx.update(ref, {
        status,
        resolvedBy: uid,
        resolvedAt: now,
        resultRef,
        ...(edited ? { appliedPayload: payload } : {}),
        updatedAt: now,
        updatedBy: uid,
        _requestId: requestId,
      });
    },
  };

  let resultRef: string;
  try {
    ({ resultRef } = await (apply ?? handler.apply.bind(handler))({
      db,
      orgId,
      matterId,
      uid,
      role,
      requestId,
      clock,
      log,
      ports: ctx.ports,
      payload: payload as never,
      suggestion: {
        id: suggestionId,
        privileged: stored['privileged'] === true,
        citations,
        proposed: (stored['payload'] ?? {}) as Record<string, unknown>,
      },
      join,
    }));
  } catch (error) {
    if (!(error instanceof StaleBasis)) throw error;
    await markStale(ctx, clock, one, error);
    if (error.privileged && !can(role, 'privileged.view')) throw notFound(suggestionId);
    const details: SuggestionStaleDetails = {
      basis: error.basis,
      changed: error.changed.map((key) => ({ key, label: basisPartLabel(key) })),
    };
    throw new DomainError('SUGGESTION_STALE', 'The suggestion’s sources changed', { suggestionId, ...details });
  }

  await audit(
    { uid, orgId, requestId, db, clock },
    {
      action: 'suggestion.accepted',
      entity: { path: ref.path },
      summary: `Clerk suggestion ${suggestionId} (${kind}) ${status} on matter ${matterId}`,
      data: {
        via: 'clerk',
        kind,
        matterId,
        suggestionId,
        status,
        resultRef,
        promptId: String(stored['promptId'] ?? ''),
        promptVersion: String(stored['promptVersion'] ?? ''),
      },
    },
  );
  await countOutcomes(db, orgId, now, [metricOf(stored, status)], log);
  log.info('suggestion accepted', { matterId, suggestionId, kind, status });
  return { suggestionId, status, resultRef };
}

/** Marks an open suggestion stale with what to re-review (and privileged when a source now is). */
async function markStale(ctx: CallableContext<unknown>, clock: Clock, one: AcceptOne, stale: StaleBasis) {
  const { db, orgId, uid, requestId, log } = ctx;
  const ref = db.doc(suggestionPath(orgId, one.matterId, one.suggestionId));
  const now = clock.now();
  const first = await db.runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data();
    if (!data || !isOpenSuggestion(data['status'])) return null;
    tx.update(ref, {
      status: 'stale',
      staleReview: { basis: stale.basis, changed: stale.changed, at: now },
      ...(stale.privileged ? { privileged: true } : {}),
      updatedAt: now,
      updatedBy: uid,
      _requestId: requestId,
    });
    return data['status'] === 'proposed' ? data : null;
  });
  // Counted once, when a proposed suggestion first goes stale.
  if (first) await countOutcomes(db, orgId, now, [metricOf(first, 'stale')], log);
  log.info('suggestion stale', { matterId: one.matterId, suggestionId: one.suggestionId, changed: stale.changed });
}

export const acceptDefinition = {
  name: 'suggestions-accept',
  input: AcceptSuggestionInput,
  roles: PERMISSIONS['clerk.use'],
  idempotent: true,
  handler: async (ctx): Promise<AcceptSuggestionResult> => {
    const clock = await orgClock(ctx.db, ctx.orgId, ctx.clock);
    await requireFlag({ orgId: ctx.orgId, db: ctx.db, clock }, 'clerk.features.suggestions');
    return acceptSuggestion(ctx, clock, ctx.input);
  },
} satisfies CallableDefinition<typeof AcceptSuggestionInput, AcceptSuggestionResult>;

/**
 * `suggestions-acceptMany` (bulk accept on the Overview): accepts each id in order with the same
 * checks as `suggestions-accept`; one failing doesn't stop the rest, and each has its own result
 * (`ok`, or the error `code` and `details`). A letter (AI-10b) isn't accepted in bulk.
 */
export const acceptManyDefinition = {
  name: 'suggestions-acceptMany',
  input: AcceptManySuggestionsInput,
  roles: PERMISSIONS['clerk.use'],
  idempotent: true,
  timeoutSeconds: 300,
  handler: async (ctx): Promise<AcceptManySuggestionsResult> => {
    const clock = await orgClock(ctx.db, ctx.orgId, ctx.clock);
    await requireFlag({ orgId: ctx.orgId, db: ctx.db, clock }, 'clerk.features.suggestions');
    const results: AcceptManyItemResult[] = [];
    for (const suggestionId of [...new Set(ctx.input.suggestionIds)]) {
      try {
        const result = await acceptSuggestion(ctx, clock, { matterId: ctx.input.matterId, suggestionId, bulk: true });
        results.push({ ok: true, ...result });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        results.push({
          ok: false,
          suggestionId,
          code: error.code,
          ...(error.details ? { details: { ...error.details } } : {}),
        });
      }
    }
    const accepted = results.filter((result) => result.ok).length;
    return { results, accepted, failed: results.length - accepted };
  },
} satisfies CallableDefinition<typeof AcceptManySuggestionsInput, AcceptManySuggestionsResult>;

export const accept = defineCallable(acceptDefinition);
export const acceptMany = defineCallable(acceptManyDefinition);
