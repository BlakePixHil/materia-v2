import { domain } from '../domain.ts';
import { migratedMeta, type ReviewCode, type TransformContext, type TransformedRecord } from './context.ts';
import { fyStartYear } from './dates.ts';
import { centsOf, cleanText } from './values.ts';
import type { ExportRecord } from '../export/jsonl.ts';
import type { StorageObject } from '../legacy/snapshot.ts';

const { DEFAULT_USER_PREFS, newOrgSecurity } = domain;

/**
 * `profiles/{U}` → `users/{U}`, the user's membership `orgs/{O}/members/{U}` (owner) and, for a
 * new target org, `orgs/{O}` itself (Legacy migration plan, Mapping). The prime workspace merges
 * into the org; the profile photo becomes a copy to `users/{U}/avatar.png`. The org's defaults
 * mirror `newOrgDoc` (apps/functions/src/orgs/create-org.ts) and the member's `newMember`
 * (apps/functions/src/orgs/shared.ts), so a migrated practice starts like a new one.
 */

/** The account's name parts: the profile's, else the Auth record's email. */
export interface Subject {
  displayName: string;
  firstName: string;
  lastName: string;
  email: string;
}

export function subjectOf(profile: Record<string, unknown> | null, auth: Record<string, unknown> | null): Subject {
  const email = (cleanText(profile?.['email']) || cleanText(auth?.['email'])).toLowerCase();
  const firstName = cleanText(profile?.['firstName']);
  const lastName = cleanText(profile?.['lastName']);
  const displayName =
    cleanText(profile?.['displayName']) ||
    [firstName, lastName].filter(Boolean).join(' ') ||
    email.split('@')[0] ||
    'Member';
  return { displayName, firstName, lastName, email };
}

/** The org's name (D-09): the profile's, else the legacy company name, else "{name}'s practice". */
export function orgNameOf(ctx: TransformContext, profile: Record<string, unknown> | null, subject: Subject) {
  if (ctx.profile.org.name) return { name: ctx.profile.org.name, confirmed: true };
  return { name: cleanText(profile?.['companyName']) || `${subject.displayName}'s practice`, confirmed: false };
}

export interface ProfileInput {
  profile: ExportRecord | undefined;
  auth: ExportRecord | undefined;
  /** Whether the transform creates the org (`--target-org new`). */
  newOrg: boolean;
  /** The profile photo, when legacy Storage has one. */
  photo: StorageObject | undefined;
}

export interface ProfileResult {
  records: TransformedRecord[];
  subject: Subject;
  orgName: string;
}

export function mapProfile(ctx: TransformContext, input: ProfileInput): ProfileResult {
  const legacyPath = input.profile?.path ?? `profiles/${ctx.uid}`;
  const data = input.profile?.data ?? null;
  const subject = subjectOf(data, input.auth?.data ?? null);
  const org = orgNameOf(ctx, data, subject);
  const records: TransformedRecord[] = [];
  const at = { createdAt: ctx.asOf, updatedAt: ctx.asOf };

  if (input.newOrg) {
    const review: ReviewCode[] = [];
    if (!org.confirmed) {
      review.push('org_name_unconfirmed');
      ctx.warnings.add('MIG_W_ORG_NAME_UNCONFIRMED', legacyPath);
    }
    const jurisdiction = ctx.profile.org.jurisdiction;
    records.push({
      entity: 'orgs',
      path: `orgs/${ctx.orgId}`,
      legacyPath: `${legacyPath}#org`,
      data: {
        name: org.name,
        practiceType: 'wills_estates',
        jurisdictions: [jurisdiction],
        primaryJurisdiction: jurisdiction,
        timezone: ctx.timeZone,
        holidayLocality: 'VIC_MELBOURNE',
        billing: {
          unitMinutes: 6,
          rounding: 'up',
          gstRegistered: true,
          defaultRateCents: 0,
          invoicePrefix: 'INV-',
          paymentTermsDays: 14,
        },
        matterNumberFormat: domain.DEFAULT_MATTER_NUMBER_FORMAT,
        fy: { startMonth: 7 },
        retentionYears: 7,
        plan: 'trial',
        // MFA from the start (SEC-04); the load restamps the grace from its own time.
        security: newOrgSecurity(ctx.asOf),
        ...migratedMeta(ctx, { legacyPath: `${legacyPath}#org`, ...at, by: ctx.uid, needsReview: review }),
      },
    });
  }

  records.push({
    entity: 'users',
    path: `users/${ctx.uid}`,
    legacyPath,
    data: {
      email: subject.email,
      displayName: subject.displayName,
      firstName: subject.firstName,
      lastName: subject.lastName,
      orgIds: [ctx.orgId],
      activeOrgId: ctx.orgId,
      claimsVersion: 0,
      // auth-syncClaims rewrites these from the member document after the load.
      memberships: { [ctx.orgId]: { role: 'owner', name: org.name } },
      prefs: DEFAULT_USER_PREFS,
      legacy: { uid: ctx.uid, migratedAt: ctx.asOf },
      ...migratedMeta(ctx, { legacyPath, ...at, by: ctx.uid }),
    },
  });

  const budgets = mapBudgets(ctx, data, legacyPath);
  records.push({
    entity: 'members',
    path: `orgs/${ctx.orgId}/members/${ctx.uid}`,
    legacyPath: `${legacyPath}#member`,
    data: {
      role: 'owner',
      status: 'active',
      ...(subject.email ? { email: subject.email } : {}),
      displayName: subject.displayName,
      initials: initialsOf(subject.displayName),
      title: '',
      defaultRateCents: 0,
      rates: [],
      colour: colourFor(ctx.uid),
      budgets,
      ...migratedMeta(ctx, {
        legacyPath: `${legacyPath}#member`,
        ...at,
        by: ctx.uid,
        ...(Object.keys(budgets).length ? { needsReview: ['budgets_imported'] } : {}),
      }),
    },
  });

  if (input.photo) {
    records.push({
      entity: 'avatars',
      path: `users/${ctx.uid}/avatar.png`,
      legacyPath: input.photo.name,
      copy: {
        source: input.photo.name,
        target: `users/${ctx.uid}/avatar.png`,
        fileName: 'avatar.png',
        mime: input.photo.contentType ?? 'image/png',
        sizeBytes: input.photo.size,
        ...(input.photo.md5Hash ? { md5Hash: input.photo.md5Hash } : {}),
        ...(input.photo.crc32c ? { crc32c: input.photo.crc32c } : {}),
        ...(input.photo.generation ? { generation: input.photo.generation } : {}),
      },
    });
  }
  return { records, subject, orgName: org.name };
}

/**
 * The profile's budgets (`currentFinancialYearBudget` for `budgetFinancialYear`, and the
 * `previous*` pair) as `budgets[fyStartYear] = cents`. The legacy year is read as the year the
 * financial year starts, v2's key. Legacy rolled a budget over when its year passed, leaving the
 * new year without one: each budget keeps its own year here, and a profile whose budgets are all
 * for earlier years warns that this year has none. A budget without a year is read as this year's.
 */
export function mapBudgets(
  ctx: TransformContext,
  profile: Record<string, unknown> | null,
  legacyPath: string,
): Record<string, number> {
  const budgets: Record<string, number> = {};
  const current = fyStartYear(ctx.asOf, ctx.timeZone);
  const pairs: [string, string, number][] = [
    ['currentFinancialYearBudget', 'budgetFinancialYear', current],
    ['previousFinancialYearBudget', 'previousBudgetFinancialYear', current - 1],
  ];
  if (!profile || !pairs.some(([amount]) => amount in profile)) {
    ctx.warnings.add('MIG_W_BUDGET_MISSING', legacyPath);
    return budgets;
  }
  for (const [amountField, yearField, fallback] of pairs) {
    const cents = centsOf(ctx, profile[amountField]);
    if (cents === undefined) continue;
    const raw = profile[yearField];
    const year = typeof raw === 'number' && Number.isInteger(raw) && raw >= 2000 && raw <= 9999 ? raw : undefined;
    if (year === undefined) ctx.warnings.add('MIG_W_BUDGET_YEAR_MISSING', legacyPath);
    const key = String(year ?? fallback);
    // A previous budget never overwrites the current one for the same year.
    if (!(key in budgets)) budgets[key] = cents;
  }
  const years = Object.keys(budgets).map(Number);
  if (years.length && Math.max(...years) < current) ctx.warnings.add('MIG_W_BUDGET_ROLLED_OVER', legacyPath);
  return budgets;
}

/** Two letters from a display name ("Priya Shah" → "PS"), as `initialsOf` in apps/functions. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts.at(-1)?.[0] ?? ''}` : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase() || '?';
}

const COLOURS = ['#346CFC', '#0E9F6E', '#C2410C', '#7C3AED', '#0891B2', '#BE185D', '#4D7C0F', '#B45309'];

/** A stable avatar colour for a uid, as `colourFor` in apps/functions. */
export function colourFor(uid: string): string {
  let hash = 0;
  for (const char of uid) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLOURS[hash % COLOURS.length] as string;
}
