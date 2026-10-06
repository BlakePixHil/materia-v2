import * as z from 'zod';

/** Enums from Domain model & Firestore schema. Values match the design-system tokens. */

export const JurisdictionSchema = z.enum(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT']);
export type Jurisdiction = z.infer<typeof JurisdictionSchema>;

/** MatterTag tokens. */
export const MatterTypeSchema = z.enum(['will', 'poa', 'probate', 'loa', 'admin', 'fp', 'contest', 'trust']);
export type MatterType = z.infer<typeof MatterTypeSchema>;

export const MatterStatusSchema = z.enum(['lead', 'open', 'on_hold', 'closed', 'archived']);
export type MatterStatus = z.infer<typeof MatterStatusSchema>;

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
]);
export type SuggestionKind = z.infer<typeof SuggestionKindSchema>;
export const SuggestionStatusSchema = z.enum(['proposed', 'accepted', 'edited', 'dismissed', 'expired', 'stale']);

export const InvoiceStatusSchema = z.enum(['draft', 'issued', 'part_paid', 'paid', 'void']);
export const ThemeSchema = z.enum(['system', 'light', 'dark']);
export const RoundingSchema = z.enum(['up', 'nearest']);
