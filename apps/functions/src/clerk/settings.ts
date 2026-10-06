import { FieldValue } from 'firebase-admin/firestore';

import {
  CLERK_DISCLOSURE_VERSION,
  DomainError,
  OrgClerkSettingsSchema,
  PERMISSIONS,
  UpdateClerkSettingsInput,
  type OrgClerkSettings,
  type UpdateClerkSettingsResult,
} from '@materia/domain';

import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';

/**
 * `clerk-updateSettings` (AI-13): owners and admins turn Clerk on or off for the org and per
 * feature, set the monthly spend limit (US cents), the per-person daily request limit and the daily
 * OCR page limit (AI-04), and acknowledge the data-use disclosure. Only the fields sent change;
 * `null` clears a limit (the OCR limit goes back to its default). The
 * acknowledgement must name the current disclosure version, and records who and when. Each change
 * is audited as `clerk.settings_changed` with what it was and what it became. The gateway reads the
 * result on the next call. A spend limit below this month's spend is allowed (the page confirms
 * it first): Clerk is then blocked for the rest of the month.
 */
export const updateSettingsDefinition = {
  name: 'clerk-updateSettings',
  input: UpdateClerkSettingsInput,
  roles: PERMISSIONS['clerk.configure'],
  idempotent: true,
  handler: async (ctx): Promise<UpdateClerkSettingsResult> => {
    const { input, uid, orgId, db, clock, log } = ctx;
    if (input.acknowledgeVersion !== undefined && input.acknowledgeVersion !== CLERK_DISCLOSURE_VERSION) {
      throw new DomainError('FAILED_PRECONDITION', 'That isn’t the current Clerk disclosure', {
        reason: 'disclosure_outdated',
        current: CLERK_DISCLOSURE_VERSION,
      });
    }
    const orgRef = db.doc(`orgs/${orgId}`);
    const at = clock.now();

    const changes = await db.runTransaction(async (tx) => {
      const org = await tx.get(orgRef);
      if (!org.exists) throw new DomainError('NOT_FOUND', 'Org not found');
      const parsed = OrgClerkSettingsSchema.safeParse(org.get('settings.clerk') ?? {});
      const before: OrgClerkSettings = parsed.success ? parsed.data : {};
      const update: Record<string, unknown> = {};
      const diff: Record<string, { from: unknown; to: unknown }> = {};
      const set = (field: string, from: unknown, to: unknown) => {
        if (from === to) return;
        diff[field] = { from: from ?? null, to: to ?? null };
      };

      if (input.enabled !== undefined) {
        set('enabled', before.enabled ?? true, input.enabled);
        update['settings.clerk.enabled'] = input.enabled;
      }
      for (const [key, on] of Object.entries(input.features ?? {})) {
        set(`features.${key}`, before.features?.[key as keyof typeof before.features] ?? true, on);
        update[`settings.clerk.features.${key}`] = on;
      }
      for (const field of ['monthlyBudgetCents', 'perUserDailyRequests', 'ocrDailyPages'] as const) {
        const value = input[field];
        if (value === undefined) continue;
        set(field, before[field], value ?? undefined);
        update[`settings.clerk.${field}`] = value ?? null;
      }
      if (input.acknowledgeVersion !== undefined && before.ackVersion !== input.acknowledgeVersion) {
        set('acknowledgement', before.ackVersion, input.acknowledgeVersion);
        Object.assign(update, {
          'settings.clerk.acknowledgedAt': at,
          'settings.clerk.acknowledgedBy': uid,
          'settings.clerk.ackVersion': input.acknowledgeVersion,
        });
      }
      if (!Object.keys(diff).length) return diff;
      // A cleared limit is deleted rather than stored as null (the schema has no nulls).
      for (const [path, value] of Object.entries(update)) if (value === null) update[path] = FieldValue.delete();
      tx.update(orgRef, { ...update, updatedAt: at, updatedBy: uid });
      return diff;
    });

    const changed = Object.keys(changes);
    if (changed.length) {
      await audit(ctx, {
        action: 'clerk.settings_changed',
        entity: { path: `orgs/${orgId}/settings/clerk` },
        summary: changes['acknowledgement']
          ? `Clerk data-use disclosure version ${String(changes['acknowledgement'].to)} acknowledged`
          : `Clerk settings changed: ${changed.join(', ')}`,
        data: { changes },
      });
    }
    log.info('clerk settings updated', { changed });
    return { changed };
  },
} satisfies CallableDefinition<typeof UpdateClerkSettingsInput, UpdateClerkSettingsResult>;

export const updateSettings = defineCallable(updateSettingsDefinition);
