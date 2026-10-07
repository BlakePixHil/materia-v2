import * as z from 'zod';

import { CLERK_DRAFT_TYPES } from './clerk-draft-types.generated';
import { DOC_BODY_MAX } from './doc-templates';
import { ContextManifestSchema } from './schemas/clerk';
import { CitationSchema, DocIdSchema, InstantSchema, NonEmptyString, withMeta } from './schemas/common';
import { MatterTypeSchema, PartyRoleSchema, type MatterType } from './schemas/enums';

/**
 * Clerk drafting (AI-10, ADR-050): a lawyer asks Clerk for a routine letter on a matter, edits the
 * draft beside its sources, and saves it as a .docx on the firm's letterhead (INT-06). Clerk never
 * sends anything. Shared by functions and the web app: the draft types, the draft record, the
 * callables' inputs, the `[[TO CONFIRM: …]]` placeholders and the provenance runs.
 */

// ---------- draft types (libs/clerk/drafts/*.json) ----------

/** Who a letter goes to: the client, or anyone else (privileged material needs a confirmation). */
export const CLERK_DRAFT_AUDIENCES = ['client', 'third_party'] as const;
export type ClerkDraftAudience = (typeof CLERK_DRAFT_AUDIENCES)[number];

/**
 * A fact a letter type relies on: a path into the matter facts Clerk is given (`matter.estate.grantDate`,
 * `fee.estimate`), or `party:<role>` for at least one party with that role. A fact the matter lacks
 * is listed on the draft and in the prompt, so Clerk leaves a placeholder rather than inventing it.
 */
export const ClerkDraftFactSchema = z
  .object({
    fact: z.string().regex(/^(party:[a-z_]+|[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*)$/),
    label: NonEmptyString.max(80),
  })
  .strict();
export type ClerkDraftFact = z.infer<typeof ClerkDraftFactSchema>;

/**
 * One letter type (`libs/clerk/drafts/{id}.json`, compiled into the registry by
 * `pnpm materia-scripts clerk-prompts`). The wording guidance is illustrative until a practitioner
 * reviews it (AI-10a).
 */
export const ClerkDraftTypeSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,59}$/),
    title: NonEmptyString.max(80),
    /** One line for the type picker. */
    description: NonEmptyString.max(200),
    /** The matter types it fits; empty fits every matter. */
    matterTypes: z.array(MatterTypeSchema),
    /** `id@version` of the drafting prompt. */
    promptId: z.string().regex(/^[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/),
    /** The document template the saved letter is merged into (INT-06): the firm's letterhead. */
    template: DocIdSchema,
    audience: z.enum(CLERK_DRAFT_AUDIENCES),
    /** Party roles offered first as recipients. */
    recipientRoles: z.array(PartyRoleSchema),
    requiredFacts: z.array(ClerkDraftFactSchema),
    /** What the letter covers and how, for Clerk. Illustrative wording guidance. */
    guidance: NonEmptyString.max(4_000),
    /** The general letter: Clerk writes only from the person's instructions, so they're required. */
    needsInstructions: z.boolean().optional(),
  })
  .strict();
export type ClerkDraftType = z.infer<typeof ClerkDraftTypeSchema>;

export { CLERK_DRAFT_TYPES };

export const clerkDraftType = (id: string): ClerkDraftType | undefined =>
  CLERK_DRAFT_TYPES.find((type) => type.id === id);

/** The types offered on a matter of this type, in registry order (the general letter last). */
export function clerkDraftTypesFor(matterType: MatterType | string | undefined): ClerkDraftType[] {
  return CLERK_DRAFT_TYPES.filter(
    (type) => !type.matterTypes.length || (type.matterTypes as readonly string[]).includes(matterType ?? ''),
  );
}

type Data = Record<string, unknown>;

/** A value counts as known when it's a non-empty string other than `unknown`, a number or a boolean. */
function known(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '' && value !== 'unknown';
  return typeof value === 'number' || typeof value === 'boolean';
}

/** The labels of the type's facts the matter facts (`{matter, fee, parties, …}`) don't have. */
export function missingDraftFacts(type: Pick<ClerkDraftType, 'requiredFacts'>, facts: Data): string[] {
  return type.requiredFacts
    .filter(({ fact }) => {
      if (fact.startsWith('party:')) {
        const role = fact.slice('party:'.length);
        const parties = Array.isArray(facts['parties']) ? (facts['parties'] as Data[]) : [];
        return !parties.some((party) => party['role'] === role);
      }
      let value: unknown = facts;
      for (const key of fact.split('.')) value = value && typeof value === 'object' ? (value as Data)[key] : undefined;
      return !known(value);
    })
    .map(({ label }) => label);
}

// ---------- placeholders ----------

/** `[[TO CONFIRM: grant date]]`: what Clerk couldn't fill, for the lawyer to complete. */
const PLACEHOLDER = /\[\[\s*TO CONFIRM\s*:\s*([^\]\n]{1,300}?)\s*\]\]/gi;

export interface DraftPlaceholder {
  start: number;
  end: number;
  /** What to confirm: `grant date`. */
  label: string;
}

/** The `[[TO CONFIRM: …]]` placeholders in a draft, in order. */
export function draftPlaceholders(text: string): DraftPlaceholder[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    label: (match[1] ?? '').trim(),
  }));
}

/** A placeholder for a fact: `[[TO CONFIRM: Surfcoast Community Bank's address]]`. */
export const toConfirm = (what: string) => `[[TO CONFIRM: ${what.replace(/[[\]\n]+/g, ' ').trim()}]]`;

/** The `[n]` and `[n, m]` citation markers the gateway adds after cited claims: a letter doesn't carry them. */
export function stripCitationMarkers(text: string): string {
  return text.replace(/\[\d+(?:, \d+)*\]/g, '');
}

// ---------- provenance ----------

/**
 * Who wrote each part of the draft, as runs over its text in order: Clerk (the draft and each
 * rewrite) or the person (their edits). Stored with the draft for audit; never on the letter.
 */
export const ProvenanceRunSchema = z
  .object({ origin: z.enum(['clerk', 'person']), length: z.number().int().min(1).max(DOC_BODY_MAX) })
  .strict();
export type ProvenanceRun = z.infer<typeof ProvenanceRunSchema>;

/** Runs the editor keeps; adjacent edits merge, so a long edit session stays well under this. */
export const CLERK_DRAFT_PROVENANCE_MAX = 2_000;
export const ProvenanceSchema = z.array(ProvenanceRunSchema).max(CLERK_DRAFT_PROVENANCE_MAX);

/** Adjacent runs of the same origin merged, empty ones dropped. */
export function normaliseProvenance(runs: readonly ProvenanceRun[]): ProvenanceRun[] {
  const out: ProvenanceRun[] = [];
  for (const run of runs) {
    if (run.length <= 0) continue;
    const last = out[out.length - 1];
    if (last && last.origin === run.origin) last.length += run.length;
    else out.push({ ...run });
  }
  return out;
}

/** The text's length the runs cover. */
export const provenanceLength = (runs: readonly ProvenanceRun[]) => runs.reduce((sum, run) => sum + run.length, 0);

/** `[start, end)` of the text replaced by `inserted` characters written by `origin`. */
export function spliceProvenance(
  runs: readonly ProvenanceRun[],
  start: number,
  end: number,
  inserted: number,
  origin: ProvenanceRun['origin'],
): ProvenanceRun[] {
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  // What each run keeps before the replaced range, then the insert, then what each keeps after it.
  const before: ProvenanceRun[] = [];
  const after: ProvenanceRun[] = [];
  let at = 0;
  for (const run of runs) {
    before.push({ origin: run.origin, length: clamp(start - at, run.length) });
    after.push({ origin: run.origin, length: clamp(at + run.length - Math.max(end, at), run.length) });
    at += run.length;
  }
  return normaliseProvenance([...before, { origin, length: inserted }, ...after]);
}

/**
 * Runs that cover exactly `length` characters: extra runs are cut, and text they don't cover is
 * counted as the person's (a draft edited where the runs weren't kept, such as another tab).
 */
export function fitProvenance(runs: readonly ProvenanceRun[], length: number): ProvenanceRun[] {
  const out: ProvenanceRun[] = [];
  let left = length;
  for (const run of runs) {
    if (left <= 0) break;
    const take = Math.min(run.length, left);
    out.push({ origin: run.origin, length: take });
    left -= take;
  }
  if (left > 0) out.push({ origin: 'person', length: left });
  return normaliseProvenance(out);
}

/**
 * The runs after an edit from `before` to `after` text by `origin`: the changed middle (after the
 * common prefix and suffix) is attributed to it. One keystroke, a paste or an applied rewrite.
 */
export function editProvenance(
  runs: readonly ProvenanceRun[],
  before: string,
  after: string,
  origin: ProvenanceRun['origin'],
): ProvenanceRun[] {
  if (before === after) return normaliseProvenance(runs);
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return spliceProvenance(runs, prefix, before.length - suffix, after.length - prefix - suffix, origin);
}

/** How much of the text each wrote, in characters (for the audit entry). */
export function provenanceTotals(runs: readonly ProvenanceRun[]): { clerk: number; person: number } {
  return runs.reduce((totals, run) => ({ ...totals, [run.origin]: totals[run.origin] + run.length }), {
    clerk: 0,
    person: 0,
  });
}

// ---------- house style ----------

/** The longest house style an admin can set (Settings → Clerk and AI). */
export const CLERK_DRAFTING_STYLE_MAX = 2_000;

/** The house style Clerk follows until the firm sets its own: plain Australian legal English. */
export const CLERK_DEFAULT_DRAFTING_STYLE = [
  'Australian English spelling (organise, recognise, cheque).',
  'Plain English: short sentences, active voice, no Latin or legalese where a plain word will do.',
  'Courteous and direct. "We" for the firm, "you" for the reader.',
  'Dates as 6 October 2026, money as $12,345.67.',
  'Refer to the deceased as "the late" followed by their full name the first time, then by their name.',
].join('\n');

// ---------- the draft record ----------

export const CLERK_DRAFT_INSTRUCTIONS_MAX = 2_000;
export const CLERK_DRAFT_RECIPIENTS_MAX = 10;
/** The longest passage one rewrite takes: a section, not the whole letter. */
export const CLERK_DRAFT_REWRITE_MAX = 8_000;
export const CLERK_DRAFT_TITLE_MAX = 200;

export const ClerkDraftRecipientSchema = z
  .object({
    /** The matter party it came from, when it did. */
    partyId: DocIdSchema.optional(),
    contactId: DocIdSchema.optional(),
    role: PartyRoleSchema.optional(),
    name: NonEmptyString.max(200),
    /** Lines joined by newlines; null when the contact has none (the letter shows a placeholder). */
    address: z.string().max(500).nullable(),
  })
  .strict();
export type ClerkDraftRecipient = z.infer<typeof ClerkDraftRecipientSchema>;

export const CLERK_DRAFT_STATUSES = ['drafting', 'ready', 'error', 'stopped', 'saved'] as const;
export type ClerkDraftStatus = (typeof CLERK_DRAFT_STATUSES)[number];

/**
 * `orgs/{orgId}/matters/{matterId}/clerkDrafts/{draftId}` (AI-10, ADR-050): one letter Clerk
 * drafted, private to the person who asked for it. `clerk-runDraft` streams Clerk's text into
 * `bodyMd` (`drafting`); once `ready`, the owner edits `bodyMd` and its `provenance` directly, and
 * `clerk-saveDraft` merges it into the letterhead as a matter document (`saved`, `documentIds`).
 * `privileged` is set when Clerk drew on privileged material (rule 6): it then needs
 * `privileged.view` to read, and a letter to a third party needs the owner's confirmation to save.
 */
export const ClerkDraft = withMeta(
  {
    typeId: z.string().max(60),
    title: z.string().max(CLERK_DRAFT_TITLE_MAX),
    ownerUid: DocIdSchema,
    recipients: z.array(ClerkDraftRecipientSchema).max(CLERK_DRAFT_RECIPIENTS_MAX),
    instructions: z.string().max(CLERK_DRAFT_INSTRUCTIONS_MAX).default(''),
    /** The owner allowed privileged material in a letter to a third party (asked when starting). */
    includePrivileged: z.boolean().default(false),
    status: z.enum(CLERK_DRAFT_STATUSES),
    stopRequested: z.boolean().default(false),
    bodyMd: z.string().max(DOC_BODY_MAX).default(''),
    provenance: ProvenanceSchema.default([]),
    /** Clerk's last whole draft, as it wrote it (audit). */
    generatedMd: z.string().max(DOC_BODY_MAX).default(''),
    /** The sources Clerk drew on, verified (AI-05); unverified quotes are dropped. */
    citations: z.array(CitationSchema).default([]),
    /** The type's facts the matter didn't have when Clerk drafted (each should be a placeholder). */
    missingFacts: z.array(z.string().max(80)).default([]),
    privileged: z.boolean().default(false),
    manifest: ContextManifestSchema.optional(),
    promptId: z.string().optional(),
    model: z.string().optional(),
    rewrites: z.number().int().min(0).default(0),
    /** Clerk ran out of room before the letter ended: the editor offers a rewrite of the last part. */
    truncated: z.boolean().default(false),
    /** The request that started the current draft (`clerk-startDraft` or `clerk-redraft`): an older queued run skips. */
    runId: z.string().max(100).optional(),
    /** The documents saved from it (INT-06), newest last. */
    documentIds: z.array(DocIdSchema).default([]),
    savedAt: InstantSchema.optional(),
    /** Why drafting failed (`status: error`): an error code, and the switch for CLERK_DISABLED. */
    error: z.object({ code: z.string().max(60), switch: z.string().max(100).optional() }).optional(),
  },
  {
    path: 'orgs/{orgId}/matters/{matterId}/clerkDrafts',
    softDelete: true,
    migratable: false,
    serverOwned: [
      'typeId',
      'title',
      'ownerUid',
      'recipients',
      'instructions',
      'includePrivileged',
      'status',
      'generatedMd',
      'citations',
      'missingFacts',
      'privileged',
      'manifest',
      'promptId',
      'model',
      'rewrites',
      'truncated',
      'runId',
      'documentIds',
      'savedAt',
      'error',
    ],
    updatable: ['bodyMd', 'provenance', 'stopRequested'],
  },
);
export type ClerkDraft = z.infer<typeof ClerkDraft.schema>;

export const clerkDraftsPath = (orgId: string, matterId: string) => `orgs/${orgId}/matters/${matterId}/clerkDrafts`;

/** "Bank balance request: Surfcoast Community Bank". */
export function clerkDraftTitle(type: Pick<ClerkDraftType, 'title'>, recipients: readonly { name: string }[]): string {
  const names = recipients.map((recipient) => recipient.name);
  const to = names.length > 2 ? `${names[0]} and ${names.length - 1} others` : names.join(' and ');
  return (to ? `${type.title}: ${to}` : type.title).slice(0, CLERK_DRAFT_TITLE_MAX);
}

// ---------- callables ----------

export const CLERK_DRAFT_CALLABLES = {
  start: 'clerk-startDraft',
  redraft: 'clerk-redraft',
  rewrite: 'clerk-rewriteDraft',
  save: 'clerk-saveDraft',
} as const;

const RequestId = z.uuid();

/** A recipient: a party on the matter, or someone typed in (a bank, a council). */
export const ClerkDraftRecipientInput = z.union([
  z.object({ partyId: DocIdSchema }).strict(),
  z.object({ name: NonEmptyString.max(200), address: z.string().trim().max(500).optional() }).strict(),
]);
export type ClerkDraftRecipientInput = z.infer<typeof ClerkDraftRecipientInput>;

/**
 * `clerk-startDraft` (`clerk.use` and `document.upload`): creates the draft (`drafting`) and queues
 * `clerk-runDraft`, which streams Clerk's letter into it. Returns at once.
 */
export const StartClerkDraftInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  typeId: z.string().min(1).max(60),
  recipients: z.array(ClerkDraftRecipientInput).max(CLERK_DRAFT_RECIPIENTS_MAX).default([]),
  instructions: z.string().trim().max(CLERK_DRAFT_INSTRUCTIONS_MAX).default(''),
  /** For a letter to a third party: let Clerk draw on privileged material (off by default). */
  includePrivileged: z.boolean().default(false),
});
export type StartClerkDraftInput = z.input<typeof StartClerkDraftInput>;
export interface StartClerkDraftResult {
  draftId: string;
}

/** `clerk-redraft`: Clerk drafts the whole letter again (the editor confirms before discarding edits). */
export const RedraftClerkDraftInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  draftId: DocIdSchema,
  /** Replaces the draft's instructions when given. */
  instructions: z.string().trim().max(CLERK_DRAFT_INSTRUCTIONS_MAX).optional(),
});
export type RedraftClerkDraftInput = z.input<typeof RedraftClerkDraftInput>;
export interface RedraftClerkDraftResult {
  draftId: string;
}

/**
 * `clerk-rewriteDraft`: Clerk rewrites the selected passage (with the text around it for context)
 * and returns the new passage; the editor puts it in place, so the person's other edits stay.
 */
export const RewriteClerkDraftInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  draftId: DocIdSchema,
  selection: z.string().min(1).max(CLERK_DRAFT_REWRITE_MAX),
  before: z.string().max(4_000).default(''),
  after: z.string().max(4_000).default(''),
  instruction: z.string().trim().max(500).default(''),
});
export type RewriteClerkDraftInput = z.input<typeof RewriteClerkDraftInput>;
export interface RewriteClerkDraftResult {
  text: string;
  /** The rewrite drew on privileged material: the draft is now privileged too. */
  privileged: boolean;
}

/**
 * `clerk-saveDraft` (`document.upload`): merges the edited letter into the type's template (the
 * firm's letterhead, signature block) and saves it to the matter's documents
 * (`source: 'clerk_draft'`, correspondence, "Draft — not sent"). Never sends it.
 */
export const SaveClerkDraftInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  draftId: DocIdSchema,
  /** As the editor has it (not trimmed, so the provenance runs line up). */
  bodyMd: z
    .string()
    .max(DOC_BODY_MAX)
    .refine((text) => text.trim() !== '', 'The letter is empty'),
  provenance: ProvenanceSchema,
  /** The owner confirmed that a letter to a third party may carry privileged material. */
  confirmPrivileged: z.boolean().default(false),
});
export type SaveClerkDraftInput = z.input<typeof SaveClerkDraftInput>;
export interface SaveClerkDraftResult {
  documentId: string;
  name: string;
  /** Template fields the matter didn't have (INT-06), printed as `[[missing: …]]`. */
  missing: string[];
  /** `[[TO CONFIRM: …]]` placeholders still in the letter. */
  toConfirm: number;
}

/** The tag every saved Clerk draft gets (`source: 'clerk_draft'` marks it too). */
export const CLERK_DRAFT_DOCUMENT_TAG = 'clerk-draft';

/** What the editor and the documents list call a letter Clerk drafted: saved, never sent. */
export const CLERK_DRAFT_DOCUMENT_LABEL = 'Draft — not sent';
