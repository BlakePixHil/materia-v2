import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';

import {
  CLERK_DRAFT_CALLABLES,
  CLERK_DRAFT_DOCUMENT_TAG,
  clerkDraftType,
  DocIdSchema,
  DomainError,
  draftPlaceholders,
  fitProvenance,
  joinNames,
  PERMISSIONS,
  provenanceTotals,
  RedraftClerkDraftInput,
  RewriteClerkDraftInput,
  RoleSchema,
  SaveClerkDraftInput,
  LetterProposalSchema,
  StartClerkDraftInput,
  toConfirm,
  type ClerkDraftRecipient,
  type ClerkDraftType,
  type RedraftClerkDraftResult,
  type RewriteClerkDraftResult,
  type SaveClerkDraftResult,
  type StartClerkDraftResult,
} from '@materia/domain';

import { sameLetter, startedLetter } from './letter-suggestion';
import {
  DRAFT_REWRITE_PROMPT,
  draftQuery,
  houseStyle,
  REWRITE_DEFAULT_INSTRUCTION,
  rewriteVars,
  runDraft,
  withholdsPrivileged,
  type DraftRunDeps,
} from './run';
import { DRAFT_QUEUE, draftPath, enqueueDraft, freshRun, startClerkDraft, type StartDraftRequest } from './start';
import { audit } from '../../audit/audit';
import { defineCallable, type CallableContext, type CallableDefinition } from '../../core/callable';
import { orgClock } from '../../core/emulator-clock';
import type { Log } from '../../core/log';
import { defineQueue } from '../../core/tasks';
import { generateDocument } from '../../docs/generate';
import { storageFiles, type FileStore } from '../../documents/files';
import { matterPath, writableMatter } from '../../matters/shared';
import type { Clock, Ports } from '../../ports';
import { systemClock } from '../../ports/container';
import { acceptSuggestion } from '../../suggestions/accept';
import { suggestionPath } from '../../suggestions/shared';
import { checkClerkAvailable } from '../available';
import { clerkContext } from '../context/service';
import { clerkGateway } from '../service';

export { clerkDraftId, DRAFT_QUEUE } from './start';

type Data = Record<string, unknown>;

export const DraftRunTaskSchema = z.object({
  orgId: DocIdSchema,
  matterId: DocIdSchema,
  draftId: DocIdSchema,
  uid: DocIdSchema,
  role: RoleSchema,
  requestId: z.string().min(1).max(100),
});

/** A draft the caller owns, live; anything else is NOT_FOUND (another person's draft is never revealed). */
async function ownDraft(db: Firestore, orgId: string, matterId: string, uid: string, draftId: string): Promise<Data> {
  const snap = await db.doc(draftPath(orgId, matterId, draftId)).get();
  const data = snap.data();
  if (!snap.exists || !data || data['ownerUid'] !== uid || (data['deletedAt'] ?? null) !== null)
    throw new DomainError('NOT_FOUND', 'Draft not found', { draftId });
  return data;
}

/** A draft Clerk is still writing can't be changed: the person waits, or stops it. */
function assertNotDrafting(draft: Data): void {
  if (draft['status'] === 'drafting')
    throw new DomainError('CONFLICT', 'Clerk is still drafting this letter', { reason: 'drafting' });
}

function draftTypeOf(draft: Data): ClerkDraftType {
  const type = clerkDraftType(String(draft['typeId']));
  if (!type)
    throw new DomainError('FAILED_PRECONDITION', 'That kind of letter no longer exists', { reason: 'draft_type' });
  return type;
}

/**
 * Starts the draft as the acceptance of the `letter` suggestion it came from (AI-10b): the draft is
 * created in the transaction that re-checks the suggestion and resolves it (`edited` when the person
 * changed the type, recipients or instructions), with what they chose on the start page. A changed
 * basis is SUGGESTION_STALE, as on the card. Returns undefined when there is nothing left to accept
 * (resolved, expired, deleted, or hidden from them): the letter then starts on its own.
 */
async function startFromSuggestion(
  ctx: CallableContext<unknown>,
  request: StartDraftRequest,
  suggestionId: string,
  expectedBasis: string | undefined,
): Promise<string | undefined> {
  const { db, orgId, log } = ctx;
  const stored = (await db.doc(suggestionPath(orgId, request.matterId, suggestionId)).get()).data();
  const proposed = stored?.['kind'] === 'letter' ? LetterProposalSchema.safeParse(stored['payload']) : undefined;
  const started = proposed?.success ? startedLetter(request, proposed.data) : undefined;
  const clock = await orgClock(db, orgId, ctx.clock);
  let draftId: string | undefined;
  try {
    await acceptSuggestion(
      ctx,
      clock,
      {
        matterId: request.matterId,
        suggestionId,
        kind: 'letter',
        expectedBasis,
        ...(started && proposed?.success && !sameLetter(started, proposed.data) ? { editedPayload: started } : {}),
      },
      async (apply) => {
        const draft = await startClerkDraft({ ...ctx, clock }, request, apply.join);
        draftId = draft.draftId;
        return { resultRef: draft.path };
      },
    );
    return draftId;
  } catch (error) {
    const gone =
      error instanceof DomainError &&
      (error.code === 'ALREADY_RESOLVED' ||
        (error.code === 'NOT_FOUND' && error.details?.['suggestionId'] === suggestionId));
    if (!gone) throw error;
    log.info('clerk draft suggestion not accepted', { suggestionId, code: error.code });
    return undefined;
  }
}

/**
 * `clerk-startDraft` (AI-10, ADR-050): starts a letter of one of the registry's types on a matter
 * and returns at once (`startClerkDraft`): Clerk streams it into the draft while the editor
 * listens. Says at once when Clerk is off, over budget or missing its key. From a `letter`
 * suggestion (AI-10b) it also accepts the suggestion (`startFromSuggestion`).
 */
export const startDraftDefinition = {
  name: CLERK_DRAFT_CALLABLES.start,
  input: StartClerkDraftInput,
  roles: PERMISSIONS['clerk.use'],
  idempotent: true,
  handler: async (ctx): Promise<StartClerkDraftResult> => {
    const { input } = ctx;
    const request: StartDraftRequest = {
      matterId: input.matterId,
      typeId: input.typeId,
      recipients: input.recipients,
      instructions: input.instructions,
      includePrivileged: input.includePrivileged,
    };
    const fromSuggestion = input.suggestionId
      ? await startFromSuggestion(ctx, request, input.suggestionId, input.expectedBasis)
      : undefined;
    if (fromSuggestion) return { draftId: fromSuggestion };
    const { draftId } = await startClerkDraft(ctx, request);
    return { draftId };
  },
} satisfies CallableDefinition<typeof StartClerkDraftInput, StartClerkDraftResult>;

/**
 * `clerk-redraft` (AI-10): Clerk drafts the whole letter again, with new instructions when given.
 * The draft's text and its provenance start again (the editor asks first when the person has
 * edited it); documents saved from it stay. A run still queued for the earlier draft skips.
 */
export const redraftDefinition = {
  name: CLERK_DRAFT_CALLABLES.redraft,
  input: RedraftClerkDraftInput,
  roles: PERMISSIONS['clerk.use'],
  idempotent: true,
  handler: async ({ input, uid, orgId, role, requestId, db, clock, ports, log }): Promise<RedraftClerkDraftResult> => {
    await checkClerkAvailable(db, orgId, clock, 'drafting');
    writableMatter(await db.doc(matterPath(orgId, input.matterId)).get(), role, input.matterId);
    const ref = db.doc(draftPath(orgId, input.matterId, input.draftId));
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const draft = snap.data();
      if (!draft || draft['ownerUid'] !== uid || (draft['deletedAt'] ?? null) !== null)
        throw new DomainError('NOT_FOUND', 'Draft not found', { draftId: input.draftId });
      // A retry of this same request finds its own run already started.
      if (draft['runId'] === requestId) return;
      assertNotDrafting(draft);
      const type = draftTypeOf(draft);
      const instructions = input.instructions ?? String(draft['instructions'] ?? '');
      if (type.needsInstructions && !instructions)
        throw new DomainError('INVALID_ARGUMENT', 'Say what the letter is about', { reason: 'instructions_required' });
      tx.update(ref, {
        ...freshRun(requestId),
        instructions,
        error: FieldValue.delete(),
        updatedAt: clock.now(),
        updatedBy: uid,
        _requestId: requestId,
      });
    });
    await enqueueDraft(ports, { orgId, matterId: input.matterId, draftId: input.draftId, uid, role, requestId });
    log.info('clerk redraft queued', { draftId: input.draftId });
    return { draftId: input.draftId };
  },
} satisfies CallableDefinition<typeof RedraftClerkDraftInput, RedraftClerkDraftResult>;

export interface RewriteDeps {
  gateway: DraftRunDeps['gateway'];
  context: DraftRunDeps['context'];
}

/**
 * `clerk-rewriteDraft` (AI-10): Clerk rewrites the passage the person selected, as they ask, with
 * the text around it for context, and returns it; the editor puts it in place (and counts it as
 * Clerk's), so their other edits stay. The draft becomes privileged when the rewrite drew on
 * privileged material (Clerk rule 6).
 */
export function rewriteDraftDefinition(deps: (db: Firestore, ports: Ports, clock: Clock) => RewriteDeps = rewriteDeps) {
  return {
    name: CLERK_DRAFT_CALLABLES.rewrite,
    input: RewriteClerkDraftInput,
    roles: PERMISSIONS['clerk.use'],
    idempotent: true,
    timeoutSeconds: 300,
    handler: async ({
      input,
      uid,
      orgId,
      role,
      requestId,
      db,
      clock,
      ports,
      log,
    }): Promise<RewriteClerkDraftResult> => {
      await checkClerkAvailable(db, orgId, clock, 'drafting');
      writableMatter(await db.doc(matterPath(orgId, input.matterId)).get(), role, input.matterId);
      const draft = await ownDraft(db, orgId, input.matterId, uid, input.draftId);
      assertNotDrafting(draft);
      const type = draftTypeOf(draft);
      const { gateway, context: builder } = deps(db, ports, clock);
      const ctx = { orgId, uid, role, requestId, log, clock };
      const instruction = input.instruction?.trim() || REWRITE_DEFAULT_INSTRUCTION;
      const context = await builder.buildContext({
        ctx,
        scope: { matterId: input.matterId },
        feature: 'draftingRewrite',
        query: draftQuery(type, `${instruction} ${input.selection}`, []),
        withholdPrivileged: withholdsPrivileged(type, draft['includePrivileged'] === true),
      });
      const settings = (await db.doc(`orgs/${orgId}`).get()).get('settings.clerk') as Data | undefined;
      const result = await gateway.run({
        ctx,
        feature: 'draftingRewrite',
        promptId: DRAFT_REWRITE_PROMPT,
        vars: rewriteVars({ type, ...input, instruction, houseStyle: houseStyle(settings) }),
        context,
      });
      if (result.status !== 'done' || !result.text?.trim())
        throw new DomainError('CLERK_UNAVAILABLE', 'Clerk couldn’t rewrite that passage', {
          reason: result.status === 'refused' ? 'refused' : 'no_rewrite',
        });
      const privileged = draft['privileged'] === true || result.privileged === true;
      await db.doc(draftPath(orgId, input.matterId, input.draftId)).update({
        rewrites: FieldValue.increment(1),
        privileged,
        updatedAt: clock.now(),
        updatedBy: uid,
      });
      log.info('clerk draft rewritten', { draftId: input.draftId, privileged });
      return { text: result.text.trim(), privileged };
    },
  } satisfies CallableDefinition<typeof RewriteClerkDraftInput, RewriteClerkDraftResult>;
}

function rewriteDeps(db: Firestore, ports: Ports, clock: Clock): RewriteDeps {
  return { gateway: clerkGateway({ db, ports, clock }), context: clerkContext({ db, embedding: ports.embedding }) };
}

/**
 * The letterhead's recipient block: one person's name and address, or several people's names with
 * each one's address. A recipient without an address gets a placeholder (AI-10 edge case).
 */
export function recipientBlock(
  recipients: readonly ClerkDraftRecipient[],
): { name: string; address: string } | undefined {
  if (!recipients.length) return undefined;
  const addressOf = (recipient: ClerkDraftRecipient) =>
    recipient.address?.trim() || toConfirm(`address for ${recipient.name}`);
  const addresses = [...new Set(recipients.map(addressOf))];
  if (addresses.length === 1)
    return {
      name: (joinNames(recipients.map((recipient) => recipient.name)) ?? '').slice(0, 200),
      address: (addresses[0] as string).slice(0, 500),
    };
  // Different addresses: each name with its own address, under the first name.
  const [first, ...rest] = recipients as [ClerkDraftRecipient, ...ClerkDraftRecipient[]];
  return {
    name: first.name.slice(0, 200),
    address: [addressOf(first), ...rest.map((recipient) => `${recipient.name}\n${addressOf(recipient)}`)]
      .join('\n\n')
      .slice(0, 500),
  };
}

/**
 * `clerk-saveDraft` (AI-10, `document.upload`): merges the edited letter into the type's template
 * (INT-06's `generateDocument`: the firm's letterhead, the recipient block, our reference, the
 * signature block) and saves it to the matter's documents as a draft (`source: 'clerk_draft'`,
 * correspondence, tagged `clerk-draft`), with a PDF preview queued. Nothing is sent. A letter to a
 * third party that drew on privileged material needs the owner's confirmation, and is filed
 * privileged. The draft keeps the text as saved, who wrote how much (`provenance`, for the audit
 * entry; never on the letter) and the saved document's id.
 */
export function saveDraftDefinition(files: () => FileStore = () => storageFiles()) {
  return {
    name: CLERK_DRAFT_CALLABLES.save,
    input: SaveClerkDraftInput,
    roles: PERMISSIONS['document.upload'],
    idempotent: true,
    memory: '512MiB',
    handler: async ({ input, uid, orgId, role, requestId, db, clock, ports, log }): Promise<SaveClerkDraftResult> => {
      const draft = await ownDraft(db, orgId, input.matterId, uid, input.draftId);
      assertNotDrafting(draft);
      const type = draftTypeOf(draft);
      const privileged = draft['privileged'] === true;
      if (privileged && type.audience === 'third_party' && !input.confirmPrivileged)
        throw new DomainError('FAILED_PRECONDITION', 'This letter to a third party drew on privileged material', {
          reason: 'privileged_confirmation',
        });
      const recipients = (draft['recipients'] as ClerkDraftRecipient[] | undefined) ?? [];
      const recipient = recipientBlock(recipients);
      const generated = await generateDocument(
        { db, files: files(), ports, clock, log },
        {
          orgId,
          uid,
          role,
          requestId,
          templateId: type.template,
          matterId: input.matterId,
          data: { body: input.bodyMd, ...(recipient ? { recipient } : {}) },
          name: String(draft['title'] || type.title),
          privileged,
          source: 'clerk_draft',
          category: 'correspondence',
          tags: [CLERK_DRAFT_DOCUMENT_TAG],
        },
      );
      const provenance = fitProvenance(input.provenance, input.bodyMd.length);
      const written = provenanceTotals(provenance);
      const placeholders = draftPlaceholders(input.bodyMd).length;
      const ref = db.doc(draftPath(orgId, input.matterId, input.draftId));
      await ref.update({
        status: 'saved',
        bodyMd: input.bodyMd,
        provenance,
        documentIds: FieldValue.arrayUnion(generated.documentId),
        savedAt: clock.now(),
        updatedAt: clock.now(),
        updatedBy: uid,
        _requestId: requestId,
      });
      await audit(
        { uid, orgId, requestId, db, clock },
        {
          action: 'clerk.draft_saved',
          entity: { path: ref.path },
          summary: `Clerk draft saved as a document (${type.title})`,
          data: {
            typeId: type.id,
            documentId: generated.documentId,
            clerkChars: written.clerk,
            personChars: written.person,
            rewrites: Number(draft['rewrites'] ?? 0),
            placeholders,
            privileged,
          },
        },
      );
      log.info('clerk draft saved', {
        draftId: input.draftId,
        documentId: generated.documentId,
        placeholders,
        missing: generated.missing.length,
      });
      return {
        documentId: generated.documentId,
        name: generated.name,
        missing: generated.missing,
        toConfirm: placeholders,
      };
    },
  } satisfies CallableDefinition<typeof SaveClerkDraftInput, SaveClerkDraftResult>;
}

/** The draft-writing dependencies on Firestore and the container's ports. */
export function draftRunDeps(db: Firestore, ports: Ports, log: Log, clock: Clock = systemClock): DraftRunDeps {
  return {
    db,
    clock,
    log,
    gateway: clerkGateway({ db, ports, clock }),
    context: clerkContext({ db, embedding: ports.embedding }),
  };
}

export const startDraft = defineCallable(startDraftDefinition);
export const redraft = defineCallable(redraftDefinition);
export const rewriteDraft = defineCallable(rewriteDraftDefinition());
export const saveDraft = defineCallable(saveDraftDefinition());

/**
 * `clerk-runDraft`: writes one draft (`runDraft`). A second attempt only happens when the first
 * died (timeout, lost instance): it ends the draft as an error rather than calling the model again.
 */
export const runDraftTask = defineQueue({
  name: DRAFT_QUEUE,
  input: DraftRunTaskSchema,
  retry: { maxAttempts: 2, minBackoffSeconds: 30 },
  timeoutSeconds: 540,
  memory: '512MiB',
  handler: async (task, { db, ports, log, attempt }) => {
    await runDraft(draftRunDeps(db, ports, log), task, attempt);
  },
});
