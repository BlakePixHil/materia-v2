import type { DocumentReference, Firestore } from 'firebase-admin/firestore';

import {
  CLERK_DEFAULT_DRAFTING_STYLE,
  clerkDraftType,
  DOC_BODY_MAX,
  DomainError,
  missingDraftFacts,
  type ClerkDraftAudience,
  type ClerkDraftRecipient,
  type ClerkDraftType,
  type Role,
} from '@materia/domain';

import type { Log } from '../../core/log';
import type { Clock } from '../../ports';
import type { ContextBuilder } from '../context/build-context';
import { escapeFraming } from '../context/framing';
import { STREAM_FLUSH_MS } from '../features';
import type { ClerkGateway, ClerkRunResult, GatewayContext } from '../gateway';
import type { MessageSink } from '../store';

type Data = Record<string, unknown>;

/** Rewriting one passage of a draft (AI-10). The whole letter uses its type's `promptId`. */
export const DRAFT_REWRITE_PROMPT = 'drafting-rewrite@1.0.0';

/** What the queue carries: one draft to write (`clerk-startDraft` or `clerk-redraft` set it up). */
export interface DraftRunTask {
  orgId: string;
  matterId: string;
  draftId: string;
  uid: string;
  role: Role;
  /** The request that started this run: the draft's `runId` while it is still the current one. */
  requestId: string;
}

export interface DraftRunDeps {
  db: Firestore;
  clock: Clock;
  log: Log;
  gateway: ClerkGateway;
  context: ContextBuilder;
}

export type DraftRunOutcome = 'drafted' | 'skipped' | 'failed';

/** Who the letter is for, as the prompts say it. */
export const AUDIENCE_PHRASES: Record<ClerkDraftAudience, string> = {
  client: 'to our client',
  third_party: 'to a third party (not our client)',
};

/** The firm's house style (Settings → Clerk and AI), or the default. */
export function houseStyle(settings: Data | undefined): string {
  const style = settings?.['draftingStyle'];
  return typeof style === 'string' && style.trim() ? style.trim() : CLERK_DEFAULT_DRAFTING_STYLE;
}

/** The recipients as the prompt lists them: name, role and address, or that the address is missing. */
export function recipientLines(recipients: readonly ClerkDraftRecipient[]): string {
  if (!recipients.length) return 'No one chosen: use a general salutation ("Dear Sir or Madam").';
  return recipients
    .map((recipient) => {
      const role = recipient.role ? ` (${recipient.role.replace(/_/g, ' ')} on the matter)` : '';
      const address = recipient.address ? `, at ${recipient.address.split('\n').join(', ')}` : ' (no address on file)';
      return `- ${escapeFraming(recipient.name)}${role}${escapeFraming(address)}`;
    })
    .join('\n');
}

/** The drafting prompt's variables (`drafting@1.0.0`). Shared with the evals, so they draft as production does. */
export function draftingVars(input: {
  type: ClerkDraftType;
  recipients: readonly ClerkDraftRecipient[];
  missing: readonly string[];
  instructions: string;
  houseStyle: string;
}): Record<string, string> {
  return {
    typeTitle: input.type.title,
    audience: AUDIENCE_PHRASES[input.type.audience],
    guidance: input.type.guidance,
    recipients: `\n${recipientLines(input.recipients)}`,
    missingFacts: input.missing.length ? input.missing.join('; ') : 'nothing known to be missing',
    instructions: input.instructions.trim() || 'none',
    houseStyle: input.houseStyle,
  };
}

/** The rewrite prompt's variables (`drafting-rewrite@1.0.0`). Shared with the evals, so they rewrite as production does. */
export function rewriteVars(input: {
  type: ClerkDraftType;
  before: string;
  selection: string;
  after: string;
  instruction: string;
  houseStyle: string;
}): Record<string, string> {
  return {
    houseStyle: input.houseStyle,
    typeTitle: input.type.title,
    audience: AUDIENCE_PHRASES[input.type.audience],
    before: escapeFraming(input.before),
    selection: escapeFraming(input.selection),
    after: escapeFraming(input.after),
    instruction: input.instruction.trim() || REWRITE_DEFAULT_INSTRUCTION,
  };
}

/** What a rewrite asks for when the person typed nothing. */
export const REWRITE_DEFAULT_INSTRUCTION = 'Improve the wording.';

/** What retrieval looks for: the letter type, the instructions and who it's to. */
export function draftQuery(
  type: ClerkDraftType,
  instructions: string,
  recipients: readonly { name: string }[],
): string {
  return [type.title, instructions.trim(), ...recipients.map((recipient) => recipient.name)]
    .filter(Boolean)
    .join('. ')
    .slice(0, 2_000);
}

/**
 * Third-party letters leave privileged material out of Clerk's context unless the person allowed
 * it when starting the draft (AI-10 guardrail); a letter to the client may draw on it.
 */
export const withholdsPrivileged = (type: ClerkDraftType, includePrivileged: boolean) =>
  type.audience === 'third_party' && !includePrivileged;

/**
 * A sink that streams Clerk's text into the draft's `bodyMd` (at most every STREAM_FLUSH_MS) and
 * stops when the owner sets `stopRequested` (listened to from the first `onStop` until `close`).
 * `finish` only waits for the last write: `runDraft` writes the finished draft itself.
 */
export function draftSink(ref: DocumentReference, now: () => number): MessageSink {
  let latest = '';
  let flushed = '';
  let flushedAt = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const listeners: (() => void)[] = [];
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  const listen = () => {
    if (unsubscribe || closed) return;
    unsubscribe = ref.onSnapshot(
      (snapshot) => {
        if (!stopped && snapshot.get('stopRequested') === true) {
          stopped = true;
          for (const listener of listeners) listener();
        }
      },
      () => undefined,
    );
  };
  return {
    write(text) {
      latest = text.slice(0, DOC_BODY_MAX);
      if (now() - flushedAt < STREAM_FLUSH_MS || latest === flushed) return;
      const body = latest;
      flushed = body;
      flushedAt = now();
      chain = chain.then(() => ref.update({ bodyMd: body })).catch(() => undefined);
    },
    onStop(listener) {
      listeners.push(listener);
      listen();
      if (stopped) listener();
    },
    tools() {
      // Drafting offers no tools.
    },
    async finish() {
      await chain;
    },
    close() {
      closed = true;
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

/** The draft's status from how the call ended: a letter cut short is still a draft to finish. */
function draftStatus(result: ClerkRunResult): 'ready' | 'stopped' | 'error' {
  if (result.status === 'done' || result.status === 'truncated') return 'ready';
  if (result.status === 'stopped') return 'stopped';
  return 'error';
}

/**
 * Writes one draft letter (AI-10, ADR-050), server-side, so it carries on when the person
 * navigates away. The draft already exists as `drafting`; this:
 * 1. builds the matter context (AI-03), leaving privileged material out of a letter to a third
 *    party unless the person allowed it;
 * 2. works out which of the type's facts the matter lacks, so Clerk leaves placeholders for them;
 * 3. streams the letter into `bodyMd` through the gateway (the type's prompt, the firm's house style);
 * 4. writes the finished draft: the text Clerk wrote (also kept as `generatedMd`), all of it Clerk's
 *    in `provenance`, the verified sources, the missing facts, and whether it drew on privileged
 *    material (Clerk rule 6).
 * Expected failures (Clerk switched off, over budget, rate limited) end the draft as `error` with
 * the code. Never throws: a redelivered task, or one a redraft replaced, does nothing.
 */
export async function runDraft(deps: DraftRunDeps, task: DraftRunTask, attempt = 0): Promise<DraftRunOutcome> {
  const { db, log } = deps;
  const ref = db.doc(`orgs/${task.orgId}/matters/${task.matterId}/clerkDrafts/${task.draftId}`);
  const draft = (await ref.get()).data() as Data | undefined;
  if (!draft || draft['status'] !== 'drafting' || draft['runId'] !== task.requestId) {
    log.info('clerk draft skipped', { draftId: task.draftId });
    return 'skipped';
  }
  // A redelivery after an instance died mid-draft: don't call the model twice.
  if (attempt > 0) {
    await fail(deps, ref, task, new DomainError('CLERK_UNAVAILABLE', 'The draft was interrupted'));
    return 'failed';
  }
  if (draft['stopRequested'] === true) {
    await settle(db, ref, task, { status: 'stopped', updatedAt: deps.clock.now() });
    return 'skipped';
  }

  const ctx: GatewayContext = {
    orgId: task.orgId,
    uid: task.uid,
    role: task.role,
    requestId: task.requestId,
    log,
    clock: deps.clock,
  };
  try {
    const type = clerkDraftType(String(draft['typeId']));
    if (!type) throw new DomainError('NOT_FOUND', 'That kind of letter no longer exists');
    const recipients = (draft['recipients'] as ClerkDraftRecipient[] | undefined) ?? [];
    const instructions = typeof draft['instructions'] === 'string' ? draft['instructions'] : '';
    const context = await deps.context.buildContext({
      ctx,
      scope: { matterId: task.matterId },
      feature: 'drafting',
      query: draftQuery(type, instructions, recipients),
      withholdPrivileged: withholdsPrivileged(type, draft['includePrivileged'] === true),
    });
    const missing = missingDraftFacts(type, context.facts ?? {});
    const settings = (await db.doc(`orgs/${task.orgId}`).get()).get('settings.clerk') as Data | undefined;
    const sink = draftSink(ref, () => deps.clock.now().getTime());
    let result: ClerkRunResult;
    try {
      result = await deps.gateway.run({
        ctx,
        feature: 'drafting',
        promptId: type.promptId,
        vars: draftingVars({ type, recipients, missing, instructions, houseStyle: houseStyle(settings) }),
        context,
        sink,
      });
    } finally {
      sink.close();
    }

    const status = draftStatus(result);
    const text = (result.text ?? '').slice(0, DOC_BODY_MAX);
    const privileged = result.privileged ?? context.manifest.privileged;
    await settle(db, ref, task, {
      status,
      bodyMd: text,
      generatedMd: text,
      provenance: text ? [{ origin: 'clerk', length: text.length }] : [],
      citations: result.citations.filter((citation) => citation.verified !== false),
      missingFacts: missing,
      privileged,
      manifest: result.manifest ?? context.manifest,
      promptId: result.promptRef,
      model: result.model,
      truncated: result.status === 'truncated',
      ...(status === 'error'
        ? { error: { code: result.status === 'refused' ? 'CLERK_REFUSED' : 'CLERK_UNAVAILABLE' } }
        : {}),
      updatedAt: deps.clock.now(),
    });
    log.info('clerk draft written', {
      draftId: task.draftId,
      typeId: type.id,
      status: result.status,
      missing: missing.length,
      privileged,
    });
    return status === 'error' ? 'failed' : 'drafted';
  } catch (error) {
    await fail(deps, ref, task, error);
    return 'failed';
  }
}

/** Changes a draft only while it is still this run's and drafting (a finished or redrafted one is never touched). */
async function settle(db: Firestore, ref: DocumentReference, task: DraftRunTask, patch: Data): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.get('status') !== 'drafting' || snap.get('runId') !== task.requestId) return false;
    tx.update(ref, patch);
    return true;
  });
}

/** Records why a draft failed: the code (and the switch, for CLERK_DISABLED) for the editor's copy. */
async function fail(deps: DraftRunDeps, ref: DocumentReference, task: DraftRunTask, error: unknown): Promise<void> {
  const known = error instanceof DomainError;
  const code = known ? error.code : 'INTERNAL';
  const flag = known ? (error.details as { switch?: unknown } | undefined)?.switch : undefined;
  if (known) deps.log.warn('clerk draft failed', { draftId: ref.id, code });
  else deps.log.error('clerk draft failed', { draftId: ref.id, code });
  try {
    const snap = await ref.get();
    // What Clerk wrote before the failure stays, as Clerk's.
    const body = typeof snap.get('bodyMd') === 'string' ? (snap.get('bodyMd') as string) : '';
    await settle(deps.db, ref, task, {
      status: 'error',
      error: { code, ...(typeof flag === 'string' ? { switch: flag } : {}) },
      provenance: body ? [{ origin: 'clerk', length: body.length }] : [],
      updatedAt: deps.clock.now(),
    });
  } catch {
    deps.log.error('clerk draft failure not recorded', { draftId: ref.id });
  }
}
