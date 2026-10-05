import { Suggestion, ClerkThread, ClerkMessage } from './clerk';
import { Contact, Matter, MatterNumber } from './contacts-matters';
import { Job } from './jobs';
import {
  Proceeding,
  CourtEvent,
  CourtOrder,
  ChronologyEntry,
  Issue,
  Evidence,
  Subpoena,
  Offer,
  CourtBook,
} from './litigation';
import {
  Party,
  Task,
  PersonalTask,
  MatterEvent,
  Deadline,
  DeadlineChange,
  MatterDocument,
  Chunk,
  Note,
  Activity,
  TimeEntry,
  Disbursement,
  Asset,
  Liability,
  Distribution,
} from './matter-records';
import {
  Invoice,
  CreditNote,
  MatterTemplate,
  MatterTemplateVersion,
  DocTemplate,
  Metrics,
  AuditEntry,
  Notification,
  Integration,
  SafeCustody,
  MigrationRun,
  RuleSetVersion,
  Calendar,
  Counter,
} from './org-records';
import { Org, Member, Invite, User } from './tenancy';
import { SavedView } from './views';
import { ConflictCheck } from '../conflicts';
import { IntakeDraft } from '../intake';

/**
 * Named exports in the `XSchema` / `XCreateSchema` / `XUpdateSchema` form (FND-13). Each is the
 * same object as `X.schema`, `X.create` and `X.update`; `schemas.spec.ts` fails if an entity is
 * missing here.
 */

export const OrgSchema = Org.schema;
export const OrgCreateSchema = Org.create;
export const OrgUpdateSchema = Org.update;
export const MemberSchema = Member.schema;
export const MemberCreateSchema = Member.create;
export const MemberUpdateSchema = Member.update;
export const InviteSchema = Invite.schema;
export const InviteCreateSchema = Invite.create;
export const InviteUpdateSchema = Invite.update;
export const UserSchema = User.schema;
export const UserCreateSchema = User.create;
export const UserUpdateSchema = User.update;
export const ContactSchema = Contact.schema;
export const ContactCreateSchema = Contact.create;
export const ContactUpdateSchema = Contact.update;
export const MatterSchema = Matter.schema;
export const MatterCreateSchema = Matter.create;
export const MatterUpdateSchema = Matter.update;
export const PartySchema = Party.schema;
export const PartyCreateSchema = Party.create;
export const PartyUpdateSchema = Party.update;
export const TaskSchema = Task.schema;
export const TaskCreateSchema = Task.create;
export const TaskUpdateSchema = Task.update;
export const PersonalTaskSchema = PersonalTask.schema;
export const PersonalTaskCreateSchema = PersonalTask.create;
export const PersonalTaskUpdateSchema = PersonalTask.update;
export const MatterEventSchema = MatterEvent.schema;
export const MatterEventCreateSchema = MatterEvent.create;
export const MatterEventUpdateSchema = MatterEvent.update;
export const DeadlineSchema = Deadline.schema;
export const DeadlineCreateSchema = Deadline.create;
export const DeadlineUpdateSchema = Deadline.update;
export const DeadlineChangeSchema = DeadlineChange.schema;
export const DeadlineChangeCreateSchema = DeadlineChange.create;
export const DeadlineChangeUpdateSchema = DeadlineChange.update;
export const MatterDocumentSchema = MatterDocument.schema;
export const MatterDocumentCreateSchema = MatterDocument.create;
export const MatterDocumentUpdateSchema = MatterDocument.update;
export const ChunkSchema = Chunk.schema;
export const ChunkCreateSchema = Chunk.create;
export const ChunkUpdateSchema = Chunk.update;
export const NoteSchema = Note.schema;
export const NoteCreateSchema = Note.create;
export const NoteUpdateSchema = Note.update;
export const ActivitySchema = Activity.schema;
export const ActivityCreateSchema = Activity.create;
export const ActivityUpdateSchema = Activity.update;
export const TimeEntrySchema = TimeEntry.schema;
export const TimeEntryCreateSchema = TimeEntry.create;
export const TimeEntryUpdateSchema = TimeEntry.update;
export const DisbursementSchema = Disbursement.schema;
export const DisbursementCreateSchema = Disbursement.create;
export const DisbursementUpdateSchema = Disbursement.update;
export const AssetSchema = Asset.schema;
export const AssetCreateSchema = Asset.create;
export const AssetUpdateSchema = Asset.update;
export const LiabilitySchema = Liability.schema;
export const LiabilityCreateSchema = Liability.create;
export const LiabilityUpdateSchema = Liability.update;
export const DistributionSchema = Distribution.schema;
export const DistributionCreateSchema = Distribution.create;
export const DistributionUpdateSchema = Distribution.update;
export const ProceedingSchema = Proceeding.schema;
export const ProceedingCreateSchema = Proceeding.create;
export const ProceedingUpdateSchema = Proceeding.update;
export const CourtEventSchema = CourtEvent.schema;
export const CourtEventCreateSchema = CourtEvent.create;
export const CourtEventUpdateSchema = CourtEvent.update;
export const CourtOrderSchema = CourtOrder.schema;
export const CourtOrderCreateSchema = CourtOrder.create;
export const CourtOrderUpdateSchema = CourtOrder.update;
export const ChronologyEntrySchema = ChronologyEntry.schema;
export const ChronologyEntryCreateSchema = ChronologyEntry.create;
export const ChronologyEntryUpdateSchema = ChronologyEntry.update;
export const IssueSchema = Issue.schema;
export const IssueCreateSchema = Issue.create;
export const IssueUpdateSchema = Issue.update;
export const EvidenceSchema = Evidence.schema;
export const EvidenceCreateSchema = Evidence.create;
export const EvidenceUpdateSchema = Evidence.update;
export const SubpoenaSchema = Subpoena.schema;
export const SubpoenaCreateSchema = Subpoena.create;
export const SubpoenaUpdateSchema = Subpoena.update;
export const OfferSchema = Offer.schema;
export const OfferCreateSchema = Offer.create;
export const OfferUpdateSchema = Offer.update;
export const CourtBookSchema = CourtBook.schema;
export const CourtBookCreateSchema = CourtBook.create;
export const CourtBookUpdateSchema = CourtBook.update;
export const SuggestionSchema = Suggestion.schema;
export const SuggestionCreateSchema = Suggestion.create;
export const SuggestionUpdateSchema = Suggestion.update;
export const ClerkThreadSchema = ClerkThread.schema;
export const ClerkThreadCreateSchema = ClerkThread.create;
export const ClerkThreadUpdateSchema = ClerkThread.update;
export const ClerkMessageSchema = ClerkMessage.schema;
export const ClerkMessageCreateSchema = ClerkMessage.create;
export const ClerkMessageUpdateSchema = ClerkMessage.update;
export const InvoiceSchema = Invoice.schema;
export const InvoiceCreateSchema = Invoice.create;
export const InvoiceUpdateSchema = Invoice.update;
export const CreditNoteSchema = CreditNote.schema;
export const CreditNoteCreateSchema = CreditNote.create;
export const CreditNoteUpdateSchema = CreditNote.update;
export const MatterTemplateSchema = MatterTemplate.schema;
export const MatterTemplateCreateSchema = MatterTemplate.create;
export const MatterTemplateUpdateSchema = MatterTemplate.update;
export const MatterTemplateVersionSchema = MatterTemplateVersion.schema;
export const MatterTemplateVersionCreateSchema = MatterTemplateVersion.create;
export const MatterTemplateVersionUpdateSchema = MatterTemplateVersion.update;
export const DocTemplateSchema = DocTemplate.schema;
export const DocTemplateCreateSchema = DocTemplate.create;
export const DocTemplateUpdateSchema = DocTemplate.update;
export const MetricsSchema = Metrics.schema;
export const MetricsCreateSchema = Metrics.create;
export const MetricsUpdateSchema = Metrics.update;
export const AuditEntrySchema = AuditEntry.schema;
export const AuditEntryCreateSchema = AuditEntry.create;
export const AuditEntryUpdateSchema = AuditEntry.update;
export const NotificationSchema = Notification.schema;
export const NotificationCreateSchema = Notification.create;
export const NotificationUpdateSchema = Notification.update;
export const IntegrationSchema = Integration.schema;
export const IntegrationCreateSchema = Integration.create;
export const IntegrationUpdateSchema = Integration.update;
export const SafeCustodySchema = SafeCustody.schema;
export const SafeCustodyCreateSchema = SafeCustody.create;
export const SafeCustodyUpdateSchema = SafeCustody.update;
export const MigrationRunSchema = MigrationRun.schema;
export const MigrationRunCreateSchema = MigrationRun.create;
export const MigrationRunUpdateSchema = MigrationRun.update;
export const RuleSetVersionSchema = RuleSetVersion.schema;
export const RuleSetVersionCreateSchema = RuleSetVersion.create;
export const RuleSetVersionUpdateSchema = RuleSetVersion.update;
export const CalendarSchema = Calendar.schema;
export const CalendarCreateSchema = Calendar.create;
export const CalendarUpdateSchema = Calendar.update;
export const JobSchema = Job.schema;
export const JobCreateSchema = Job.create;
export const JobUpdateSchema = Job.update;
export const SavedViewSchema = SavedView.schema;
export const SavedViewCreateSchema = SavedView.create;
export const SavedViewUpdateSchema = SavedView.update;
export const CounterSchema = Counter.schema;
export const CounterCreateSchema = Counter.create;
export const CounterUpdateSchema = Counter.update;
export const MatterNumberSchema = MatterNumber.schema;
export const MatterNumberCreateSchema = MatterNumber.create;
export const MatterNumberUpdateSchema = MatterNumber.update;
export const ConflictCheckSchema = ConflictCheck.schema;
export const ConflictCheckCreateSchema = ConflictCheck.create;
export const ConflictCheckUpdateSchema = ConflictCheck.update;
export const IntakeDraftSchema = IntakeDraft.schema;
export const IntakeDraftCreateSchema = IntakeDraft.create;
export const IntakeDraftUpdateSchema = IntakeDraft.update;
