import type { ClerkDraftItem, WithId } from '@materia/data-access/repository';
import {
  CLERK_DRAFT_DOCUMENT_LABEL,
  draftPlaceholders,
  type ClerkDraft,
  type ClerkDraftType,
  type PartyRole,
} from '@materia/domain';

import { errorCodeOf, errorCopy } from '../../core/error-copy';
import { PARTY_ROLE_LABELS } from '../contacts/contact-form';

export type DraftDoc = WithId<ClerkDraftItem>;

/** A run of the letter's text for the highlight layer: plain text, or a `[[TO CONFIRM: …]]` placeholder. */
export interface DraftSegment {
  text: string;
  placeholder: boolean;
}

/** The text cut at its placeholders, so the layer behind the editor can highlight them. */
export function draftSegments(text: string): DraftSegment[] {
  const segments: DraftSegment[] = [];
  let at = 0;
  for (const placeholder of draftPlaceholders(text)) {
    if (placeholder.start > at) segments.push({ text: text.slice(at, placeholder.start), placeholder: false });
    segments.push({ text: text.slice(placeholder.start, placeholder.end), placeholder: true });
    at = placeholder.end;
  }
  // A trailing newline needs a character after it, or the layer is a line shorter than the field.
  segments.push({ text: `${text.slice(at)} `, placeholder: false });
  return segments;
}

/** The draft's state, as the editor's header says it. */
export function draftStatusLabel(draft: Pick<ClerkDraft, 'status'>): string {
  switch (draft.status) {
    case 'drafting':
      return 'Clerk is drafting…';
    case 'stopped':
      return 'Stopped: a draft, not sent';
    case 'error':
      return 'Clerk couldn’t finish this draft';
    case 'saved':
      return `Saved to documents. ${CLERK_DRAFT_DOCUMENT_LABEL}`;
    default:
      return CLERK_DRAFT_DOCUMENT_LABEL;
  }
}

/** Why Clerk couldn't draft the letter, in words. */
export function draftErrorCopy(error: ClerkDraft['error']): string | null {
  if (!error) return null;
  if (error.code === 'CLERK_REFUSED')
    return 'Clerk declined to draft this letter. Change the instructions and redraft, or write it yourself.';
  return errorCopy({ details: { code: error.code, ...(error.switch ? { switch: error.switch } : {}) } });
}

/** A failure that means Clerk can't be used right now (off, over budget, no key): write it by hand. */
export function clerkUnavailable(error: unknown): boolean {
  const code = errorCodeOf(error);
  return !!code && code.startsWith('CLERK_');
}

/** Whether the person has changed Clerk's draft (a redraft would discard their edits). */
export function draftEdited(draft: Pick<ClerkDraft, 'generatedMd' | 'provenance'>, body: string): boolean {
  return body !== draft.generatedMd || draft.provenance.some((run) => run.origin === 'person');
}

/** The most of the letter on each side of a selection a rewrite is given, for context. */
export const REWRITE_CONTEXT_CHARS = 4_000;

/** The text before and after a selection, cut to the context a rewrite takes. */
export function rewriteContext(text: string, start: number, end: number): { before: string; after: string } {
  return {
    before: text.slice(Math.max(0, start - REWRITE_CONTEXT_CHARS), start),
    after: text.slice(end, end + REWRITE_CONTEXT_CHARS),
  };
}

/** A party a letter can go to: its row and contact name. */
export interface RecipientOption {
  partyId: string;
  name: string;
  role: PartyRole;
  roleLabel: string;
  /** One of the roles the letter type writes to (listed first). */
  suggested: boolean;
}

/**
 * The matter's parties as recipients: the type's own roles first (beneficiaries for a grant
 * notification), then the rest by name. The deceased is never one.
 */
export function recipientOptions(
  parties: readonly { id: string; contactId: string; role: PartyRole; deletedAt?: Date | null | undefined }[],
  nameOf: (contactId: string) => string | undefined,
  type: Pick<ClerkDraftType, 'recipientRoles'> | undefined,
): RecipientOption[] {
  const roles = (type?.recipientRoles ?? []) as readonly PartyRole[];
  return parties
    .filter((party) => !party.deletedAt && party.role !== 'deceased')
    .map((party) => ({
      partyId: party.id,
      name: nameOf(party.contactId) ?? '…',
      role: party.role,
      roleLabel: PARTY_ROLE_LABELS[party.role],
      suggested: roles.includes(party.role),
    }))
    .sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.name.localeCompare(b.name));
}

/** "2 things to confirm". */
export function toConfirmText(count: number): string {
  return count === 1 ? '1 thing to confirm' : `${count} things to confirm`;
}
