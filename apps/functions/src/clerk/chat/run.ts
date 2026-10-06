import type { DocumentReference, Firestore } from 'firebase-admin/firestore';

import { clerkModelFor, type ChatProposalsOutput } from '@materia/clerk';
import {
  canAcceptSuggestion,
  defaultDedupeKey,
  DomainError,
  parseClerkCommand,
  type ClerkChatCommand,
  type ContextManifest,
  type FlagKey,
  type Role,
  type SuggestionPayload,
  type SuggestionProposal,
} from '@materia/domain';

import type { Log } from '../../core/log';
import type { ClerkContentBlock, Clock } from '../../ports';
import { proposeSuggestions } from '../../suggestions/propose';
import type { ClerkContext, ContextBuilder } from '../context/build-context';
import { escapeFraming, wrap } from '../context/framing';
import type { ClerkGateway, ClerkRunResult, GatewayContext } from '../gateway';
import { loadHistory, messageText, threadMessages, transcript, type ThreadMessage } from './history';
import { createChatToolbox, type ChatDrafter, type ChatToolDeps, type ToolUsage } from './tools';

type Data = Record<string, unknown>;

/** The chat prompt (AI-06) and its follow-on steps. */
export const CHAT_PROMPT = 'chat@1.1.0';
export const CHAT_PROPOSALS_PROMPT = 'chat-proposals@1.0.0';
export const CHAT_SUMMARY_PROMPT = 'chat-summary@1.0.0';

/** What the queue carries: one answer to write (`clerk-sendMessage` or `clerk-retryMessage` created it). */
export interface ChatRunTask {
  orgId: string;
  threadId: string;
  messageId: string;
  uid: string;
  role: Role;
  requestId: string;
}

export interface ChatRunDeps {
  db: Firestore;
  clock: Clock;
  log: Log;
  gateway: ClerkGateway;
  context: ContextBuilder;
  tools: ChatToolDeps;
  flag: (orgId: string, key: FlagKey) => Promise<boolean>;
}

/** The line before the question in the chat prompt, by command (the evals ask plain questions). */
export const CHAT_TASKS: Record<ClerkChatCommand | 'question', string> = {
  question: 'The person asks:',
  summarise:
    'The person used /summarise: summarise this matter for them, citing your sources, then answer what they add:',
  chronology: 'The person asks:',
  draft: 'The person asks:',
  timeline: 'The person asks:',
};

export type ChatRunOutcome = 'answered' | 'skipped' | 'failed';

/** Why a drafted suggestion exists, shown on its card (AI-06b). */
export const DRAFT_RATIONALE = 'You asked Clerk for this in the chat.';

/**
 * Writes one Clerk answer (AI-06, ADR-044), server-side, so it carries on when the person
 * navigates away. The answer message already exists as `streaming`; this:
 * 1. builds the context for the question (AI-03: scope and privilege enforced in code);
 * 2. replays the conversation's earlier exchanges unchanged (or, in a continued thread's first
 *    question, a summary of the thread it continues);
 * 3. runs the gateway in stream mode with the read-only tools, into the existing message; with
 *    suggestions on, also the drafting tools (AI-06b), which turn the person's "add a file note
 *    saying …" into a suggestion as Clerk answers;
 * 4. records what the tools showed (manifest, privilege) and marks the thread privileged when the
 *    answer is (Clerk rule 6);
 * 5. links the drafts from the message or, when Clerk didn't draft, asks for proposals
 *    (structured output) and turns them into suggestions (AI-07). A failure here never fails the
 *    answer.
 * Expected failures (Clerk switched off, over budget, rate limited) end the message as `error`
 * with the code, so the panel can say why and offer the manual path. Never throws: a redelivered
 * task finds the message finished and does nothing.
 */
export async function runChatMessage(deps: ChatRunDeps, task: ChatRunTask, attempt = 0): Promise<ChatRunOutcome> {
  const { db, log } = deps;
  const threadRef = db.doc(`orgs/${task.orgId}/clerkThreads/${task.threadId}`);
  const messageRef = threadRef.collection('messages').doc(task.messageId);
  const [threadSnap, messageSnap] = await Promise.all([threadRef.get(), messageRef.get()]);
  const thread = threadSnap.data() as Data | undefined;
  const message = messageSnap.data() as Data | undefined;
  if (!thread || !message || message['status'] !== 'streaming') {
    log.info('clerk chat skipped', { threadId: task.threadId, messageId: task.messageId });
    return 'skipped';
  }
  // A redelivery after an instance died mid-answer: don't call the model twice.
  if (attempt > 0) {
    await fail(deps, messageRef, new DomainError('CLERK_UNAVAILABLE', 'The answer was interrupted'));
    return 'failed';
  }
  if (message['stopRequested'] === true) {
    await settle(db, messageRef, { status: 'stopped', updatedAt: deps.clock.now() });
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
  // What Clerk drafted before a failure stays linked from the answer, so its cards still show.
  let drafted: readonly string[] = [];
  try {
    const matterId = thread['matterId'];
    if (typeof matterId !== 'string') throw new DomainError('NOT_FOUND', 'This thread has no matter');
    const messages = await threadMessages(db, task.orgId, task.threadId);
    const question = messages.find((m) => m.id === message['replyTo'] && m.data['role'] === 'user');
    if (!question) throw new DomainError('NOT_FOUND', 'The question is missing');
    const text = messageText(question.data);
    const parsed = parseClerkCommand(text);
    const attachments = (question.data['attachments'] as string[] | undefined) ?? [];

    const context = await deps.context.buildContext({
      ctx,
      scope: { matterId },
      feature: 'chat',
      attachments,
      query: parsed.question,
    });
    const model = clerkModelFor((await db.doc(`orgs/${task.orgId}`).get()).get('settings.clerk.model'));
    const history = await loadHistory(db, task.orgId, task.threadId, messages, { before: question.id, model });
    const prelude = history.exchanges ? [] : await continuation(deps, ctx, thread);
    // The answer is privileged when its context or a tool drew on privileged material; the thread
    // is privileged once any answer is (Clerk rule 6). Marked as soon as it is known.
    let privileged = context.manifest.privileged;
    const draft = (await deps.flag(task.orgId, 'clerk.features.suggestions'))
      ? drafter(
          deps,
          ctx,
          matterId,
          { questionId: question.id, model, role: context.manifest.role },
          () => privileged || thread['privileged'] === true,
        )
      : undefined;
    const toolbox = createChatToolbox(
      deps.tools,
      { orgId: task.orgId, matterId, role: context.manifest.role },
      {
        onPrivileged: async () => {
          if (privileged) return;
          privileged = true;
          await markPrivileged(threadRef, messageRef);
        },
        ...(draft ? { draft } : {}),
      },
    );
    drafted = toolbox.usage.drafted;
    if (privileged) await markPrivileged(threadRef, messageRef);

    const result = await deps.gateway.run({
      ctx,
      feature: 'chat',
      promptId: CHAT_PROMPT,
      vars: { task: CHAT_TASKS[parsed.command ?? 'question'], question: parsed.question },
      context,
      history,
      prelude,
      tools: toolbox,
      stream: { threadId: task.threadId, messageId: task.messageId, adopt: true },
    });
    const manifest = withToolUsage(context.manifest, toolbox.usage, privileged);
    await messageRef.update({ manifest, privileged });
    log.info('clerk chat answered', {
      threadId: task.threadId,
      messageId: task.messageId,
      status: result.status,
      exchanges: history.exchanges,
      skippedExchanges: history.skipped,
      tools: toolbox.usage.chunks.length + toolbox.usage.records.length,
      privileged,
    });

    // When the person asked Clerk to draft something, the drafts are the answer's suggestions;
    // otherwise the proposals step looks for changes the answer points to.
    const ids = toolbox.usage.drafting
      ? toolbox.usage.drafted
      : result.status === 'done'
        ? await propose(
            deps,
            ctx,
            matterId,
            { question: parsed.question, answer: result, context, manifest },
            privileged,
          )
        : [];
    if (ids.length) await messageRef.update({ suggestionIds: ids });
    return 'answered';
  } catch (error) {
    await fail(deps, messageRef, error);
    if (drafted.length) await messageRef.update({ suggestionIds: [...drafted] }).catch(() => undefined);
    return 'failed';
  }
}

/**
 * The drafting tools' writer (AI-06b): one suggestion per draft, through `proposeSuggestions`
 * (AI-07), so it is validated, de-duplicated and expires like any other. Its `dedupeKey` is scoped
 * to the question, so a retry finds the draft it already made instead of drafting it again, and a
 * person can ask again later for a note they dismissed before. A draft is privileged when anything
 * Clerk had seen by then was: the context, an earlier answer in the thread, or a tool's result. A
 * draft the asker's role couldn't accept isn't made.
 */
function drafter(
  deps: ChatRunDeps,
  ctx: GatewayContext,
  matterId: string,
  source: { questionId: string; model: string; role: Role },
  privileged: () => boolean,
): ChatDrafter {
  const [promptId, promptVersion] = CHAT_PROMPT.split('@') as [string, string];
  return async (draft) => {
    // Never a card the person who asked couldn't accept.
    if (!canAcceptSuggestion(source.role, draft.kind, privileged())) return { status: 'not_allowed' };
    const result = await proposeSuggestions(
      { db: deps.db, orgId: ctx.orgId, clock: deps.clock, log: ctx.log },
      matterId,
      [
        {
          ...draft,
          rationale: DRAFT_RATIONALE,
          dedupeKey: `ask:${source.questionId}:${defaultDedupeKey(draft as SuggestionPayload)}`.slice(0, 500),
        },
      ],
      { privileged: privileged(), promptId, promptVersion, model: source.model },
    );
    const created = result.created[0];
    if (created) return { status: 'drafted', suggestionId: created.id };
    return { status: result.skipped[0]?.reason ?? 'invalid' };
  };
}

/** Marks the answer and its thread privileged (Clerk rule 6). */
async function markPrivileged(threadRef: DocumentReference, messageRef: DocumentReference): Promise<void> {
  await Promise.all([messageRef.update({ privileged: true }), threadRef.update({ privileged: true })]);
}

/** The context's manifest plus what the tools showed, for audit (ids only). */
function withToolUsage(manifest: ContextManifest, usage: ToolUsage, privileged: boolean): ContextManifest {
  const chunkKey = (c: { documentId: string; version: number; page: number }) =>
    `${c.documentId}|${c.version}|${c.page}`;
  const chunks = new Map(manifest.chunks.map((c) => [chunkKey(c), c]));
  for (const chunk of usage.chunks) chunks.set(chunkKey(chunk), chunk);
  const records = new Map(manifest.records.map((r) => [`${r.kind}|${r.id}`, r]));
  for (const record of usage.records)
    if (!records.has(`${record.kind}|${record.id}`)) records.set(`${record.kind}|${record.id}`, record);
  return { ...manifest, privileged, chunks: [...chunks.values()], records: [...records.values()] };
}

/**
 * A continued thread's first question carries a summary of the thread it continues (AI-06), made
 * once and kept server-side. Without one (the summary failed), the question goes alone.
 */
async function continuation(deps: ChatRunDeps, ctx: GatewayContext, thread: Data): Promise<ClerkContentBlock[]> {
  const from = thread['continuedFrom'];
  if (typeof from !== 'string') return [];
  try {
    const messages: ThreadMessage[] = await threadMessages(deps.db, ctx.orgId, from);
    const result = await deps.gateway.run({
      ctx,
      feature: 'chatSummary',
      promptId: CHAT_SUMMARY_PROMPT,
      vars: { transcript: transcript(messages) },
    });
    if (result.status !== 'done' || !result.text?.trim()) return [];
    return [
      {
        type: 'text',
        text: wrap('matter_note', escapeFraming(result.text.trim()), { kind: 'conversation_summary', thread: from }),
      },
    ];
  } catch (error) {
    ctx.log.warn('clerk chat summary failed', { code: error instanceof DomainError ? error.code : 'INTERNAL' });
    return [];
  }
}

/**
 * The proposals step: structured output over the same context, then `proposeSuggestions` (AI-07).
 * A cited source must be one the context or the tools showed (never an invented id); it carries the
 * version Clerk read. Off with `clerk.features.suggestions`.
 */
async function propose(
  deps: ChatRunDeps,
  ctx: GatewayContext,
  matterId: string,
  turn: { question: string; answer: ClerkRunResult; context: ClerkContext; manifest: ContextManifest },
  privileged: boolean,
): Promise<string[]> {
  if (!(await deps.flag(ctx.orgId, 'clerk.features.suggestions'))) return [];
  const { question, answer, context, manifest } = turn;
  try {
    const result = await deps.gateway.run<ChatProposalsOutput>({
      ctx,
      feature: 'chatProposals',
      promptId: CHAT_PROPOSALS_PROMPT,
      vars: { question, answer: answer.text ?? '' },
      context,
    });
    const items = result.status === 'done' ? (result.parsed?.proposals ?? []) : [];
    if (!items.length) return [];
    const versions = new Map<string, number>();
    for (const doc of [...manifest.documents, ...manifest.chunks]) versions.set(doc.documentId, doc.version);
    const proposals: SuggestionProposal[] = items.map((item) => ({
      kind: item.kind,
      payload: item.payload,
      rationale: item.rationale,
      citations: item.citations
        .filter((citation) => versions.has(citation.documentId))
        .map((citation) => ({
          kind: 'document' as const,
          documentId: citation.documentId,
          docVersion: versions.get(citation.documentId) as number,
          page: citation.page,
          quote: citation.quote,
        })),
    })) as SuggestionProposal[];
    const [promptId, promptVersion] = result.promptRef.split('@') as [string, string];
    const created = await proposeSuggestions(
      { db: deps.db, orgId: ctx.orgId, clock: deps.clock, log: ctx.log },
      matterId,
      proposals,
      { privileged, promptId, promptVersion, model: result.model },
    );
    return created.created.map((item) => item.id);
  } catch (error) {
    ctx.log.warn('clerk chat proposals failed', { code: error instanceof DomainError ? error.code : 'INTERNAL' });
    return [];
  }
}

/** Ends a message that is still streaming (a finished one is never changed). */
async function settle(db: Firestore, ref: DocumentReference, patch: Data): Promise<void> {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.get('status') !== 'streaming') return;
    tx.update(ref, patch);
  });
}

/**
 * Records why an answer failed: the code (and the switch, for CLERK_DISABLED) for the panel's copy.
 * The gateway may have ended the message already (a provider failure); the code is added either way.
 */
async function fail(deps: ChatRunDeps, ref: DocumentReference, error: unknown): Promise<void> {
  const known = error instanceof DomainError;
  const code = known ? error.code : 'INTERNAL';
  const flag = known ? (error.details as { switch?: unknown } | undefined)?.switch : undefined;
  const detail = { code, ...(typeof flag === 'string' ? { switch: flag } : {}) };
  if (known) deps.log.warn('clerk chat failed', { messageId: ref.id, code });
  else deps.log.error('clerk chat failed', { messageId: ref.id, code });
  try {
    await deps.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const streaming = snap.get('status') === 'streaming';
      tx.update(ref, {
        error: detail,
        ...(streaming ? { status: 'error' } : {}),
        updatedAt: deps.clock.now(),
      });
    });
  } catch {
    deps.log.error('clerk chat failure not recorded', { messageId: ref.id });
  }
}
