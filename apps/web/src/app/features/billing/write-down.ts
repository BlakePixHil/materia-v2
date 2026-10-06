import type { TimeCallables } from '@materia/data-access/repository';
import { BILLING_UNIT_MINUTES } from '@materia/domain';
import type { DialogService, ToastService } from '@materia/ui';

import { expectedUpdatedAt, reviewSummary } from './billing-view';
import { WriteDownDialog, type WriteDownDialogData, type WriteDownDialogResult } from './review-dialogs';

/** The `time-writeDown` fields for what the write-down dialog chose. */
export function writeDownFields(change: WriteDownDialogResult) {
  return {
    reason: change.reason,
    ...('writeOff' in change
      ? { writeOff: true as const }
      : 'percent' in change
        ? { percent: change.percent }
        : { newUnits: change.newUnits }),
  };
}

/** An entry as a write-down needs it: the dialog's preview, and when it was last seen. */
export type WriteDownEntry = WriteDownDialogData['entries'][number] & {
  id: string;
  updatedAt?: Date | null | undefined;
};

/**
 * Writes one matter's time down or off where it's listed outside the Approvals tab (BILL-07b: the
 * pre-bill and the matter's Time tab): asks with the write-down dialog, then calls `time-writeDown`.
 * Toasts when the entry changed meanwhile or nothing changed. Resolves with a sentence saying what
 * happened, or `null` when cancelled. Throws what the callable throws.
 */
export async function writeDownTime(
  ui: { dialogs: DialogService; toasts: ToastService },
  api: Pick<TimeCallables, 'writeDown'>,
  matterId: string,
  entries: WriteDownEntry[],
  unitMinutes: number | undefined,
): Promise<string | null> {
  const change = await ui.dialogs.open<WriteDownDialogData, WriteDownDialogResult | undefined>(WriteDownDialog, {
    data: { entries, unitMinutes: unitMinutes ?? BILLING_UNIT_MINUTES },
  }).result;
  if (!change) return null;
  const result = await api.writeDown({
    matterId,
    entryIds: entries.map((entry) => entry.id),
    expectedUpdatedAt: expectedUpdatedAt(entries),
    ...writeDownFields(change),
  });
  const summary = reviewSummary(result, 'writeOff' in change ? 'Wrote off' : 'Wrote down');
  if (result.conflicts.length || !result.updated.length)
    ui.toasts.show({ title: 'The time wasn’t changed', description: summary, tone: 'neutral' });
  return summary;
}
