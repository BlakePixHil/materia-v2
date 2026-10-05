import { FieldValue } from 'firebase-admin/firestore';

import {
  DomainError,
  MemberSecurityInput,
  PERMISSIONS,
  UpdateOrgSettingsInput,
  type MemberSecurity,
  type OrgSettingsImpact,
  type UpdateOrgSettingsResult,
} from '@materia/domain';

import { syncClaims } from './claims';
import { audit } from '../audit/audit';
import { isDeleted } from '../contacts/shared';
import { defineCallable, type CallableContext, type CallableDefinition } from '../core/callable';
import { remindable } from '../reminders/schedule';

type Data = Record<string, unknown>;
type Input = ReturnType<typeof UpdateOrgSettingsInput.parse>;

/** Open matters (not closed, archived or deleted) block removing their jurisdiction. */
const OPEN_STATUSES = new Set(['lead', 'open', 'on_hold']);
/** At most this many blocking matters are listed back. */
const MAX_LISTED = 20;

/** JSON with object keys sorted, so stored and submitted values compare equal whatever their key order. */
const canonical = (value: unknown) =>
  JSON.stringify(value ?? null, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** The org fields the input sets (an empty ABN is `undefined`: removed). */
function valuesOf(input: Input): Data {
  const patch: Data = {};
  if (input.practice) Object.assign(patch, input.practice, { abn: input.practice.abn || undefined });
  if (input.billing) patch['billing'] = input.billing;
  if (input.feeDefaults) patch['feeDefaults'] = input.feeDefaults;
  if (input.matterNumberFormat !== undefined) patch['matterNumberFormat'] = input.matterNumberFormat;
  if (input.matterTypeCodes) patch['matterTypeCodes'] = input.matterTypeCodes;
  return patch;
}

/** Open matters in the jurisdictions being removed. */
async function mattersUsing(
  ctx: CallableContext<Input>,
  removed: string[],
): Promise<OrgSettingsImpact['jurisdictionInUse']> {
  if (!removed.length) return [];
  const snap = await ctx.db.collection(`orgs/${ctx.orgId}/matters`).where('jurisdiction', 'in', removed).get();
  return snap.docs
    .filter((doc) => OPEN_STATUSES.has(doc.get('status') as string) && !isDeleted(doc.data()))
    .slice(0, MAX_LISTED)
    .map((doc) => ({
      matterId: doc.id,
      number: String(doc.get('number') ?? ''),
      title: String(doc.get('title') ?? ''),
      jurisdiction: String(doc.get('jurisdiction')),
    }));
}

/** Upcoming deadlines whose reminders `reminders-onOrgWrite` will move. */
async function remindersToMove(ctx: CallableContext<Input>): Promise<number> {
  const snap = await ctx.db
    .collectionGroup('deadlines')
    .where('orgId', '==', ctx.orgId)
    .where('status', '==', 'upcoming')
    .get();
  return snap.docs.filter((doc) => remindable(doc.data())).length;
}

/**
 * `orgs-updateSettings` (CORE-21): owners and admins save the practice details, billing settings,
 * fee defaults and matter numbering. Removing a jurisdiction that open matters use is refused
 * (`details.matters` lists them). A time zone or holiday locality change moves the reminders
 * (`reminders-onOrgWrite`); `dryRun` reports how many first, for the confirmation. A new number
 * format applies to new matters only. A rename updates every member's claims. Audited.
 */
export const updateSettingsDefinition = {
  name: 'orgs-updateSettings',
  input: UpdateOrgSettingsInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  handler: async (ctx): Promise<UpdateOrgSettingsResult> => {
    const { input, orgId, uid, db, clock, requestId, log } = ctx;
    const orgRef = db.doc(`orgs/${orgId}`);
    const org = (await orgRef.get()).data();
    if (!org) throw new DomainError('NOT_FOUND', 'Organisation not found');

    const values = valuesOf(input);
    const changed = Object.keys(values).filter((key) => !same(values[key], org[key]));
    const patch = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, value === undefined ? FieldValue.delete() : value]),
    );
    const practice = input.practice;
    const removed = practice
      ? ((org['jurisdictions'] as string[] | undefined) ?? []).filter(
          (j) => !practice.jurisdictions.includes(j as never),
        )
      : [];
    const calendarMoves =
      !!practice && (practice.timezone !== org['timezone'] || practice.holidayLocality !== org['holidayLocality']);
    const gstChanged =
      !!input.billing && input.billing.gstRegistered !== (org['billing'] as Data | undefined)?.['gstRegistered'];

    const impact: OrgSettingsImpact = {
      remindersRescheduled: calendarMoves ? await remindersToMove(ctx) : 0,
      jurisdictionInUse: await mattersUsing(ctx, removed),
      gstChanged,
      changed,
    };
    if (impact.jurisdictionInUse.length) {
      if (input.dryRun) return { saved: false, impact };
      throw new DomainError('FAILED_PRECONDITION', 'Open matters use a jurisdiction being removed', {
        matters: impact.jurisdictionInUse.map((m) => m.matterId),
        jurisdictions: removed,
      });
    }

    const counterRef = db.doc(`orgs/${orgId}/counters/invoices`);
    if (input.nextInvoiceNumber !== undefined) {
      const counter = await counterRef.get();
      if (input.nextInvoiceNumber !== counter.get('next')) {
        const issued = await db.collection(`orgs/${orgId}/invoices`).limit(1).get();
        if (!issued.empty) {
          throw new DomainError('FAILED_PRECONDITION', 'Invoice numbers are gapless once the first invoice exists');
        }
        changed.push('nextInvoiceNumber');
      }
    }
    if (input.dryRun || !changed.length) return { saved: false, impact };

    const now = clock.now();
    const batch = db.batch();
    batch.update(orgRef, { ...patch, updatedAt: now, updatedBy: uid, _requestId: requestId });
    if (changed.includes('nextInvoiceNumber')) {
      batch.set(counterRef, { next: input.nextInvoiceNumber }, { merge: true });
    }
    await batch.commit();

    if (changed.includes('name')) await resyncMembers(ctx);
    await audit(ctx, {
      action: 'org.settings_updated',
      // The audit entity is a document inside the org: the caller's membership (as `org.created`).
      entity: { path: `orgs/${orgId}/members/${uid}` },
      summary: `Settings changed: ${changed.join(', ')}`,
      data: { changed, remindersRescheduled: impact.remindersRescheduled, gstChanged },
    });
    log.info('org settings updated', { orgId, changed });
    return { saved: true, impact };
  },
} satisfies CallableDefinition<typeof UpdateOrgSettingsInput, UpdateOrgSettingsResult>;

/** The org's name is in every member's claims and `users/{uid}.memberships`. */
async function resyncMembers(ctx: CallableContext<Input>): Promise<void> {
  const members = await ctx.db.collection(`orgs/${ctx.orgId}/members`).where('status', '==', 'active').get();
  for (const member of members.docs) {
    await syncClaims({ db: ctx.db, auth: ctx.auth(), now: ctx.clock.now() }, member.id, { alsoOrgIds: [ctx.orgId] });
  }
}

const iso = (value: string | undefined) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * `orgs-memberSecurity` (CORE-21): each member's MFA enrolment and last sign-in, from Auth, for the
 * team table (owners and admins). Only uids that are members of the caller's org are looked up.
 */
export const memberSecurityDefinition = {
  name: 'orgs-memberSecurity',
  input: MemberSecurityInput,
  roles: PERMISSIONS['members.manage'],
  handler: async ({ input, orgId, db, auth }): Promise<{ members: MemberSecurity[] }> => {
    const refs = input.uids.map((uid) => db.doc(`orgs/${orgId}/members/${uid}`));
    const snaps = await db.getAll(...refs);
    const uids = snaps.filter((snap) => snap.exists).map((snap) => snap.id);
    if (!uids.length) return { members: [] };
    const { users } = await auth().getUsers(uids.map((uid) => ({ uid })));
    const byUid = new Map(users.map((user) => [user.uid, user]));
    return {
      members: uids.map((uid) => {
        const user = byUid.get(uid);
        return {
          uid,
          mfaEnrolled: (user?.multiFactor?.enrolledFactors.length ?? 0) > 0,
          lastSignInAt: iso(user?.metadata.lastSignInTime),
          lastActiveAt: iso(user?.metadata.lastRefreshTime ?? user?.metadata.lastSignInTime),
        };
      }),
    };
  },
} satisfies CallableDefinition<typeof MemberSecurityInput, { members: MemberSecurity[] }>;

export const updateSettings = defineCallable(updateSettingsDefinition);
export const memberSecurity = defineCallable(memberSecurityDefinition);
