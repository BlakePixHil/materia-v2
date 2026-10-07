import * as z from 'zod';

import { ESTATE_MATTER_TYPES } from './intake';
import { DateOnlySchema, DocIdSchema, InstantSchema, NonEmptyString, withMeta } from './schemas/common';
import {
  MatterTypeSchema,
  OriginalsOutcomeSchema,
  type MatterStatus,
  type MatterType,
  type OriginalsOutcome,
  type RetentionHold,
} from './schemas/enums';
import { SafeCustodyLocationSchema } from './schemas/org-records';
import { addDays, addMonths, type DateOnly } from './values/date-only';
import { formatCents, type Cents } from './values/money';

/**
 * Matter closing and retention (CORE-19). A matter closes through `matters-close`, which runs the
 * closing checklist and sets `destroyAfter` from the org's retention policy; the nightly
 * `matters-archiveClosed` archives it (read-only) 90 days later; the monthly
 * `matters-queueDestruction` lists matters past `destroyAfter` for an owner or admin to approve,
 * and `matters-destroy` deletes the matter's records and files, leaving a tombstone, the audit
 * trail and a destruction certificate.
 *
 * The default retention rules need a practitioner's sign-off (CORE-19a): destruction stays behind
 * the `matters.destruction` flag until then. Closing, reopening, archiving and legal holds don't.
 */

/** Closed matters are archived (read-only) this many days after closing. */
export const MATTER_ARCHIVE_AFTER_DAYS = 90;
/** The org default when `retentionYears` is unset (Security doc: commonly 7 years after closure). */
export const DEFAULT_RETENTION_YEARS = 7;
/** Below this age a party is a minor, and the matter is kept until someone decides (no `destroyAfter`). */
export const ADULT_AGE_YEARS = 18;
/** Approving a destruction needs a sign-in this recent (`REAUTH_REQUIRED` otherwise). */
export const DESTRUCTION_REAUTH_MINUTES = 5;

/** Wills and powers of attorney whose originals are in safe custody are kept indefinitely. */
export const ORIGINALS_KEPT_TYPES: readonly MatterType[] = ['will', 'poa'];

// ---------- the closing checklist ----------

/**
 * The checklist's items (unbilled WIP from CORE-19b). The CORE-17 safe-custody packet offer joins
 * them with CORE-17. Org- and template-level checklists are a follow-up (CORE-19 descoping).
 */
export const ClosingItemIdSchema = z.enum([
  'deadlines',
  'tasks',
  'wip',
  'originals',
  'closing_letter',
  'final_distribution',
]);
export type ClosingItemId = z.infer<typeof ClosingItemIdSchema>;

/**
 * Items a lawyer may close without doing, giving a reason (the rest must be done). Unbilled WIP is
 * overridable because writing off a small amount is the practitioner's call (confirm in CORE-19a).
 */
export const OVERRIDABLE_CLOSING_ITEMS = ['wip', 'closing_letter', 'final_distribution'] as const;
export type OverridableClosingItem = (typeof OVERRIDABLE_CLOSING_ITEMS)[number];

export const CLOSING_ITEM_LABELS: Readonly<Record<ClosingItemId, string>> = {
  deadlines: 'No upcoming deadlines',
  tasks: 'No open tasks',
  wip: 'No unbilled WIP',
  originals: 'Original documents returned or in safe custody',
  closing_letter: 'Closing letter sent',
  final_distribution: 'Final distribution recorded',
};

export const ORIGINALS_LABELS: Readonly<Record<OriginalsOutcome, string>> = {
  returned: 'Returned to the client',
  safe_custody: 'Placed in safe custody',
  none_held: 'We hold no originals',
};

export const RETENTION_HOLD_LABELS: Readonly<Record<RetentionHold, string>> = {
  legal_hold: 'a legal hold',
  originals_in_custody: 'originals in safe custody',
  minor: 'a party who is a minor',
};

/** The checklist items for a matter type, in order. */
export function closingItemsFor(type: MatterType): ClosingItemId[] {
  return [
    'deadlines',
    'tasks',
    'wip',
    'originals',
    'closing_letter',
    ...((ESTATE_MATTER_TYPES as readonly MatterType[]).includes(type) ? (['final_distribution'] as const) : []),
  ];
}

/** What the person answered in the close dialog. */
export const ClosingAnswersSchema = z.object({
  originals: OriginalsOutcomeSchema.optional(),
  closingLetterSent: z.boolean().default(false),
  finalDistributionRecorded: z.boolean().default(false),
});
export type ClosingAnswers = z.infer<typeof ClosingAnswersSchema>;

const Reason = z.string().trim().min(1, { message: 'Enter a reason' }).max(500);

export const ClosingOverridesSchema = z.partialRecord(z.enum(OVERRIDABLE_CLOSING_ITEMS), Reason);
export type ClosingOverrides = z.infer<typeof ClosingOverridesSchema>;

/** What the server counts on the matter when it evaluates the checklist. */
export interface ClosingCounts {
  /** Live deadlines still `upcoming` or `blocked` (done, waived, missed and superseded are resolved). */
  upcomingDeadlines: number;
  /** Live tasks still open (to do, in progress or blocked). */
  openTasks: number;
  /** Unbilled time (`wipCents`) plus unbilled disbursements ex GST (`disbursementWipCents`). */
  unbilledWipCents: number;
}

/** A matter's unbilled WIP for the closing checklist: time plus disbursements (BILL-03, BILL-04). */
export function unbilledWipCents(matter: { wipCents?: unknown; disbursementWipCents?: unknown }): number {
  const amount = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
  return amount(matter.wipCents) + amount(matter.disbursementWipCents);
}

export type ClosingItemState = 'done' | 'todo' | 'overridden';

export interface ClosingItem {
  id: ClosingItemId;
  label: string;
  state: ClosingItemState;
  /** What's missing, or what closing will do (cancel N tasks), in words. */
  detail?: string;
}

/** The answers the server evaluates; anything left out counts as not done. */
type AnswersSoFar = { [K in keyof ClosingAnswers]?: ClosingAnswers[K] | undefined };

export interface ClosingEvaluation {
  items: ClosingItem[];
  /** Every item is done or overridden. */
  ready: boolean;
  /** The items still to do. */
  blocking: ClosingItemId[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Evaluates the closing checklist (CORE-19): deadlines must be resolved; open tasks must be done or
 * bulk-cancelled (`cancelOpenTasks`); unbilled WIP must be billed or written off, or overridden with
 * a reason; the originals question must be answered; the closing letter and (estates) the final
 * distribution must be confirmed or overridden with a reason.
 */
export function evaluateClosing(
  type: MatterType,
  counts: ClosingCounts,
  answers: AnswersSoFar,
  options: { cancelOpenTasks?: boolean; overrides?: ClosingOverrides } = {},
): ClosingEvaluation {
  const overrides = options.overrides ?? {};
  const items = closingItemsFor(type).map((id): ClosingItem => {
    const label = CLOSING_ITEM_LABELS[id];
    switch (id) {
      case 'deadlines':
        return counts.upcomingDeadlines === 0
          ? { id, label, state: 'done' }
          : {
              id,
              label,
              state: 'todo',
              detail: `${plural(counts.upcomingDeadlines, 'deadline')} still upcoming: complete, waive or supersede ${counts.upcomingDeadlines === 1 ? 'it' : 'them'} first.`,
            };
      case 'tasks':
        if (counts.openTasks === 0) return { id, label, state: 'done' };
        return options.cancelOpenTasks
          ? { id, label, state: 'done', detail: `${plural(counts.openTasks, 'open task')} will be cancelled.` }
          : { id, label, state: 'todo', detail: `${plural(counts.openTasks, 'task')} still open.` };
      case 'wip': {
        if (counts.unbilledWipCents <= 0) return { id, label, state: 'done' };
        const reason = overrides.wip;
        return reason
          ? { id, label, state: 'overridden', detail: reason }
          : {
              id,
              label,
              state: 'todo',
              detail: `${formatCents(counts.unbilledWipCents as Cents)} of time and disbursements not yet billed: bill or write it off, or give a reason.`,
            };
      }
      case 'originals':
        return answers.originals
          ? { id, label, state: 'done', detail: ORIGINALS_LABELS[answers.originals] }
          : { id, label, state: 'todo', detail: 'Say where the original documents went.' };
      case 'closing_letter':
      case 'final_distribution': {
        const done = id === 'closing_letter' ? answers.closingLetterSent : answers.finalDistributionRecorded;
        if (done) return { id, label, state: 'done' };
        const reason = overrides[id];
        return reason ? { id, label, state: 'overridden', detail: reason } : { id, label, state: 'todo' };
      }
    }
  });
  const blocking = items.filter((item) => item.state === 'todo').map((item) => item.id);
  return { items, ready: blocking.length === 0, blocking };
}

// ---------- retention ----------

/** `closedOn + years`, clamped to the end of the month (29 February → 28 February). */
export function retentionDate(closedOn: DateOnly, years: number): DateOnly {
  return addMonths(closedOn, 12 * years);
}

/** Whether someone born on `dateOfBirth` is under 18 on `on`. */
export function isMinorOn(dateOfBirth: DateOnly, on: DateOnly): boolean {
  return addMonths(dateOfBirth, 12 * ADULT_AGE_YEARS) > on;
}

export interface RetentionFacts {
  type: MatterType;
  /** The day the matter closed, in the org's time zone. */
  closedOn: DateOnly;
  retentionYears?: number | undefined;
  originals?: OriginalsOutcome | undefined;
  /** A live party who is under 18 on the closing day. */
  hasMinor: boolean;
  legalHold: boolean;
}

export interface Retention {
  /** Null: never destroyed automatically, because of `holds`. */
  destroyAfter: DateOnly | null;
  holds: RetentionHold[];
}

/**
 * When a closed matter may be destroyed (CORE-19): `closedOn + retentionYears` (default 7), or
 * never automatically for a legal hold, a will or POA whose originals are in safe custody, or a
 * matter with a minor.
 */
export function retentionFor(facts: RetentionFacts): Retention {
  const holds: RetentionHold[] = [];
  if (facts.legalHold) holds.push('legal_hold');
  if (ORIGINALS_KEPT_TYPES.includes(facts.type) && facts.originals === 'safe_custody') {
    holds.push('originals_in_custody');
  }
  if (facts.hasMinor) holds.push('minor');
  if (holds.length) return { destroyAfter: null, holds };
  const years = facts.retentionYears && facts.retentionYears >= 1 ? facts.retentionYears : DEFAULT_RETENTION_YEARS;
  return { destroyAfter: retentionDate(facts.closedOn, years), holds };
}

/**
 * A retention policy change moves an existing `destroyAfter` only later, never earlier (an earlier
 * date needs an explicit admin action). Returns the new date, or null to keep the current one.
 */
export function laterDestroyAfter(current: DateOnly | null | undefined, recomputed: DateOnly | null): DateOnly | null {
  if (!current || !recomputed) return null;
  return recomputed > current ? recomputed : null;
}

/** The day before which a closed matter isn't archived yet: closed on or before this day is due. */
export function archiveCutoff(today: DateOnly): DateOnly {
  return addDays(today, -MATTER_ARCHIVE_AFTER_DAYS);
}

/** What `dueForDestruction` reads from a matter. */
export interface DestructionCandidate {
  status?: MatterStatus | string;
  destroyAfter?: string | null;
  legalHold?: { on?: boolean } | null;
  deletedAt?: unknown;
  destroyedAt?: unknown;
}

/** A closed or archived matter, past its `destroyAfter`, not on hold and not already destroyed. */
export function dueForDestruction(matter: DestructionCandidate, today: DateOnly): boolean {
  return (
    (matter.status === 'closed' || matter.status === 'archived') &&
    typeof matter.destroyAfter === 'string' &&
    matter.destroyAfter < today &&
    matter.legalHold?.on !== true &&
    !matter.destroyedAt
  );
}

// ---------- the destruction queue and certificates ----------

const ORG = 'orgs/{orgId}';

/**
 * `pending` (queued, awaiting approval) → `approved` → `destroying` → `destroyed`; `cancelled` when
 * the matter is reopened or put on hold first.
 */
export const DestructionStatusSchema = z.enum(['pending', 'approved', 'destroying', 'destroyed', 'cancelled']);
export type DestructionStatus = z.infer<typeof DestructionStatusSchema>;

/** The steps `matters-destroy` works through; a retry resumes after the last one finished. */
export const DestructionStageSchema = z.enum(['files', 'records', 'references', 'tombstone', 'certificate']);
export type DestructionStage = z.infer<typeof DestructionStageSchema>;

export const DestructionCountsSchema = z.object({
  /** Storage objects (document versions, renditions, uploads). */
  files: z.number().int().min(0),
  /** Matter documents (the documents collection). */
  documents: z.number().int().min(0),
  /** Firestore records under the matter, documents and chunks included. */
  records: z.number().int().min(0),
});
export type DestructionCounts = z.infer<typeof DestructionCountsSchema>;

/**
 * `orgs/{orgId}/destructionQueue/{matterId}` (CORE-19): one entry per matter due for destruction,
 * listed by `matters-queueDestruction` and approved through `matters-approveDestruction`.
 * Server-written; owners and admins read it. The title goes when the matter does, unless the org
 * keeps titles (`destructionKeepsTitle`).
 */
export const DestructionRequest = withMeta(
  () => ({
    matterId: DocIdSchema,
    number: NonEmptyString,
    title: z.string().optional(),
    type: MatterTypeSchema,
    closedAt: InstantSchema.optional(),
    destroyAfter: DateOnlySchema,
    status: DestructionStatusSchema,
    queuedAt: InstantSchema,
    approvedBy: DocIdSchema.optional(),
    approvedAt: InstantSchema.optional(),
    cancelledReason: z.enum(['reopened', 'legal_hold', 'not_due']).optional(),
    /** The last finished step of `matters-destroy`. */
    stage: DestructionStageSchema.optional(),
    counts: DestructionCountsSchema.optional(),
    certificateId: DocIdSchema.optional(),
    destroyedAt: InstantSchema.optional(),
    /** The last failure, as an error code (no client text); the task retries. */
    error: z.string().max(200).optional(),
  }),
  { path: `${ORG}/destructionQueue`, migratable: false, updatable: [] },
);
export type DestructionRequest = z.infer<typeof DestructionRequest.schema>;

/**
 * `orgs/{orgId}/destructionCertificates/{certificateId}` (CORE-19): issued only once a destruction
 * is complete. The PDF lives at `storagePath` (server-only; downloaded through a signed URL).
 */
export const DestructionCertificate = withMeta(
  () => ({
    matterId: DocIdSchema,
    number: NonEmptyString,
    title: z.string().optional(),
    type: MatterTypeSchema,
    closedAt: InstantSchema.optional(),
    destroyAfter: DateOnlySchema,
    approvedBy: DocIdSchema,
    approvedAt: InstantSchema,
    destroyedAt: InstantSchema,
    counts: DestructionCountsSchema,
    storagePath: NonEmptyString,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  { path: `${ORG}/destructionCertificates`, migratable: false, updatable: [] },
);
export type DestructionCertificate = z.infer<typeof DestructionCertificate.schema>;

/** The certificate id for a matter's destruction (one per matter). */
export const destructionCertificateId = (matterId: string) => `dc-${matterId}`;

// ---------- callable inputs and results ----------

const RequestId = z.uuid();

/** `matters-closingChecklist` (`matter.close`): the checklist as it stands, before closing. */
export const ClosingChecklistInput = z.object({
  matterId: DocIdSchema,
  checklist: ClosingAnswersSchema.partial().optional(),
  cancelOpenTasks: z.boolean().optional(),
  checklistOverrides: ClosingOverridesSchema.optional(),
});
export type ClosingChecklistInput = z.infer<typeof ClosingChecklistInput>;

export interface ClosingWarning {
  /** An open related matter (a will dispute about this estate): closing is allowed, but say so. */
  kind: 'related_open';
  matterId: string;
  number: string;
}

/**
 * Where a will matter's original goes if it's placed in safe custody on closing (CORE-17a): the
 * testator (a live `testator` party, or null when the matter has none) and their packet still in
 * custody, which the will joins; without one, closing creates a packet and needs its location.
 */
export interface ClosingSafeCustody {
  testator: { contactId: string; name: string } | null;
  packet: { id: string; packetNo: string } | null;
}

export interface ClosingChecklistResult extends ClosingEvaluation, Retention {
  counts: ClosingCounts;
  warnings: ClosingWarning[];
  retentionYears: number;
  /** Will matters only (CORE-17a). */
  safeCustody?: ClosingSafeCustody;
}

/** Matter types whose original goes into a safe custody packet when closed with `originals: 'safe_custody'`. */
export const SAFE_CUSTODY_ON_CLOSE_TYPES: readonly MatterType[] = ['will'];

/** `matters-close` (`matter.close`: lawyer and above). */
export const CloseMatterInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  reason: Reason,
  checklist: ClosingAnswersSchema.default({ closingLetterSent: false, finalDistributionRecorded: false }),
  /** Bulk-cancel the open tasks, with this reason (the "no open tasks" item). */
  cancelOpenTasks: z.object({ reason: Reason }).optional(),
  checklistOverrides: ClosingOverridesSchema.optional(),
  /**
   * A will matter closed with its original into safe custody, when the testator has no packet in
   * custody yet: where the new packet is kept (CORE-17a). Ignored when the will joins their packet.
   */
  safeCustodyLocation: SafeCustodyLocationSchema.optional(),
});
export type CloseMatterInput = z.input<typeof CloseMatterInput>;

export interface CloseMatterResult extends Retention {
  matterId: string;
  status: 'closed';
  tasksCancelled: number;
  /** The packet the original will went into (CORE-17a): `created` when closing made it. */
  packet?: { id: string; packetNo: string; created: boolean };
}

/** `matters-reopen` (`matter.status`): a closed or archived matter back to open, with a reason. */
export const ReopenMatterInput = z.object({ requestId: RequestId, matterId: DocIdSchema, reason: Reason });
export type ReopenMatterInput = z.infer<typeof ReopenMatterInput>;

export interface ReopenMatterResult {
  matterId: string;
  status: 'open';
}

/** `matters-setLegalHold` (`matter.legalHold`: owner and admin). */
export const SetLegalHoldInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  on: z.boolean(),
  reason: Reason,
});
export type SetLegalHoldInput = z.infer<typeof SetLegalHoldInput>;

export interface SetLegalHoldResult extends Retention {
  matterId: string;
  on: boolean;
}

/**
 * `matters-approveDestruction` (`matter.destroy`, a sign-in within DESTRUCTION_REAUTH_MINUTES):
 * `confirmation` is the matter number, typed.
 */
export const ApproveDestructionInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  confirmation: z.string().trim().min(1).max(60),
});
export type ApproveDestructionInput = z.infer<typeof ApproveDestructionInput>;

export interface ApproveDestructionResult {
  matterId: string;
  status: 'approved';
}

/** `matters-destructionCertificateUrl` (`matter.destroy`): a short-lived download link to the PDF. */
export const DestructionCertificateUrlInput = z.object({ certificateId: DocIdSchema });
export type DestructionCertificateUrlInput = z.infer<typeof DestructionCertificateUrlInput>;

export interface DestructionCertificateUrlResult {
  url: string;
  expiresAt: string;
}
