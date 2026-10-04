import type { ContactListItem, MatterConflict } from '@materia/data-access/repository';
import {
  DateOnlySchema,
  MATTER_STATUS_LABELS,
  type ConflictHit,
  type ConflictHitMatter,
  type ConflictStatus,
  type ConflictSubject,
  type DuplicateReason,
  type PartyRole,
} from '@materia/domain';
import type { MtBadgeTone, MtOption } from '@materia/ui';

/**
 * Words and small pure helpers for the conflict check (CORE-02): match reasons, scores, statuses,
 * grouping hits by subject and turning a matter's contacts into subjects.
 */

export const PARTY_ROLE_NAMES: Readonly<Record<PartyRole, string>> = {
  client: 'Client',
  testator: 'Testator',
  deceased: 'Deceased',
  executor: 'Executor',
  administrator: 'Administrator',
  beneficiary: 'Beneficiary',
  attorney: 'Attorney',
  guardian: 'Guardian',
  trustee: 'Trustee',
  plaintiff: 'Plaintiff',
  defendant: 'Defendant',
  witness: 'Witness',
  other_side_solicitor: 'Other side’s solicitor',
  counsel: 'Counsel',
  interested_person: 'Interested person',
};

export const SUBJECT_ROLE_OPTIONS: MtOption<PartyRole>[] = (Object.keys(PARTY_ROLE_NAMES) as PartyRole[]).map(
  (role) => ({ value: role, label: PARTY_ROLE_NAMES[role] }),
);

/** A role label for any role string (the server may send roles this build doesn't know yet). */
export function roleName(role: string): string {
  return PARTY_ROLE_NAMES[role as PartyRole] ?? role.replace(/_/g, ' ');
}

const REASON_WORDS: Record<DuplicateReason, string> = {
  name: 'name',
  dateOfBirth: 'date of birth',
  email: 'email',
  phone: 'phone',
  abn: 'ABN',
};

/** `['name', 'dateOfBirth']` → "Name, date of birth". */
export function matchReasons(reasons: readonly string[]): string {
  const text = reasons.map((reason) => REASON_WORDS[reason as DuplicateReason] ?? reason).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** 0.864 → "86%". */
export function scorePercent(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}

export const CONFLICT_STATUS_LABELS: Readonly<Record<ConflictStatus, string>> = {
  pending: 'Not determined',
  clear: 'Clear',
  potential: 'Potential conflict, waived',
  conflict: 'Conflict',
};

export const CONFLICT_STATUS_TONES: Readonly<Record<ConflictStatus, MtBadgeTone>> = {
  pending: 'warning',
  clear: 'success',
  potential: 'warning',
  conflict: 'danger',
};

/** "Conflict check clear", as the design's badge words it. */
export function conflictBadgeText(status: ConflictStatus | undefined): string {
  switch (status ?? 'pending') {
    case 'clear':
      return 'Conflict check clear';
    case 'potential':
      return 'Potential conflict waived';
    case 'conflict':
      return 'Conflict';
    default:
      return 'Conflict check needed';
  }
}

/** A hit matter's status badge: its status, or "Deleted". */
export function hitMatterBadge(matter: ConflictHitMatter): { text: string; tone: MtBadgeTone } {
  if (matter.deleted) return { text: 'Deleted', tone: 'danger' };
  const tones: Record<ConflictHitMatter['status'], MtBadgeTone> = {
    lead: 'info',
    open: 'success',
    on_hold: 'warning',
    closed: 'neutral',
    archived: 'neutral',
  };
  return { text: MATTER_STATUS_LABELS[matter.status] ?? matter.status, tone: tones[matter.status] ?? 'neutral' };
}

export interface SubjectResult {
  index: number;
  subject: ConflictSubject;
  /** Hits for this subject, best first. */
  hits: ConflictHit[];
}

/** The run's hits under the subject each matched, in subject order; best score first within each. */
export function groupHits(subjects: readonly ConflictSubject[], hits: readonly ConflictHit[]): SubjectResult[] {
  return subjects.map((subject, index) => ({
    index,
    subject,
    hits: hits
      .filter((hit) => hit.subject === index)
      .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName)),
  }));
}

/** The contacts a matter's check starts from: its clients, then the deceased and the testator. */
export function matterSubjectRefs(matter: MatterConflict): { contactId: string; role: PartyRole }[] {
  const refs: { contactId: string; role: PartyRole }[] = matter.clientContactIds.map((contactId) => ({
    contactId,
    role: 'client',
  }));
  if (matter.deceased?.contactId) refs.push({ contactId: matter.deceased.contactId, role: 'deceased' });
  if (matter.testator?.contactId) refs.push({ contactId: matter.testator.contactId, role: 'testator' });
  const seen = new Set<string>();
  return refs.filter((ref) =>
    seen.has(`${ref.contactId}/${ref.role}`) ? false : seen.add(`${ref.contactId}/${ref.role}`),
  );
}

/** A contact as a subject: full legal name (given then family), date of birth, first email, ABN. */
export function subjectFromContact(contactId: string, contact: ContactListItem, role: PartyRole): ConflictSubject {
  const organisation = contact.kind === 'organisation';
  const name = organisation
    ? (contact.orgName ?? '').trim()
    : [contact.givenNames, contact.familyName]
        .map((part) => (part ?? '').trim())
        .filter(Boolean)
        .join(' ');
  return {
    kind: organisation ? 'organisation' : 'person',
    name: name || 'Unnamed contact',
    role,
    contactId,
    ...(contact.dateOfBirth ? { dob: contact.dateOfBirth } : {}),
    ...(contact.emails[0]?.address ? { email: contact.emails[0].address } : {}),
    ...(contact.abn ? { abn: contact.abn } : {}),
  };
}

/** `14/06/1968`, `14-6-1968` or `1968-06-14` → `1968-06-14`; null when it isn't a real date. */
export function parseDob(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const local = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(trimmed);
  const iso = local
    ? `${local[3]}-${(local[2] ?? '').padStart(2, '0')}-${(local[1] ?? '').padStart(2, '0')}`
    : /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
      ? trimmed
      : null;
  return iso && DateOnlySchema.safeParse(iso).success ? iso : null;
}

/** `1968-06-14` → `14/06/1968`. */
export function formatDob(date: string | undefined): string {
  if (!date) return '';
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}
