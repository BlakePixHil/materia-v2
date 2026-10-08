import * as z from 'zod';

/** Enums from Domain model & Firestore schema. Values match the design-system tokens. */

export const JurisdictionSchema = z.enum(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT']);
export type Jurisdiction = z.infer<typeof JurisdictionSchema>;

/** MatterTag tokens. */
export const MatterTypeSchema = z.enum(['will', 'poa', 'probate', 'loa', 'admin', 'fp', 'contest', 'trust']);
export type MatterType = z.infer<typeof MatterTypeSchema>;

export const MatterStatusSchema = z.enum(['lead', 'open', 'on_hold', 'closed', 'archived']);
export type MatterStatus = z.infer<typeof MatterStatusSchema>;

/** Where a closed matter's original documents went (CORE-19 closing checklist). */
export const OriginalsOutcomeSchema = z.enum(['returned', 'safe_custody', 'none_held']);
export type OriginalsOutcome = z.infer<typeof OriginalsOutcomeSchema>;

/** Why a closed matter has no destruction date (CORE-19): it is kept until someone acts. */
export const RetentionHoldSchema = z.enum(['legal_hold', 'originals_in_custody', 'minor']);
export type RetentionHold = z.infer<typeof RetentionHoldSchema>;

/** PriorityIcon levels. */
export const PrioritySchema = z.enum(['none', 'urgent', 'high', 'medium', 'low']);
export type Priority = z.infer<typeof PrioritySchema>;

/** A referrer's industry (CORE-18): who sends work to the practice. */
export const ReferrerIndustrySchema = z.enum([
  'accountant',
  'financial_planner',
  'funeral_director',
  'law_firm',
  'aged_care',
  'bank',
  'other',
]);
export type ReferrerIndustry = z.infer<typeof ReferrerIndustrySchema>;

/** Where a matter came from when no referrer contact sent it (CORE-18). */
export const ReferralSourceSchema = z.enum(['unknown', 'website', 'existing_client', 'walk_in']);
export type ReferralSource = z.infer<typeof ReferralSourceSchema>;

/**
 * Who sees every member's figures in the metrics rollups (INS-01, `settings.insights.memberVisibility`):
 * lawyers and above (the default), only owners and admins, or everyone. Each member always sees their own.
 */
export const MemberMetricsVisibilitySchema = z.enum(['lawyers', 'admins', 'everyone']);
export type MemberMetricsVisibility = z.infer<typeof MemberMetricsVisibilitySchema>;

export const RoleSchema = z.enum(['owner', 'admin', 'lawyer', 'paralegal', 'readonly']);
export type Role = z.infer<typeof RoleSchema>;

export const MemberStatusSchema = z.enum(['active', 'suspended', 'removed']);
export const InviteStatusSchema = z.enum(['pending', 'accepted', 'revoked', 'expired']);

export const TaskStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const PartyRoleSchema = z.enum([
  'client',
  'testator',
  'deceased',
  'executor',
  'administrator',
  'beneficiary',
  'attorney',
  'guardian',
  'trustee',
  'plaintiff',
  'defendant',
  'witness',
  'other_side_solicitor',
  'counsel',
  'interested_person',
]);
export type PartyRole = z.infer<typeof PartyRoleSchema>;

export const EventKindSchema = z.enum([
  'date_of_death',
  'will_located',
  'notice_published',
  'probate_filed',
  'grant_issued',
  'statutory_notice_published',
  'caveat_lodged',
  'grant_served',
  'fp_claim_filed',
  'hearing',
  'order_made',
  'offer_made',
  'custom',
]);
export type EventKind = z.infer<typeof EventKindSchema>;

export const DeadlineKindSchema = z.enum(['statutory', 'court', 'contractual', 'internal', 'court_watch']);
export const DeadlineStatusSchema = z.enum(['upcoming', 'done', 'missed', 'waived', 'superseded', 'blocked']);
export type DeadlineStatus = z.infer<typeof DeadlineStatusSchema>;

export const DocumentCategorySchema = z.enum([
  'will',
  'codicil',
  'death_certificate',
  'grant',
  'affidavit',
  'correspondence',
  'court_document',
  'order',
  'financial',
  'id',
  'other',
]);
export const DocumentSourceSchema = z.enum(['upload', 'email', 'clerk_draft', 'migration', 'camera', 'generated']);

/**
 * What a docx template is for (INT-06): a letterhead (a blank letter with a `{@body}` block, which
 * Clerk drafting fills), a letter, a file note, a costs disclosure (BILL-06), a chronology export
 * (LIT-06) or a court book index (LIT-10). The kind sets the generated document's category and tags.
 */
export const DocTemplateKindSchema = z.enum([
  'letterhead',
  'letter',
  'file_note',
  'costs_disclosure',
  'chronology',
  'court_book_index',
  'other',
]);
export type DocTemplateKind = z.infer<typeof DocTemplateKindSchema>;

export const TimeEntryStatusSchema = z.enum(['draft', 'final', 'billed', 'written_off']);
export type TimeEntryStatus = z.infer<typeof TimeEntryStatusSchema>;
export const GstTreatmentSchema = z.enum(['taxable', 'gst_free', 'input_taxed']);
export type GstTreatment = z.infer<typeof GstTreatmentSchema>;

export const SuggestionKindSchema = z.enum([
  'task',
  'deadline',
  'event',
  'party',
  'time_entry',
  'note',
  'key_fact',
  'chronology',
  'order',
  'document_meta',
  'evidence',
  'letter',
]);
export type SuggestionKind = z.infer<typeof SuggestionKindSchema>;
export const SuggestionStatusSchema = z.enum(['proposed', 'accepted', 'edited', 'dismissed', 'expired', 'stale']);

export const InvoiceStatusSchema = z.enum(['draft', 'issued', 'part_paid', 'paid', 'void']);
export const ThemeSchema = z.enum(['system', 'light', 'dark']);
export const RoundingSchema = z.enum(['up', 'nearest']);
/** Where the firm keeps its trust records (BILL-11, ADR-035): named on every trust balance snapshot. */
export const TrustRecordsSystemSchema = z.enum(['leap', 'smokeball', 'actionstep', 'other']);
