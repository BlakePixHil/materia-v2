import * as z from 'zod';

import { PERMISSIONS } from './permissions';
import { DocIdSchema, NonEmptyString } from './schemas/common';
import {
  MatterDocumentRefSchema,
  SafeCustodyItemSchema,
  SafeCustodyLocationSchema,
  type SafeCustodyItem,
  type SafeCustodyItemKind,
  type SafeCustodyLocation,
  type SafeCustodyMovementKind,
  type SafeCustodyStatus,
} from './schemas/org-records';
import { searchTokensWithNumber } from './search';
import { DateOnlySchema } from './values/date-only';

/**
 * The will safe-custody register (CORE-17, ADR-036): packets of original wills, codicils, powers of
 * attorney and enduring guardianship appointments, where each one is, and every movement with the
 * authority for it. Packets are written only through the `safeCustody-*` callables.
 */

// ---------- packet numbers, labels and derived fields ----------

/** The counter packet numbers come from: `orgs/{orgId}/counters/safe-custody`. */
export const SAFE_CUSTODY_COUNTER = 'safe-custody';

/** `SC-000123` (`SC-{seq:6}`). */
export function formatPacketNo(seq: number): string {
  return `SC-${String(seq).padStart(6, '0')}`;
}

export const SAFE_CUSTODY_ITEM_LABELS: Record<SafeCustodyItemKind, string> = {
  will: 'Will',
  codicil: 'Codicil',
  poa: 'Power of attorney',
  eg: 'Enduring guardianship',
  other: 'Other original',
};

export const SAFE_CUSTODY_STATUS_LABELS: Record<SafeCustodyStatus, string> = {
  held: 'Held',
  out: 'Out',
  released: 'Released',
  destroyed: 'Destroyed',
};

export const SAFE_CUSTODY_MOVEMENT_LABELS: Record<SafeCustodyMovementKind, string> = {
  in: 'Received',
  out: 'Taken out',
  returned: 'Returned',
  released: 'Released',
  destroyed: 'Destroyed',
};

/**
 * The item flagged "current": the latest-dated will (or codicil, when no will is dated later). Only
 * a flag: whether a later will revokes an earlier one is a legal question, so nothing is enforced.
 * -1 when no will or codicil is dated.
 */
export function currentItemIndex(items: readonly Pick<SafeCustodyItem, 'kind' | 'date'>[]): number {
  let best = -1;
  items.forEach((item, index) => {
    if ((item.kind !== 'will' && item.kind !== 'codicil') || !item.date) return;
    const current = items[best];
    if (!current?.date || item.date > current.date || (item.date === current.date && item.kind === 'will')) {
      best = index;
    }
  });
  return best;
}

/** "Geelong · Safe A · Slot 12", leaving out the parts not recorded. */
export function locationLabel(location: Partial<SafeCustodyLocation> | null | undefined): string {
  return [location?.site, location?.cabinet, location?.slot].filter((part) => part && part.trim()).join(' · ');
}

/**
 * The stocktake's sort key: site, cabinet and slot, lower-cased, with numbers zero-padded so slot 2
 * comes before slot 12.
 */
export function locationKey(location: Partial<SafeCustodyLocation>): string {
  const part = (text: string | undefined) =>
    (text ?? '')
      .trim()
      .toLowerCase()
      .replace(/\d+/g, (digits) => digits.padStart(8, '0'));
  return [part(location.site), part(location.cabinet), part(location.slot)].join('|');
}

/** A packet's search tokens: its number, the testator's name and its location (ADR-013). */
export function packetSearchTokens(packetNo: string, testatorName: string, location: Partial<SafeCustodyLocation>) {
  return searchTokensWithNumber(packetNo, testatorName, location.site, location.cabinet, location.slot);
}

// ---------- movements ----------

/** Movements the callable records (a packet is received, `in`, when it is created). */
export const RecordableMovementSchema = z.enum(['out', 'returned', 'released', 'destroyed']);
export type RecordableMovement = z.infer<typeof RecordableMovementSchema>;

/** The statuses each movement starts from, and where it leaves the packet. */
export const MOVEMENT_TRANSITIONS: Record<
  RecordableMovement,
  { from: readonly SafeCustodyStatus[]; to: SafeCustodyStatus }
> = {
  out: { from: ['held'], to: 'out' },
  returned: { from: ['out'], to: 'held' },
  released: { from: ['held', 'out'], to: 'released' },
  destroyed: { from: ['held'], to: 'destroyed' },
};

/** Movements that need a signed authority, a lawyer or above, and a recent sign-in. */
export const AUTHORISED_MOVEMENTS: readonly RecordableMovement[] = ['released', 'destroyed'];

export function needsAuthority(kind: RecordableMovement): boolean {
  return AUTHORISED_MOVEMENTS.includes(kind);
}

/** The movements a packet in this status can make next. */
export function allowedMovements(status: SafeCustodyStatus): RecordableMovement[] {
  return (Object.keys(MOVEMENT_TRANSITIONS) as RecordableMovement[]).filter((kind) =>
    MOVEMENT_TRANSITIONS[kind].from.includes(status),
  );
}

/** Releasing or destroying an original needs a sign-in within this many minutes. */
export const SAFE_CUSTODY_REAUTH_MINUTES = 5;

/** Roles that may release or destroy an original, or confirm a destruction. */
export const SAFE_CUSTODY_RELEASE_ROLES = PERMISSIONS['safeCustody.release'];

// ---------- callables ----------

const RequestId = z.uuid();
const Reason = z.string().trim().max(1000);

/** The `safeCustody-*` callables, as deployed. */
export const SAFE_CUSTODY_CALLABLES = {
  receive: 'safeCustody-receive',
  update: 'safeCustody-update',
  recordMovement: 'safeCustody-recordMovement',
  confirmDestruction: 'safeCustody-confirmDestruction',
  verify: 'safeCustody-verify',
  receipt: 'safeCustody-receipt',
  stocktakeReport: 'safeCustody-stocktakeReport',
} as const;

/**
 * `safeCustody-receive` (`safeCustody.edit`, idempotent): a new packet, numbered from the counter,
 * `held` at `location`, with an `in` movement. A merged testator contact is followed to the one
 * kept. `responsibleUid` (an active member; default the caller) hears when the testator dies.
 */
export const ReceivePacketInput = z.strictObject({
  requestId: RequestId,
  testatorContactId: DocIdSchema,
  items: z.array(SafeCustodyItemSchema).min(1, { message: 'Add at least one original' }).max(50),
  location: SafeCustodyLocationSchema,
  receivedOn: DateOnlySchema,
  responsibleUid: DocIdSchema.optional(),
  matterId: DocIdSchema.optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type ReceivePacketInput = z.input<typeof ReceivePacketInput>;

export interface ReceivePacketResult {
  id: string;
  packetNo: string;
}

/**
 * `safeCustody-update` (`safeCustody.edit`, idempotent): changes a live packet's items, location,
 * responsible lawyer, will matter or notes. Released and destroyed packets are closed:
 * FAILED_PRECONDITION `packet_closed`.
 */
export const UpdatePacketInput = z.strictObject({
  requestId: RequestId,
  id: DocIdSchema,
  items: z.array(SafeCustodyItemSchema).min(1, { message: 'Add at least one original' }).max(50).optional(),
  location: SafeCustodyLocationSchema.optional(),
  responsibleUid: DocIdSchema.optional(),
  matterId: DocIdSchema.nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type UpdatePacketInput = z.input<typeof UpdatePacketInput>;

/**
 * `safeCustody-recordMovement` (`safeCustody.edit`, idempotent) appends a movement:
 * - `out` (held → out) needs `to`, who or where it went;
 * - `returned` (out → held), optionally to a new `location`;
 * - `released` (held or out → released) needs `authority` (a signed authority from the testator, a
 *   death certificate with the executor's ID, a court order), `to` or `toContactId` (the executor,
 *   or the receiving firm as a contact), a lawyer or above, and a sign-in within 5 minutes;
 * - `destroyed` (held) needs `authority`, a lawyer or above and a recent sign-in, and only asks:
 *   a second lawyer confirms with `safeCustody-confirmDestruction`.
 * A movement the status doesn't allow is FAILED_PRECONDITION `invalid_movement`.
 */
export const RecordMovementInput = z
  .strictObject({
    requestId: RequestId,
    id: DocIdSchema,
    kind: RecordableMovementSchema,
    reason: Reason.min(1, { message: 'Say why' }),
    to: z.string().trim().max(200).optional(),
    toContactId: DocIdSchema.optional(),
    authority: MatterDocumentRefSchema.optional(),
    location: SafeCustodyLocationSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (needsAuthority(input.kind) && !input.authority) {
      ctx.addIssue({ code: 'custom', path: ['authority'], message: 'Choose the authority document' });
    }
    if (input.kind === 'out' && !input.to) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'Say who has it' });
    }
    if (input.kind === 'released' && !input.to && !input.toContactId) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'Say who it was released to' });
    }
  });
export type RecordMovementInput = z.input<typeof RecordMovementInput>;

export interface RecordMovementResult {
  status: SafeCustodyStatus;
  /** True when a destruction now waits for a second lawyer. */
  pendingConfirmation: boolean;
}

/**
 * `safeCustody-confirmDestruction` (lawyer or above, a recent sign-in, idempotent): a second lawyer,
 * not the one who asked, confirms (`approve: true`, the packet is `destroyed`) or declines a pending
 * destruction. The one who asked may only decline (withdraw). Nothing pending: FAILED_PRECONDITION
 * `no_pending_destruction`; confirming your own: PERMISSION_DENIED `same_person`.
 */
export const ConfirmDestructionInput = z.strictObject({
  requestId: RequestId,
  id: DocIdSchema,
  approve: z.boolean(),
  reason: Reason.optional(),
});
export type ConfirmDestructionInput = z.input<typeof ConfirmDestructionInput>;

/**
 * `safeCustody-verify` (`safeCustody.edit`, idempotent): the annual stocktake. Each packet found is
 * marked verified on `on`. Packets that aren't held are left alone and returned as `skipped`.
 */
export const VerifyPacketsInput = z.strictObject({
  requestId: RequestId,
  ids: z.array(DocIdSchema).min(1).max(200),
  on: DateOnlySchema,
});
export type VerifyPacketsInput = z.input<typeof VerifyPacketsInput>;

export interface VerifyPacketsResult {
  verified: string[];
  skipped: string[];
}

/** `safeCustody-receipt` (`safeCustody.edit`, idempotent): starts the testator's receipt PDF (FND-24). */
export const PacketReceiptInput = z.strictObject({ requestId: RequestId, id: DocIdSchema });
export type PacketReceiptInput = z.input<typeof PacketReceiptInput>;

/**
 * `safeCustody-stocktakeReport` (`safeCustody.edit`, idempotent): starts the stocktake PDF, every
 * held packet by location (at one `site`, or all), with a verified box for each.
 */
export const StocktakeReportInput = z.strictObject({
  requestId: RequestId,
  site: NonEmptyString.max(80).optional(),
});
export type StocktakeReportInput = z.input<typeof StocktakeReportInput>;

/** What the PDF callables return: the job to watch, then `jobs-getExportUrl`. */
export interface SafeCustodyPdfResult {
  jobId: string;
}

/** The register reads at most this many held packets for one stocktake report. */
export const STOCKTAKE_REPORT_MAX = 5000;
