import {
  BILLING_UNIT_MINUTES,
  can,
  isUnbilledWip,
  PERMISSIONS,
  TIME_EXPORT_MAX_ROWS,
  timeEntriesCsv,
  TimeExportInput,
  type TimeCsvRow,
} from '@materia/domain';

import { audit } from '../audit/audit';
import { isDeleted } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';

type Data = Record<string, unknown>;

export interface TimeExportResult {
  csv: string;
  rows: number;
  /** More entries matched than an export holds: narrow the dates. */
  truncated: boolean;
}

/**
 * `time-exportCsv` (BILL-03; `time.approve`, lawyers and above): live time entries dated `from` to
 * `to` as CSV, oldest first, optionally for one person, one status, unbilled WIP only, or matters
 * of one responsible lawyer or type. Entries on privileged matters are left out for roles without
 * privileged.view (every approver has it today), and on deleted matters always. Up to
 * TIME_EXPORT_MAX_ROWS rows. Audited as `time.exported` (counts and filters, never narratives).
 */
export const exportCsvDefinition = {
  name: 'time-exportCsv',
  input: TimeExportInput,
  roles: PERMISSIONS['time.approve'],
  handler: async (ctx): Promise<TimeExportResult> => {
    const { input, orgId, role, db, log } = ctx;
    let query = db.collectionGroup('timeEntries').where('orgId', '==', orgId);
    if (input.uid) query = query.where('uid', '==', input.uid);
    else if (input.status) query = query.where('status', '==', input.status);
    const snap = await query
      .where('date', '>=', input.from)
      .where('date', '<=', input.to)
      .orderBy('date', 'asc')
      .limit(TIME_EXPORT_MAX_ROWS * 2)
      .get();
    const entries = snap.docs
      .map((doc) => doc.data() as Data)
      .filter((entry) => !isDeleted(entry))
      .filter((entry) => !input.status || entry['status'] === input.status)
      .filter(
        (entry) =>
          !input.unbilledOnly ||
          isUnbilledWip({
            matterId: String(entry['matterId']),
            date: String(entry['date']),
            amountCents: Number(entry['amountCents']),
            billable: entry['billable'] === true,
            status: String(entry['status']),
            invoiceId: entry['invoiceId'] as string | undefined,
          }),
      );

    const matterIds = [...new Set(entries.map((entry) => String(entry['matterId'])))];
    const uids = [...new Set(entries.map((entry) => String(entry['uid'])))];
    const [matterSnaps, memberSnaps, org] = await Promise.all([
      matterIds.length ? db.getAll(...matterIds.map((id) => db.doc(`orgs/${orgId}/matters/${id}`))) : [],
      uids.length ? db.getAll(...uids.map((id) => db.doc(`orgs/${orgId}/members/${id}`))) : [],
      db.doc(`orgs/${orgId}`).get(),
    ]);
    const matters = new Map(
      matterSnaps.flatMap((matter) => {
        const data = matter.data();
        if (!data || isDeleted(data)) return [];
        if (data['privileged'] === true && !can(role, 'privileged.view')) return [];
        if (input.responsibleUid && data['responsibleUid'] !== input.responsibleUid) return [];
        if (input.matterType && data['type'] !== input.matterType) return [];
        return [[matter.id, data] as const];
      }),
    );
    const names = new Map(memberSnaps.map((member) => [member.id, String(member.get('displayName') ?? member.id)]));
    const unitMinutes = Number(org.get('billing.unitMinutes')) || BILLING_UNIT_MINUTES;

    const kept = entries
      .filter((entry) => matters.has(String(entry['matterId'])))
      .sort((a, b) => String(a['date']).localeCompare(String(b['date'])));
    const rows: TimeCsvRow[] = kept.slice(0, TIME_EXPORT_MAX_ROWS).map((entry) => {
      const matter = matters.get(String(entry['matterId'])) as Data;
      const writeDown = entry['writeDown'] as { originalAmountCents?: number; reason?: string } | undefined;
      return {
        date: String(entry['date']),
        matterNumber: String(matter['number'] ?? ''),
        matterTitle: String(matter['title'] ?? ''),
        person: names.get(String(entry['uid'])) ?? String(entry['uid']),
        narrative: String(entry['narrative'] ?? ''),
        minutes: Number(entry['minutes']) || 0,
        units: Number(entry['units']) || 0,
        unitMinutes,
        rateCents: Number(entry['rateCents']) || 0,
        amountCents: Number(entry['amountCents']) || 0,
        billable: entry['billable'] === true,
        status: String(entry['status']),
        originalAmountCents: writeDown?.originalAmountCents,
        writeDownReason: writeDown?.reason,
      };
    });
    const truncated = kept.length > TIME_EXPORT_MAX_ROWS || snap.size >= TIME_EXPORT_MAX_ROWS * 2;
    await audit(ctx, {
      action: 'time.exported',
      entity: { path: `orgs/${orgId}/members/${ctx.uid}` },
      summary: `Time exported (${rows.length} entries)`,
      data: {
        rows: rows.length,
        from: input.from,
        to: input.to,
        ...(input.uid ? { uid: input.uid } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.unbilledOnly ? { unbilledOnly: true } : {}),
        ...(input.responsibleUid ? { responsibleUid: input.responsibleUid } : {}),
        ...(input.matterType ? { matterType: input.matterType } : {}),
      },
    });
    log.info('time exported', { rows: rows.length, truncated });
    return { csv: timeEntriesCsv(rows), rows: rows.length, truncated };
  },
} satisfies CallableDefinition<typeof TimeExportInput, TimeExportResult>;

export const exportCsv = defineCallable(exportCsvDefinition);
