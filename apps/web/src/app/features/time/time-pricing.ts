import { computed, inject, signal } from '@angular/core';

import { OrgContext } from '@materia/data-access';
import {
  dayTimeQuery,
  membersRepository,
  orgSettingsReadRepository,
  timeGroupRepository,
} from '@materia/data-access/repository';
import {
  BILLING_UNIT_MINUTES,
  computeTimeEntry,
  dayMinutes,
  type RateMatter,
  type RateMember,
  type RateOrg,
  type TimeEntryValues,
} from '@materia/domain';

/** The org's billing settings until they're read (or if they can't be): 6-minute units, rounded up. */
const FALLBACK: RateOrg['billing'] = { unitMinutes: BILLING_UNIT_MINUTES, rounding: 'up', defaultRateCents: 0 };

export interface TimePricing {
  unitMinutes: () => number;
  /** The units, rate and amount the server will snapshot for my entry (a preview it replaces). */
  preview(input: { minutes: number; date: string; matter: RateMatter | null | undefined }): TimeEntryValues;
}

/**
 * Prices my time entries before `time-onWrite` does (BILL-01): the org's billing settings and my
 * rate history, each read once (no listener). Create it in an injection context.
 */
export function timePricing(): TimePricing {
  const context = inject(OrgContext);
  const billing = signal<RateOrg['billing']>(FALLBACK);
  const me = signal<RateMember | null>(null);
  const orgId = context.orgId();
  const uid = context.uid();
  if (orgId) {
    orgSettingsReadRepository()
      .get(orgId)
      .then((org) => {
        const settings = org?.billing;
        if (settings)
          billing.set({
            unitMinutes: settings.unitMinutes ?? BILLING_UNIT_MINUTES,
            rounding: settings.rounding ?? 'up',
            defaultRateCents: settings.defaultRateCents ?? 0,
          });
      })
      .catch(() => undefined);
  }
  if (uid) {
    membersRepository()
      .get(uid)
      .then((member) => me.set(member ? { defaultRateCents: member.defaultRateCents, rates: member.rates } : null))
      .catch(() => undefined);
  }
  const unitMinutes = computed(() => billing().unitMinutes ?? BILLING_UNIT_MINUTES);
  return {
    unitMinutes,
    preview: ({ minutes, date, matter }) =>
      computeTimeEntry({ minutes, date, matter, member: me(), org: { billing: billing() } }),
  };
}

/**
 * Minutes a person has on a day across every matter (the 24-hour check, BILL-01), leaving out the
 * entry being edited: one read through the `timeEntries` group. `null` when it can't be read
 * (offline, say); the caller then counts what it has. Create it in an injection context.
 */
export function dayTime(): (uid: string, date: string, exceptId?: string) => Promise<number | null> {
  const group = timeGroupRepository();
  return async (uid, date, exceptId) => {
    try {
      const rows = await group.query(dayTimeQuery(uid, date));
      return dayMinutes(rows, uid, date, exceptId);
    } catch {
      return null;
    }
  };
}
