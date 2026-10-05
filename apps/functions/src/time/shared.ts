import { computeTimeEntry, wipContribution, type RateMatter, type RateMember, type RateOrg } from '@materia/domain';

import { matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

export const timeEntryPath = (orgId: string, matterId: string, entryId: string) =>
  `${matterPath(orgId, matterId)}/timeEntries/${entryId}`;

/** What an entry's rate is resolved from; `null` when the org has no billing settings. */
export interface TimeRateInputs {
  org: RateOrg;
  matter: RateMatter | null;
  member: RateMember | null;
}

export interface TimeSyncPlan {
  /** Fields to write on the entry (recomputed values, `wipCountedCents`). */
  patch: Data;
  /** What to add to the matter's `wipCents`. */
  wipDelta: number;
}

const counted = (data: Data | undefined): number => {
  const value = data?.['wipCountedCents'];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0;
};

/** The org fields `computeTimeEntry` needs, or `null` when `billing` is missing or malformed. */
export function rateOrg(org: Data | undefined): RateOrg | null {
  const billing = org?.['billing'] as Data | undefined;
  if (!billing || typeof billing['defaultRateCents'] !== 'number') return null;
  return {
    billing: {
      defaultRateCents: billing['defaultRateCents'],
      rounding: billing['rounding'] === 'nearest' ? 'nearest' : 'up',
      ...(typeof billing['unitMinutes'] === 'number' ? { unitMinutes: billing['unitMinutes'] } : {}),
    },
  };
}

/**
 * What `time-onWrite` writes for an entry's current state (`current`; `before` only matters once
 * the document is gone). A live draft gets `units`, `rateCents` and `amountCents` recomputed from
 * the rate in force on its date, overwriting whatever the client wrote; final, billed and
 * written-off entries keep their snapshot. Then the entry's WIP contribution is compared with what
 * it has counted so far (`wipCountedCents`), and the difference goes to the matter. Planning the
 * next event against its own write finds nothing to do, so it doesn't loop.
 */
export function planTimeSync(
  current: Data | undefined,
  before: Data | undefined,
  inputs: TimeRateInputs | null,
): TimeSyncPlan {
  if (!current) return { patch: {}, wipDelta: -counted(before) };
  const patch: Data = {};
  const minutes = current['minutes'];
  const date = current['date'];
  if (
    inputs &&
    current['status'] === 'draft' &&
    !current['deletedAt'] &&
    typeof minutes === 'number' &&
    Number.isSafeInteger(minutes) &&
    minutes >= 0 &&
    typeof date === 'string'
  ) {
    const values = computeTimeEntry({ minutes, date, ...inputs });
    for (const key of ['units', 'rateCents', 'amountCents'] as const) {
      if (current[key] !== values[key]) patch[key] = values[key];
    }
  }
  const contribution = wipContribution({ ...current, ...patch });
  const wipDelta = contribution - counted(current);
  if (wipDelta || current['wipCountedCents'] === undefined) patch['wipCountedCents'] = contribution;
  return { patch, wipDelta };
}
