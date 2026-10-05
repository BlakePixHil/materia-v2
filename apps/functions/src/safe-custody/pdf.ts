import type { Firestore } from 'firebase-admin/firestore';

import {
  contactDisplayName,
  currentItemIndex,
  DEFAULT_ORG_TIMEZONE,
  isDateOnly,
  PacketReceiptInput,
  PERMISSIONS,
  SAFE_CUSTODY_CALLABLES,
  SAFE_CUSTODY_ITEM_LABELS,
  STOCKTAKE_REPORT_MAX,
  StocktakeReportInput,
  toDisplay,
  today,
  type Contact,
  type SafeCustodyItem,
  type SafeCustodyLocation,
  type SafeCustodyPdfResult,
} from '@materia/domain';

import { livePacket, packetPath, packetsPath } from './shared';
import { contactPath } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { createJob } from '../jobs/start-pdf';

type Data = Record<string, unknown>;

/** The PDF templates in `apps/jobs/templates`. */
export const RECEIPT_TEMPLATE = 'safe-custody-receipt';
export const STOCKTAKE_TEMPLATE = 'safe-custody-stocktake';

const display = (value: unknown) => (isDateOnly(value) ? toDisplay(value) : '');

async function firm(db: Firestore, orgId: string) {
  const org = (await db.doc(`orgs/${orgId}`).get()).data() ?? {};
  const timeZone = typeof org['timezone'] === 'string' && org['timezone'] ? org['timezone'] : DEFAULT_ORG_TIMEZONE;
  return { name: String(org['name'] ?? ''), abn: typeof org['abn'] === 'string' ? org['abn'] : '', timeZone };
}

/** The receipt's items: kind, date and description, with the latest will marked current. */
export function receiptItems(items: readonly SafeCustodyItem[]) {
  const current = currentItemIndex(items);
  return items.map((item, index) => ({
    kind: SAFE_CUSTODY_ITEM_LABELS[item.kind] ?? item.kind,
    date: display(item.date),
    description: item.description ?? '',
    current: index === current,
  }));
}

/**
 * `safeCustody-receipt` (CORE-17, `safeCustody.edit`, idempotent): renders the testator's receipt
 * (`safe-custody-receipt`) as an export PDF through the jobs platform (FND-24). It names the firm,
 * the packet, the testator and each original, but not the cabinet or slot. Returns the job id; the
 * web app watches it, then fetches the file with `jobs-getExportUrl`.
 */
export const receiptDefinition = {
  name: SAFE_CUSTODY_CALLABLES.receipt,
  input: PacketReceiptInput,
  roles: PERMISSIONS['safeCustody.edit'],
  idempotent: true,
  handler: async (ctx): Promise<SafeCustodyPdfResult> => {
    const { input, orgId, db } = ctx;
    const packet = livePacket(await db.doc(packetPath(orgId, input.id)).get(), input.id);
    const [practice, testatorSnap] = await Promise.all([
      firm(db, orgId),
      db.doc(contactPath(orgId, String(packet['testatorContactId']))).get(),
    ]);
    const testator = testatorSnap.data() as (Partial<Contact> & Data) | undefined;
    const address = testator?.addresses?.[0];
    const clock = await orgClock(db, orgId, ctx.clock);
    const packetNo = String(packet['packetNo']);
    const { jobId } = await createJob(ctx, {
      type: 'pdf.render',
      input: {
        templateId: RECEIPT_TEMPLATE,
        data: {
          firmName: practice.name,
          firmAbn: practice.abn,
          packetNo,
          testatorName: testator ? contactDisplayName(testator) : String(packet['testatorName'] ?? ''),
          testatorAddress: address
            ? [address.line1, address.line2, `${address.suburb} ${address.state} ${address.postcode}`]
                .filter(Boolean)
                .join(', ')
            : '',
          receivedOn: display(packet['receivedOn']),
          site: (packet['location'] as SafeCustodyLocation | undefined)?.site ?? '',
          items: receiptItems((packet['items'] as SafeCustodyItem[] | undefined) ?? []),
          issuedOn: toDisplay(today(practice.timeZone, clock.now())),
        },
      },
      target: { kind: 'export', name: `Safe custody receipt ${packetNo}` },
    });
    return { jobId };
  },
} satisfies CallableDefinition<typeof PacketReceiptInput, SafeCustodyPdfResult>;

/** The stocktake's rows, grouped by site then cabinet, in location order. */
export function stocktakeGroups(packets: readonly Data[]) {
  const sites = new Map<string, Map<string, Data[]>>();
  for (const packet of packets) {
    const location = (packet['location'] ?? {}) as Partial<SafeCustodyLocation>;
    const site = location.site || 'No site';
    const cabinet = location.cabinet || 'No cabinet';
    const cabinets = sites.get(site) ?? new Map<string, Data[]>();
    sites.set(site, cabinets);
    cabinets.set(cabinet, [...(cabinets.get(cabinet) ?? []), packet]);
  }
  return [...sites].map(([site, cabinets]) => ({
    site,
    cabinets: [...cabinets].map(([cabinet, rows]) => ({
      cabinet,
      packets: rows.map((packet) => {
        const verified = packet['lastVerified'] as { on?: string } | undefined;
        return {
          packetNo: String(packet['packetNo'] ?? ''),
          testatorName: String(packet['testatorName'] ?? ''),
          slot: ((packet['location'] ?? {}) as Partial<SafeCustodyLocation>).slot ?? '',
          items: ((packet['items'] as SafeCustodyItem[] | undefined) ?? [])
            .map((item) => SAFE_CUSTODY_ITEM_LABELS[item.kind] ?? item.kind)
            .join(', '),
          lastVerified: display(verified?.on),
        };
      }),
    })),
  }));
}

/**
 * `safeCustody-stocktakeReport` (CORE-17, `safeCustody.edit`, idempotent): the annual stocktake
 * list as an export PDF (`safe-custody-stocktake`): every held packet (at one `site`, or all), by
 * site, cabinet and slot, with when each was last verified and a box to tick.
 */
export const stocktakeReportDefinition = {
  name: SAFE_CUSTODY_CALLABLES.stocktakeReport,
  input: StocktakeReportInput,
  roles: PERMISSIONS['safeCustody.edit'],
  idempotent: true,
  handler: async (ctx): Promise<SafeCustodyPdfResult> => {
    const { input, orgId, db } = ctx;
    const snap = await db
      .collection(packetsPath(orgId))
      .where('status', '==', 'held')
      .orderBy('locationKey')
      .limit(STOCKTAKE_REPORT_MAX)
      .get();
    const packets = snap.docs
      .map((doc) => doc.data())
      .filter((packet) => !packet['deletedAt'])
      .filter((packet) => !input.site || (packet['location'] as Partial<SafeCustodyLocation>)?.site === input.site)
      .sort((a, b) => String(a['locationKey'] ?? '').localeCompare(String(b['locationKey'] ?? '')));
    const practice = await firm(db, orgId);
    const clock = await orgClock(db, orgId, ctx.clock);
    const { jobId } = await createJob(ctx, {
      type: 'pdf.render',
      input: {
        templateId: STOCKTAKE_TEMPLATE,
        data: {
          firmName: practice.name,
          site: input.site ?? '',
          count: packets.length,
          preparedOn: toDisplay(today(practice.timeZone, clock.now())),
          sites: stocktakeGroups(packets),
        },
      },
      target: { kind: 'export', name: input.site ? `Safe custody stocktake ${input.site}` : 'Safe custody stocktake' },
    });
    return { jobId };
  },
} satisfies CallableDefinition<typeof StocktakeReportInput, SafeCustodyPdfResult>;

export const receipt = defineCallable(receiptDefinition);
export const stocktakeReport = defineCallable(stocktakeReportDefinition);
