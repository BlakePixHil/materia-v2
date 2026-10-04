import { z } from 'zod';

import { DUPLICATE_THRESHOLD, type DuplicateProbe, type DuplicateReason } from './contacts';
import { DocIdSchema, InstantSchema, withMeta } from './schemas/common';
import { MatterStatusSchema, MatterTypeSchema, PartyRoleSchema } from './schemas/enums';
import type { MatterType, PartyRole } from './schemas/enums';

/**
 * Conflict checks (CORE-02): the subjects of a prospective matter are scored against the org's
 * contacts with the CORE-01 duplicate scorer, and each matching contact's party rows (every
 * matter, closed and archived included) are reported with their roles. A lawyer records the
 * determination; `matters-changeStatus` refuses `lead → open` until it is `clear` or `potential`.
 */

// ---------- subjects ----------

export const ConflictSubjectSchema = z.object({
  kind: z.enum(['person', 'organisation']).default('person'),
  /** Full name as typed ("Margaret Anne Ellis") or the organisation's name. */
  name: z.string().trim().min(1).max(200),
  dob: z.string().max(10).optional(),
  email: z.string().max(320).optional(),
  phone: z.string().max(30).optional(),
  abn: z.string().max(20).optional(),
  /** The role the subject would have on the new matter. */
  role: PartyRoleSchema,
  /** The contact the subject was picked from, when known: it is reported as "this person", not as a hit. */
  contactId: DocIdSchema.optional(),
});
export type ConflictSubject = z.input<typeof ConflictSubjectSchema>;

/** A subject as a duplicate-scorer probe. A person's last word is the family name. */
export function subjectProbe(subject: ConflictSubject): DuplicateProbe {
  const parsed = ConflictSubjectSchema.parse(subject);
  const common = {
    dateOfBirth: parsed.dob,
    emails: parsed.email ? [parsed.email] : [],
    phones: parsed.phone ? [parsed.phone] : [],
  };
  if (parsed.kind === 'organisation' || parsed.abn) {
    return { kind: 'organisation', orgName: parsed.name, abn: parsed.abn?.replace(/\s+/g, ''), ...common };
  }
  const words = parsed.name.split(/\s+/).filter(Boolean);
  const familyName = words.length > 1 ? words[words.length - 1] : undefined;
  const givenNames = words.length > 1 ? words.slice(0, -1).join(' ') : words[0];
  return { kind: 'person', givenNames, familyName, ...common };
}

/** Contacts scoring at or above this are hits. The same bar as duplicate detection (CORE-01). */
export const CONFLICT_HIT_THRESHOLD = DUPLICATE_THRESHOLD;

// ---------- adverse roles ----------

/**
 * Role pairs that are adverse: a subject in the first role against an existing party in the
 * second (either way round). `matterTypes` limits a pair to those types of the existing matter.
 * Practitioner review (CORE-02a) signs this off before the `conflicts.enforced` flag is on in prod.
 */
export interface AdverseRolePair {
  roles: readonly [PartyRole, PartyRole];
  matterTypes?: readonly MatterType[];
  label: string;
}

export const ADVERSE_ROLE_PAIRS: readonly AdverseRolePair[] = [
  { roles: ['client', 'defendant'], label: 'Client against a defendant' },
  { roles: ['client', 'plaintiff'], label: 'Client against a plaintiff' },
  {
    roles: ['executor', 'plaintiff'],
    matterTypes: ['fp', 'contest'],
    label: 'Executor against a family provision plaintiff',
  },
  { roles: ['administrator', 'plaintiff'], matterTypes: ['fp', 'contest'], label: 'Administrator against a plaintiff' },
  { roles: ['beneficiary', 'plaintiff'], label: 'Beneficiary against a plaintiff' },
  { roles: ['client', 'other_side_solicitor'], label: 'Client is represented by the other side' },
];

/** The adverse pair a subject role and an existing party role form, if any. */
export function adversePair(
  subjectRole: PartyRole,
  existingRole: PartyRole,
  existingMatterType?: MatterType,
  pairs: readonly AdverseRolePair[] = ADVERSE_ROLE_PAIRS,
): AdverseRolePair | undefined {
  return pairs.find(({ roles: [a, b], matterTypes }) => {
    const matches = (subjectRole === a && existingRole === b) || (subjectRole === b && existingRole === a);
    return matches && (!matterTypes || (existingMatterType !== undefined && matterTypes.includes(existingMatterType)));
  });
}

// ---------- results ----------

export const ConflictHitMatterSchema = z.object({
  matterId: DocIdSchema,
  number: z.string(),
  title: z.string(),
  status: MatterStatusSchema,
  type: MatterTypeSchema,
  role: PartyRoleSchema,
  /** Set when the role is adverse to the subject's role on the new matter. */
  adverse: z.string().optional(),
  deleted: z.boolean().optional(),
});
export type ConflictHitMatter = z.infer<typeof ConflictHitMatterSchema>;

export const ConflictHitSchema = z.object({
  /** Index into the run's subjects. */
  subject: z.number().int().min(0),
  contactId: DocIdSchema,
  displayName: z.string(),
  score: z.number().min(0).max(1),
  reasons: z.array(z.enum(['name', 'dateOfBirth', 'email', 'phone', 'abn'] satisfies DuplicateReason[])),
  /** The subject matched a merged contact; the hit is the contact it was merged into. */
  viaMergedContactId: DocIdSchema.optional(),
  matters: z.array(ConflictHitMatterSchema),
});
export type ConflictHit = z.infer<typeof ConflictHitSchema>;

export const ConflictStatusSchema = z.enum(['pending', 'clear', 'potential', 'conflict']);
export type ConflictStatus = z.infer<typeof ConflictStatusSchema>;

/** Statuses that let a lead open. `conflict` blocks; `pending` means not determined yet. */
export const CONFLICT_OPENABLE: readonly ConflictStatus[] = ['clear', 'potential'];

export function conflictAllowsOpening(status: ConflictStatus | undefined): boolean {
  return !!status && CONFLICT_OPENABLE.includes(status);
}

/** Whether any hit has an adverse role: the UI highlights it, and "clear" then needs care. */
export function hasAdverseHit(hits: readonly ConflictHit[]): boolean {
  return hits.some((hit) => hit.matters.some((matter) => !!matter.adverse));
}

/** `orgs/{orgId}/conflictChecks/{checkId}`: one run and its hits, written by `conflicts-run` only. */
export const ConflictCheck = withMeta(
  {
    subjects: z.array(ConflictSubjectSchema),
    hits: z.array(ConflictHitSchema),
    excludeMatterId: DocIdSchema.optional(),
    ranAt: InstantSchema,
    ranBy: DocIdSchema,
    /** Whether adverse roles were evaluated (the `conflicts.enforced` flag at run time). */
    adverseRolesChecked: z.boolean(),
  },
  { path: 'orgs/{orgId}/conflictChecks', migratable: false, updatable: [] },
);
export type ConflictCheck = z.infer<typeof ConflictCheck.schema>;

// ---------- callable inputs ----------

const RequestId = z.uuid();

/** `conflicts-run` (anyone who can create matters, paralegal and above). */
export const RunConflictCheckInput = z.object({
  requestId: RequestId,
  subjects: z.array(ConflictSubjectSchema).min(1).max(20),
  /** The matter being checked: its own parties are not hits. */
  excludeMatterId: DocIdSchema.optional(),
});
export type RunConflictCheckInput = z.input<typeof RunConflictCheckInput>;

export interface RunConflictCheckResult {
  checkId: string;
  hits: ConflictHit[];
}

/** `conflicts-determine` (lawyer and above). `potential` and `conflict` need a reason. */
export const DetermineConflictInput = z
  .object({
    requestId: RequestId,
    checkId: DocIdSchema,
    matterId: DocIdSchema,
    status: ConflictStatusSchema.exclude(['pending']),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((input) => input.status === 'clear' || !!input.reason, {
    message: 'Give a reason for a potential conflict or a conflict',
    path: ['reason'],
  });
export type DetermineConflictInput = z.input<typeof DetermineConflictInput>;

export interface DetermineConflictResult {
  matterId: string;
  status: Exclude<ConflictStatus, 'pending'>;
}
