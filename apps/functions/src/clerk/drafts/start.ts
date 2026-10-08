import { createHash } from 'node:crypto';

import type { Firestore } from 'firebase-admin/firestore';

import {
  can,
  ClerkDraft,
  clerkDraftsPath,
  clerkDraftTitle,
  clerkDraftType,
  clerkDraftTypesFor,
  DomainError,
  personFields,
  type ClerkDraftRecipient,
  type ClerkDraftRecipientInput,
  type Role,
} from '@materia/domain';

import type { DraftRunTask } from './run';
import type { Log } from '../../core/log';
import type { TxJoin } from '../../core/tx-join';
import { matterPath, writableMatter } from '../../matters/shared';
import type { Clock, Ports } from '../../ports';
import { checkClerkAvailable } from '../available';

/**
 * Starting a Clerk draft (AI-10, ADR-050), shared by `clerk-startDraft` and the `letter` suggestion's
 * accept handler (AI-10b), which joins the suggestion's re-check and resolution to the transaction
 * that creates the draft.
 */

/** The queue that writes drafts server-side (AI-10): Cloud Tasks, so navigating away doesn't stop one. */
export const DRAFT_QUEUE = 'clerk-runDraft';

/** The draft's id: the same `clerk-startDraft` request always names the same draft. */
export const clerkDraftId = (orgId: string, requestId: string) =>
  `cd-${createHash('sha256').update(`${orgId}/${requestId}`).digest('hex').slice(0, 32)}`;

export const draftPath = (orgId: string, matterId: string, draftId: string) =>
  `${clerkDraftsPath(orgId, matterId)}/${draftId}`;

type ContactData = Parameters<typeof personFields>[0];

/**
 * The recipients as the draft keeps them: a party's name and address from its contact (the postal
 * address first, as the letterhead does), or what the person typed. A party that isn't on the
 * matter is refused.
 */
async function resolveRecipients(
  db: Firestore,
  orgId: string,
  matterId: string,
  inputs: readonly ClerkDraftRecipientInput[],
): Promise<ClerkDraftRecipient[]> {
  const recipients: ClerkDraftRecipient[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    if (!('partyId' in input)) {
      recipients.push({ name: input.name, address: input.address?.trim() || null });
      continue;
    }
    if (seen.has(input.partyId)) continue;
    seen.add(input.partyId);
    const party = (await db.doc(`${matterPath(orgId, matterId)}/parties/${input.partyId}`).get()).data();
    if (!party || (party['deletedAt'] ?? null) !== null)
      throw new DomainError('INVALID_ARGUMENT', 'That person isn’t on the matter', {
        reason: 'recipient',
        partyId: input.partyId,
      });
    const contactId = String(party['contactId']);
    const contact = (await db.doc(`orgs/${orgId}/contacts/${contactId}`).get()).data();
    const fields =
      contact && (contact['deletedAt'] ?? null) === null ? personFields(contact as ContactData) : undefined;
    if (!fields?.['fullName'])
      throw new DomainError('INVALID_ARGUMENT', 'That person has no contact details', {
        reason: 'recipient',
        partyId: input.partyId,
      });
    recipients.push({
      partyId: input.partyId,
      contactId,
      role: party['role'] as ClerkDraftRecipient['role'],
      name: fields['fullName'].slice(0, 200),
      address: fields['address']?.slice(0, 500) ?? null,
    });
  }
  return recipients;
}

export async function enqueueDraft(ports: Ports, task: DraftRunTask): Promise<void> {
  await ports.tasks.enqueue(
    DRAFT_QUEUE,
    { ...task },
    { dedupeKey: `clerk-draft-${task.orgId}-${task.draftId}-${task.requestId}` },
  );
}

/** What a new run starts from: Clerk's text so far cleared, and this request as the current run. */
export const freshRun = (requestId: string) => ({
  status: 'drafting',
  stopRequested: false,
  bodyMd: '',
  provenance: [],
  generatedMd: '',
  citations: [],
  missingFacts: [],
  truncated: false,
  runId: requestId,
});

/** Who starts the draft, and with what. */
export interface StartDraftContext {
  db: Firestore;
  orgId: string;
  uid: string;
  role: Role;
  /** The request: the same one always names the same draft. */
  requestId: string;
  clock: Clock;
  ports: Ports;
  log: Log;
}

/** The letter to start, as `clerk-startDraft` takes it. */
export interface StartDraftRequest {
  matterId: string;
  typeId: string;
  recipients: readonly ClerkDraftRecipientInput[];
  instructions: string;
  includePrivileged: boolean;
}

/**
 * Starts a letter of one of the registry's types on a matter: checks Clerk can draft now, the
 * matter can change and the type fits it, resolves the recipients from the matter's parties,
 * creates the draft (`drafting`, private to the caller) and queues `clerk-runDraft`. With `join`,
 * the draft is created in a transaction that runs the join's re-check first and its write after
 * (a `letter` suggestion accepted as the draft starts, AI-10b); a retry of a request that created
 * the draft finds it there.
 */
export async function startClerkDraft(
  ctx: StartDraftContext,
  request: StartDraftRequest,
  join?: TxJoin,
): Promise<{ draftId: string; path: string }> {
  const { db, orgId, uid, role, requestId, clock, ports, log } = ctx;
  await checkClerkAvailable(db, orgId, clock, 'drafting');
  const matter = writableMatter(await db.doc(matterPath(orgId, request.matterId)).get(), role, request.matterId);
  const type = clerkDraftType(request.typeId);
  if (!type || !clerkDraftTypesFor(String(matter['type'])).includes(type))
    throw new DomainError('INVALID_ARGUMENT', 'Clerk doesn’t draft that letter on this matter', {
      reason: 'draft_type',
      typeId: request.typeId,
    });
  if (type.needsInstructions && !request.instructions)
    throw new DomainError('INVALID_ARGUMENT', 'Say what the letter is about', { reason: 'instructions_required' });
  const recipients = await resolveRecipients(db, orgId, request.matterId, request.recipients);

  const ref = db.doc(draftPath(orgId, request.matterId, clerkDraftId(orgId, requestId)));
  const at = clock.now();
  const record = ClerkDraft.schema.parse({
    typeId: type.id,
    title: clerkDraftTitle(type, recipients),
    ownerUid: uid,
    recipients,
    instructions: request.instructions,
    // Only a letter to a third party asks, and only a role that may see privileged material can allow it.
    includePrivileged: request.includePrivileged && type.audience === 'third_party' && can(role, 'privileged.view'),
    ...freshRun(requestId),
    privileged: false,
    rewrites: 0,
    documentIds: [],
    deletedAt: null,
    createdAt: at,
    createdBy: uid,
    updatedAt: at,
    updatedBy: uid,
    schemaVersion: ClerkDraft.version,
    _requestId: requestId,
  });
  if (join) {
    await db.runTransaction(async (tx) => {
      await join.read(tx);
      tx.create(ref, record);
      join.write(tx, ref.path);
    });
  } else {
    try {
      await ref.create(record);
    } catch (error) {
      // A retry of a request whose first attempt created the draft: it is already there.
      if ((error as { code?: number }).code !== 6) throw error;
    }
  }
  await enqueueDraft(ports, { orgId, matterId: request.matterId, draftId: ref.id, uid, role, requestId });
  log.info('clerk draft queued', { draftId: ref.id, typeId: type.id, recipients: recipients.length });
  return { draftId: ref.id, path: ref.path };
}
