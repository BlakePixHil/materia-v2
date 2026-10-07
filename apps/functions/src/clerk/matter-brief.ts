import type { Firestore } from 'firebase-admin/firestore';
import type * as z from 'zod';

import type { MatterBriefOutput } from '@materia/clerk';
import {
  briefRefreshesLeft,
  can,
  checkBrief,
  DEFAULT_ORG_TIMEZONE,
  DocIdSchema,
  DomainError,
  MATTER_BRIEF_CALLABLES,
  MATTER_BRIEF_DOC_ID,
  MATTER_BRIEF_LEASE_SECONDS,
  MATTER_BRIEF_ORG_DAILY_LIMIT,
  MATTER_BRIEF_PROMPT,
  MATTER_BRIEF_RETRY_MINUTES,
  MatterBrief,
  MatterBriefInputSchema,
  matterBriefStale,
  PERMISSIONS,
  resolveBriefItem,
  templateBrief,
  today,
  type BriefItem,
  type BriefTemplateReason,
  type MatterBriefFactSet,
  type MatterBriefResult,
  type MatterBriefView,
} from '@materia/domain';

import { defineCallable, type CallableDefinition } from '../core/callable';
import { dateOf, readMatterBriefFacts } from './context/brief-facts';
import type { ContextBuilder } from './context/build-context';
import { firestoreContextSource } from './context/firestore-source';
import type { ContextSource } from './context/ports';
import { clerkContext } from './context/service';
import type { ClerkGateway, GatewayContext } from './gateway';
import { clerkGateway } from './service';

type Data = Record<string, unknown>;
type Brief = z.output<typeof MatterBrief.schema>;

/** `matters/{matterId}/briefs/latest`. */
export const matterBriefPath = (orgId: string, matterId: string) =>
  `orgs/${orgId}/matters/${matterId}/briefs/${MATTER_BRIEF_DOC_ID}`;
/** The org's count of Clerk-written matter briefs for the day (server-only). */
export const matterBriefCounterPath = (orgId: string) => `orgs/${orgId}/counters/clerk-matter-briefs`;

const MINUTE_MS = 60_000;

/** Codes that mean the person can't have this brief at all: they are thrown, never turned into a template. */
const ACCESS_CODES = new Set(['NOT_FOUND', 'ACCESS_REVOKED', 'PERMISSION_DENIED', 'UNAUTHENTICATED']);

/** Why Clerk didn't write it, from the gateway's error. */
function reasonOf(error: unknown): BriefTemplateReason {
  const code = error instanceof DomainError ? error.code : undefined;
  if (code === 'CLERK_DISABLED') return 'off';
  if (code === 'CLERK_BUDGET_EXCEEDED' || code === 'CLERK_RATE_LIMITED') return 'limit';
  return 'failed';
}

/** A kept brief as stored, with its instants as Dates (Firestore gives Timestamps); null if unreadable. */
function keptOf(data: Data | undefined): Brief | null {
  if (!data) return null;
  const instants: Data = {};
  for (const key of ['createdAt', 'updatedAt', 'generatedAt', 'pendingUntil', 'retryAfter']) {
    const at = dateOf(data[key]);
    if (at) instants[key] = at;
  }
  const items = Array.isArray(data['items'])
    ? (data['items'] as Data[]).map((item) => {
        const at = dateOf(item['at']);
        return at ? { ...item, at } : item;
      })
    : data['items'];
  const parsed = MatterBrief.schema.safeParse({ ...data, ...instants, items });
  return parsed.success ? parsed.data : null;
}

/** The brief, checked against its schema, with no `undefined` fields (Firestore rejects them). */
function defined(brief: Data): Brief {
  const parsed = MatterBrief.schema.parse(brief);
  const strip = (value: Data) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
  return { ...strip(parsed), items: parsed.items.map((item) => strip(item)) } as Brief;
}

export function matterBriefView(brief: Brief, day: string, now: Date): MatterBriefView {
  return {
    source: brief.source,
    ...(brief.reason ? { reason: brief.reason } : {}),
    headline: brief.headline,
    items: brief.items.map(({ at, ...item }) => ({ ...item, ...(at ? { at: at.toISOString() } : {}) })),
    read: brief.read,
    day: brief.day,
    privileged: brief.privileged,
    generatedAt: brief.generatedAt.toISOString(),
    pending: !!brief.pendingUntil && brief.pendingUntil > now,
    refreshesLeft: briefRefreshesLeft(brief.refreshes, day),
  };
}

export interface MatterBriefDeps {
  db: Firestore;
  /** The reads behind the facts (the same as `buildContext`'s). */
  source: ContextSource;
  gateway: Pick<ClerkGateway, 'run' | 'assertOn'>;
  context: ContextBuilder;
}

/**
 * The brief on a matter's Overview (AI-06c, ADR-059), shared by everyone who can read the matter.
 * Every call reads the facts (`matterBriefFacts`), which is also how a kept brief is known to be
 * stale (another hash, a new day, over 24 hours old). Then, in one transaction: a fresh brief is
 * kept; one another call is writing is left to it; otherwise the template brief is written and,
 * when this person may use Clerk and the org's switches, its daily cap and the facts allow, the
 * call claims the brief (`pendingUntil`) and asks Clerk. Clerk's reply must pass `checkBrief`; when
 * it doesn't, or Clerk fails, the template stays, with a retry after MATTER_BRIEF_RETRY_MINUTES.
 * `refresh` rebuilds a fresh brief too, three times a day per matter. Read-only: nothing on the
 * matter changes, and the brief's actions open records and suggestions that already exist.
 */
export async function matterBriefFor(
  deps: MatterBriefDeps,
  ctx: GatewayContext,
  input: z.output<typeof MatterBriefInputSchema>,
): Promise<MatterBriefResult> {
  const { orgId, uid } = ctx;
  const { matterId, mode } = input;
  if (!DocIdSchema.safeParse(matterId).success) throw new DomainError('INVALID_ARGUMENT', 'Invalid id');

  // 1. The matter, as the rules would read it for this role (privileged matters need privileged.view).
  const matter = await deps.source.matter(orgId, matterId);
  const data = matter?.data ?? {};
  const matterPrivileged = data['privileged'] === true;
  const gone = (data['deletedAt'] ?? null) !== null || (data['destroyedAt'] ?? null) !== null;
  if (!matter || gone || !can(ctx.role, 'matter.view', { privileged: matterPrivileged }))
    throw new DomainError('NOT_FOUND', 'Matter not found', { matterId });

  // 2. Whether Clerk may write it for this person: their role, the flags, the org's switches and
  // its acknowledgement of the disclosure.
  let clerk: 'on' | BriefTemplateReason = can(ctx.role, 'clerk.use') ? 'on' : 'role';
  if (clerk === 'on')
    await deps.gateway.assertOn(ctx, 'matterBrief').catch((error: unknown) => {
      if (error instanceof DomainError && error.code === 'CLERK_DISABLED') clerk = 'off';
      else throw error;
    });

  // 3. The facts, read on every call: their hash is the staleness check.
  const now = ctx.clock.now();
  const timeZone = (await deps.source.orgTimeZone(orgId)) ?? DEFAULT_ORG_TIMEZONE;
  const day = today(timeZone, now);
  const set = await readMatterBriefFacts(deps.source, { orgId, matterId, matterPrivileged, today: day, now, timeZone });
  const ref = deps.db.doc(matterBriefPath(orgId, matterId));
  const counterRef = deps.db.doc(matterBriefCounterPath(orgId));

  const docOf = (
    brief: { headline: string; items: BriefItem[] },
    facts: MatterBriefFactSet,
    extra: Partial<Brief> & Pick<Brief, 'source'>,
    kept: Brief | null,
  ): Brief =>
    defined({
      headline: brief.headline,
      items: brief.items,
      read: facts.read,
      day,
      factsHash: facts.hash,
      privileged: matterPrivileged,
      generatedAt: now,
      generatedBy: uid,
      createdAt: kept?.createdAt ?? now,
      createdBy: kept?.createdBy ?? uid,
      updatedAt: now,
      updatedBy: uid,
      schemaVersion: MatterBrief.version,
      ...extra,
    });
  const template = (facts: MatterBriefFactSet) => {
    const drafted = templateBrief(facts);
    return {
      headline: drafted.headline,
      items: drafted.items.map((item) => resolveBriefItem(item, facts)).filter((item): item is BriefItem => !!item),
    };
  };

  // An archived matter (CORE-19) takes no writes: its template brief is shown without being kept.
  if (data['status'] === 'archived') {
    const brief = docOf(template(set), set, { source: 'template' }, null);
    return { brief: { ...matterBriefView(brief, day, now), refreshesLeft: 0 }, outcome: 'kept' };
  }

  // 4. Keep, leave it to another call, write the template, or claim it for Clerk.
  type Plan = { kind: 'kept' | 'pending' | 'written' | 'claimed'; brief: Brief };
  const plan = await deps.db.runTransaction(async (tx): Promise<Plan> => {
    const snap = await tx.get(ref);
    const kept = snap.exists ? keptOf(snap.data()) : null;
    if (mode === 'refresh' && briefRefreshesLeft(kept?.refreshes, day) === 0)
      throw new DomainError('RATE_LIMITED', 'This matter’s brief has been refreshed as often as it can be today', {
        perDay: briefRefreshesLeft(undefined, day),
      });
    if (kept?.pendingUntil && kept.pendingUntil > now) return { kind: 'pending', brief: kept };
    const wantsClerk = clerk === 'on' && !set.quiet;
    // After a failure or a limit, opening the matter waits; Refresh (three a day) tries again.
    const waiting = mode === 'open' && !!kept?.retryAfter && kept.retryAfter > now;
    // A matter made privileged (or not) since makes its brief stale too: the brief follows the matter.
    if (mode === 'open' && kept && kept.privileged === matterPrivileged && !matterBriefStale(kept, set.hash, now)) {
      // Clerk's own brief stays while Clerk may write; once it is switched off, the template replaces it.
      if (kept.source === 'clerk' ? clerk !== 'off' : !wantsClerk || waiting) return { kind: 'kept', brief: kept };
    }
    const refreshes =
      mode === 'refresh'
        ? { day, count: (kept?.refreshes?.day === day ? kept.refreshes.count : 0) + 1 }
        : kept?.refreshes?.day === day
          ? kept.refreshes
          : undefined;
    const base: Partial<Brief> = refreshes ? { refreshes } : {};
    let reason: BriefTemplateReason | undefined;
    let retryAfter: Date | undefined;
    if (clerk !== 'on') reason = clerk;
    else if (set.quiet) reason = 'quiet';
    else if (waiting) {
      reason = kept?.reason ?? 'failed';
      retryAfter = kept?.retryAfter;
    } else {
      const counter = (await tx.get(counterRef)).data();
      const used = counter?.['day'] === day && typeof counter['count'] === 'number' ? counter['count'] : 0;
      if (used >= MATTER_BRIEF_ORG_DAILY_LIMIT) {
        reason = 'limit';
        retryAfter = new Date(now.getTime() + MATTER_BRIEF_RETRY_MINUTES * MINUTE_MS);
      } else {
        // Claimed: the template shows until Clerk's brief replaces it.
        tx.set(counterRef, { day, count: used + 1, updatedAt: now });
        const pendingUntil = new Date(now.getTime() + MATTER_BRIEF_LEASE_SECONDS * 1000);
        const brief = docOf(template(set), set, { source: 'template', pendingUntil, ...base }, kept);
        tx.set(ref, brief);
        return { kind: 'claimed', brief };
      }
    }
    const brief = docOf(
      template(set),
      set,
      { source: 'template', reason, ...(retryAfter ? { retryAfter } : {}), ...base },
      kept,
    );
    tx.set(ref, brief);
    return { kind: 'written', brief };
  });

  if (plan.kind !== 'claimed') {
    if (plan.kind === 'written')
      ctx.log.info('matter brief', {
        matterId,
        mode,
        source: 'template',
        reason: plan.brief.reason,
        items: plan.brief.items.length,
      });
    return {
      brief: matterBriefView(plan.brief, day, now),
      outcome: plan.kind === 'written' ? 'rebuilt' : plan.kind,
    };
  }

  // 5. Clerk writes it from the same facts (`buildContext`'s brief policy), and the checks decide
  // what of its reply is kept.
  const claimed = plan.brief;
  const keep = claimed.refreshes ? { refreshes: claimed.refreshes } : {};
  const fallback = async (reason: BriefTemplateReason, facts: MatterBriefFactSet) => {
    const brief = docOf(
      template(facts),
      facts,
      {
        source: 'template',
        reason,
        retryAfter: new Date(now.getTime() + MATTER_BRIEF_RETRY_MINUTES * MINUTE_MS),
        ...keep,
      },
      claimed,
    );
    await ref.set(brief);
    return { brief: matterBriefView(brief, day, now), outcome: 'rebuilt' as const };
  };
  try {
    const context = await deps.context.buildContext({ ctx, scope: { matterId }, feature: 'matterBrief' });
    const facts = context.brief ?? set;
    const result = await deps.gateway.run<MatterBriefOutput>({
      ctx,
      feature: 'matterBrief',
      promptId: MATTER_BRIEF_PROMPT,
      vars: { today: facts.facts.today },
      context,
    });
    if (result.status !== 'done' || !result.parsed) {
      ctx.log.warn('matter brief not written', {
        matterId,
        status: result.status,
        promptRef: result.promptRef,
        costMicros: result.costMicros,
      });
      return await fallback('failed', facts);
    }
    const checked = checkBrief(result.parsed, facts);
    // Metadata only: what the checks dropped and what it cost, never the brief's text.
    ctx.log.info('matter brief', {
      matterId,
      mode,
      source: 'clerk',
      items: checked.items.length,
      written: Array.isArray(result.parsed.items) ? result.parsed.items.length : 0,
      dropped: checked.dropped,
      headlineReplaced: checked.headlineReplaced,
      promptRef: result.promptRef,
      model: result.model,
      costMicros: result.costMicros,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
    if (!checked.items.length) return await fallback('failed', facts);
    const brief = docOf(
      checked,
      facts,
      {
        source: 'clerk',
        promptRef: result.promptRef,
        model: result.model,
        privileged: matterPrivileged || result.privileged === true,
        ...keep,
      },
      claimed,
    );
    await ref.set(brief);
    return { brief: matterBriefView(brief, day, now), outcome: 'rebuilt' };
  } catch (error) {
    if (error instanceof DomainError && ACCESS_CODES.has(error.code)) {
      // Release the claim (the template stays), then say why.
      const released: Brief = { ...claimed };
      delete released.pendingUntil;
      await ref.set(released).catch(() => undefined);
      throw error;
    }
    ctx.log.warn('matter brief fell back to the template', {
      matterId,
      code: error instanceof DomainError ? error.code : 'error',
    });
    return await fallback(reasonOf(error), set);
  }
}

/**
 * `clerk-matterBrief` (AI-06c): the brief card on a matter's Overview. Any role that can read the
 * matter gets a brief; only roles that may use Clerk get one Clerk writes (the others, and every
 * org with Clerk or the feature off, get the template brief).
 */
export const matterBriefDefinition = {
  name: MATTER_BRIEF_CALLABLES.brief,
  input: MatterBriefInputSchema,
  roles: PERMISSIONS['matter.view'],
  timeoutSeconds: 90,
  handler: ({ input, uid, orgId, role, requestId, log, clock, db, ports }) =>
    matterBriefFor(
      {
        db,
        source: firestoreContextSource(db),
        gateway: clerkGateway({ db, ports, clock }),
        context: clerkContext({ db, embedding: ports.embedding }),
      },
      { orgId, uid, role, requestId, log, clock },
      input,
    ),
} satisfies CallableDefinition<typeof MatterBriefInputSchema, MatterBriefResult>;

export const matterBrief = defineCallable(matterBriefDefinition);
