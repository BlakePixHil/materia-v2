import type { ClerkDraftRecipientInput, LetterRecipientProposal, SuggestionPayloadOf } from '@materia/domain';

import { startClerkDraft, type StartDraftRequest } from './start';
import type { SuggestionHandler } from '../../suggestions/registry';

/**
 * The `letter` suggestion (AI-10b): Clerk proposes a letter, and accepting it starts the Clerk draft
 * (AI-10). The card opens the start page with the letter filled in, and `clerk-startDraft` accepts
 * the suggestion as the person starts it (with what they chose there); `suggestions-accept` starts
 * it as proposed. Either way the draft is created in the transaction that resolves the suggestion,
 * and the suggestion's `resultRef` is the draft. Nothing is sent: the person still checks the draft
 * and saves it.
 */

export type LetterPayload = SuggestionPayloadOf<'letter'>;

/** A proposed recipient as `clerk-startDraft` takes it. */
export function recipientInput(recipient: LetterRecipientProposal): ClerkDraftRecipientInput {
  return 'partyId' in recipient
    ? { partyId: recipient.partyId }
    : { name: recipient.name, ...(recipient.address ? { address: recipient.address } : {}) };
}

/**
 * The letter a person started, as a `letter` payload: the parties keep the names Clerk proposed
 * them with (for the card), someone typed in keeps their address.
 */
export function startedLetter(request: StartDraftRequest, proposed: LetterPayload): LetterPayload {
  const names = new Map(
    proposed.recipients.flatMap((recipient) =>
      'partyId' in recipient && recipient.name ? [[recipient.partyId, recipient.name] as const] : [],
    ),
  );
  return {
    typeId: request.typeId,
    recipients: request.recipients.map((recipient) => {
      if (!('partyId' in recipient))
        return { name: recipient.name, ...(recipient.address?.trim() ? { address: recipient.address.trim() } : {}) };
      const name = names.get(recipient.partyId);
      return { partyId: recipient.partyId, ...(name ? { name } : {}) };
    }),
    instructions: request.instructions.trim(),
  };
}

const recipientKey = (recipient: LetterRecipientProposal) =>
  'partyId' in recipient
    ? `party:${recipient.partyId}`
    : `typed:${recipient.name.trim().toLowerCase()}|${(recipient.address ?? '').trim().toLowerCase()}`;

/** Whether two letters are the same: type, recipients (in any order) and instructions. */
export function sameLetter(a: LetterPayload, b: LetterPayload): boolean {
  const keys = (letter: LetterPayload) => [...new Set(letter.recipients.map(recipientKey))].sort().join(',');
  return a.typeId === b.typeId && keys(a) === keys(b) && a.instructions.trim() === b.instructions.trim();
}

/** Accepting a letter as proposed starts its draft, with no privileged material (the start page asks). */
export const letterHandler: SuggestionHandler<'letter'> = {
  kind: 'letter',
  async apply(ctx) {
    const { payload } = ctx;
    const started = await startClerkDraft(
      ctx,
      {
        matterId: ctx.matterId,
        typeId: payload.typeId,
        recipients: payload.recipients.map(recipientInput),
        instructions: payload.instructions,
        includePrivileged: false,
      },
      ctx.join,
    );
    return { resultRef: started.path };
  },
};
