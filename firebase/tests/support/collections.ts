import { serverTimestamp, Timestamp } from 'firebase/firestore';

import { PERMISSIONS, ROLES, type Action, type Role } from '@materia/domain';
import { ENTITY_FACTORIES } from '@materia/test-utils';

import { MATTER, ORG, uidFor } from './harness';

/**
 * One entry per Firestore collection (FND-14). The rules suite generates, for each: read and
 * update for all five roles, a cross-org deny, an unauthenticated deny, a forbidden field change,
 * missing and wrong `updatedBy`, and denied create and hard delete. Add a collection here when you
 * add a `match` block; the suite fails if the two lists differ.
 */
export interface CollectionSpec {
  /** Collection id as written in firestore.rules. */
  collection: string;
  /** Path of the seeded test document. */
  docPath: string;
  /** Factory key in ENTITY_FACTORIES for the seed data (omit for plain data). */
  entity?: keyof typeof ENTITY_FACTORIES;
  /** Seed overrides (merged over the factory output). */
  seed?: Record<string, unknown>;
  /** Who can read: everyone in the org, an action's roles, only the document's owner, or nobody. */
  read: 'members' | 'signed-in' | 'owner' | 'none' | Action;
  /** Who can update: an action's roles, an explicit role list, only the owner, or nobody. */
  update: 'none' | 'owner' | Action | readonly Role[];
  /** For 'owner' specs: the owning uid (defaults to the lawyer). */
  ownerUid?: string;
  /** A whitelisted field change that `update` roles may make (defaults to the first whitelist key). */
  change?: Record<string, unknown>;
  /** For 'owner' specs: the owner also creates and hard deletes (saved views); others still can't. */
  ownerCreatesAndDeletes?: boolean;
}

const OWNER = uidFor('lawyer');

const matterRecord = (collection: string, entity: keyof typeof ENTITY_FACTORIES, update: Action = 'matter.edit') =>
  ({ collection, docPath: `${MATTER}/${collection}/doc-1`, entity, read: 'members', update }) satisfies CollectionSpec;

export const COLLECTIONS: CollectionSpec[] = [
  // Global reference data.
  {
    collection: 'ruleSets',
    docPath: 'ruleSets/vic-probate',
    seed: { name: 'Victorian probate' },
    read: 'signed-in',
    update: 'none',
  },
  {
    collection: 'versions',
    docPath: 'ruleSets/vic-probate/versions/1',
    entity: 'RuleSetVersion',
    read: 'signed-in',
    update: 'none',
  },
  { collection: 'calendars', docPath: 'calendars/vic-2026', entity: 'Calendar', read: 'signed-in', update: 'none' },
  {
    collection: 'systemTemplates',
    docPath: 'systemTemplates/probate',
    seed: { name: 'Probate' },
    read: 'signed-in',
    update: 'none',
  },

  { collection: 'users', docPath: `users/${OWNER}`, entity: 'User', read: 'owner', update: 'owner' },
  // MFA recovery code hashes and sign-in stamps: server-only, even for their owner (FND-16).
  {
    collection: 'private',
    docPath: `users/${OWNER}/private/recovery`,
    seed: { codes: [{ salt: 'aa', hash: 'bb', usedAt: null }], failedAttempts: 0 },
    read: 'none',
    update: 'none',
  },

  // Saved Matters list views (CORE-03): the user's own, created and deleted by the client.
  {
    collection: 'views',
    docPath: `users/${OWNER}/views/view-1`,
    entity: 'SavedView',
    seed: { orgId: ORG },
    read: 'owner',
    update: 'owner',
    change: { name: 'Renamed view' },
    ownerCreatesAndDeletes: true,
  },

  // New matter intake drafts (CORE-05): the user's own, created and deleted by the client. A save
  // stamps a fresh `expireAt` (about 30 days on), so the whitelisted change carries one.
  {
    collection: 'drafts',
    docPath: `users/${OWNER}/drafts/intake-draft-1`,
    entity: 'IntakeDraft',
    seed: { orgId: ORG },
    read: 'owner',
    update: 'owner',
    change: { step: 'fees', expireAt: Timestamp.fromMillis(Date.now() + 30 * 86_400_000) },
    ownerCreatesAndDeletes: true,
  },

  // Recently opened matters (CORE-14): the user's own, written whole each time a matter opens and
  // deleted by the client. A write stamps a fresh `expireAt` (about 90 days on).
  {
    collection: 'recent',
    docPath: `users/${OWNER}/recent/${ORG}_matter-1`,
    entity: 'RecentMatter',
    seed: { orgId: ORG, matterId: 'matter-1', createdBy: OWNER },
    read: 'owner',
    update: 'owner',
    change: { expireAt: Timestamp.fromMillis(Date.now() + 90 * 86_400_000) },
    ownerCreatesAndDeletes: true,
  },

  // Push devices (FND-20): the user's own, registered, refreshed and removed by the client.
  {
    collection: 'devices',
    docPath: `users/${OWNER}/devices/device-1`,
    entity: 'Device',
    seed: { createdBy: OWNER },
    read: 'owner',
    update: 'owner',
    change: { lastSeenAt: serverTimestamp() },
    ownerCreatesAndDeletes: true,
  },

  // Organisation.
  { collection: 'orgs', docPath: `orgs/${ORG}`, entity: 'Org', read: 'members', update: 'org.settings' },
  {
    collection: 'members',
    docPath: `orgs/${ORG}/members/member-target`,
    entity: 'Member',
    read: 'members',
    update: 'members.manage',
  },
  {
    collection: 'invites',
    docPath: `orgs/${ORG}/invites/invite-1`,
    entity: 'Invite',
    read: 'members.manage',
    update: 'members.manage',
  },
  {
    collection: 'contacts',
    docPath: `orgs/${ORG}/contacts/contact-1`,
    entity: 'Contact',
    read: 'members',
    update: 'contact.edit',
  },
  {
    collection: 'matters',
    docPath: MATTER,
    entity: 'Matter',
    seed: { privileged: false },
    read: 'members',
    update: 'matter.edit',
  },
  {
    collection: 'clerkThreads',
    docPath: `orgs/${ORG}/clerkThreads/thread-1`,
    entity: 'ClerkThread',
    seed: { ownerUid: OWNER, shared: false },
    read: 'owner',
    update: 'owner',
  },
  {
    collection: 'messages',
    docPath: `orgs/${ORG}/clerkThreads/thread-1/messages/message-1`,
    entity: 'ClerkMessage',
    read: 'owner',
    update: 'owner',
    change: { stopRequested: true },
  },
  {
    collection: 'invoices',
    docPath: `orgs/${ORG}/invoices/invoice-1`,
    entity: 'Invoice',
    seed: { status: 'draft' },
    read: 'billing.view',
    update: 'billing.issue',
  },
  {
    collection: 'creditNotes',
    docPath: `orgs/${ORG}/creditNotes/credit-1`,
    entity: 'CreditNote',
    read: 'billing.view',
    update: 'none',
  },
  // Matter templates (CORE-07): read by members, written through the templates-* callables only.
  {
    collection: 'templates',
    docPath: `orgs/${ORG}/templates/template-1`,
    entity: 'MatterTemplate',
    read: 'members',
    update: 'none',
    change: { name: 'Renamed by a client' },
  },
  {
    collection: 'versions (templates)',
    docPath: `orgs/${ORG}/templates/template-1/versions/1`,
    entity: 'MatterTemplateVersion',
    read: 'members',
    update: 'none',
    change: { name: 'Renamed by a client' },
  },
  // Checklist templates (CORE-08d): read by members, written client-direct by task.edit roles.
  {
    collection: 'checklistTemplates',
    docPath: `orgs/${ORG}/checklistTemplates/checklist-1`,
    entity: 'ChecklistTemplate',
    read: 'members',
    update: 'task.edit',
  },
  // Task group templates (CORE-08f): read by members, written client-direct by task.edit roles.
  {
    collection: 'taskGroupTemplates',
    docPath: `orgs/${ORG}/taskGroupTemplates/group-1`,
    entity: 'TaskGroupTemplate',
    read: 'members',
    update: 'task.edit',
  },
  {
    collection: 'docTemplates',
    docPath: `orgs/${ORG}/docTemplates/doctemplate-1`,
    entity: 'DocTemplate',
    read: 'members',
    update: 'org.settings',
  },
  {
    collection: 'safeCustody',
    docPath: `orgs/${ORG}/safeCustody/packet-1`,
    entity: 'SafeCustody',
    read: 'members',
    // Callable-only (CORE-17): movements need an authority, a role and a recent sign-in.
    update: 'none',
  },
  {
    collection: 'notifications',
    docPath: `orgs/${ORG}/notifications/notification-1`,
    entity: 'Notification',
    seed: { recipientUid: OWNER },
    read: 'owner',
    update: 'owner',
    // Marking it read stamps the server's time (FND-20).
    change: { readAt: serverTimestamp() },
  },
  {
    // Daily digest records (FND-20): server-only.
    collection: 'digests',
    docPath: `orgs/${ORG}/digests/digest-${OWNER}-2026-10-06`,
    seed: { uid: OWNER, date: '2026-10-06', status: 'sent' },
    read: 'none',
    update: 'none',
  },
  {
    // Background job progress (FND-24): only the member who started the job reads it.
    collection: 'jobs',
    docPath: `orgs/${ORG}/jobs/job-1`,
    entity: 'Job',
    seed: { createdBy: OWNER },
    read: 'owner',
    update: 'none',
  },
  {
    collection: 'audit',
    docPath: `orgs/${ORG}/audit/entry-1`,
    entity: 'AuditEntry',
    // Read through the audit-query callable only (FND-18).
    read: 'none',
    update: 'none',
  },
  {
    collection: 'metrics',
    docPath: `orgs/${ORG}/metrics/2026-03`,
    entity: 'Metrics',
    read: 'billing.view',
    update: 'none',
  },
  {
    collection: 'migrations',
    docPath: `orgs/${ORG}/migrations/run-1`,
    entity: 'MigrationRun',
    read: 'org.settings',
    update: 'none',
  },
  {
    collection: 'integrations',
    docPath: `orgs/${ORG}/integrations/${OWNER}_microsoft`,
    entity: 'Integration',
    read: 'none',
    update: 'none',
  },
  {
    // The org's own Anthropic key (AI-02a): no client reads it, owners and admins included.
    collection: 'integrations (anthropic key)',
    docPath: `orgs/${ORG}/integrations/anthropic`,
    entity: 'Integration',
    read: 'none',
    update: 'none',
  },
  {
    collection: 'counters',
    docPath: `orgs/${ORG}/counters/matter-2026`,
    entity: 'Counter',
    seed: { next: 42 },
    read: 'none',
    update: 'none',
  },
  // Matter number reservations (CORE-03): server-only.
  {
    collection: 'matterNumbers',
    docPath: `orgs/${ORG}/matterNumbers/M-2026-0042`,
    entity: 'MatterNumber',
    read: 'none',
    update: 'none',
  },
  // Conflict check runs (CORE-02): server-written, read by conflict.run roles.
  {
    collection: 'conflictChecks',
    docPath: `orgs/${ORG}/conflictChecks/check-1`,
    entity: 'ConflictCheck',
    read: 'conflict.run',
    update: 'none',
  },

  // Personal tasks live under the member.
  {
    collection: 'tasks (personal)',
    docPath: `orgs/${ORG}/members/${OWNER}/tasks/task-1`,
    entity: 'PersonalTask',
    seed: { orgId: ORG, assigneeUid: OWNER },
    read: 'owner',
    update: 'owner',
  },

  // Matter records.
  {
    collection: 'activity',
    docPath: `${MATTER}/activity/activity-1`,
    entity: 'Activity',
    read: 'members',
    update: 'none',
  },
  { ...matterRecord('tasks', 'Task', 'task.edit'), seed: { orgId: ORG, matterId: 'matter-1' } },
  // Computed deadlines (CORE-10): clients only reassign or acknowledge them; manual ones are
  // tested field by field in the rules suite.
  {
    ...matterRecord('deadlines', 'Deadline', 'task.edit'),
    seed: { orgId: ORG, matterId: 'matter-1' },
    change: { assigneeUid: uidFor('paralegal') },
  },
  // Proposed deadline changes (CORE-10): server-written, decided through deadlines-resolveChange.
  {
    collection: 'deadlineChanges',
    docPath: `${MATTER}/deadlineChanges/change-1`,
    entity: 'DeadlineChange',
    seed: { orgId: ORG, matterId: 'matter-1' },
    read: 'members',
    update: 'none',
  },
  {
    collection: 'timeEntries',
    docPath: `${MATTER}/timeEntries/entry-1`,
    entity: 'TimeEntry',
    seed: { orgId: ORG, matterId: 'matter-1', uid: uidFor('paralegal') },
    read: 'members',
    // time.approve roles, plus the paralegal because the entry is theirs.
    update: [...PERMISSIONS['time.approve'], 'paralegal'],
    change: { narrative: 'Reviewed the inventory of assets' },
  },
  { ...matterRecord('documents', 'MatterDocument', 'document.upload'), seed: { privileged: false } },
  // Content-hash index for duplicate detection (CORE-12): server-only.
  {
    collection: 'documentHashes',
    docPath: `${MATTER}/documentHashes/${'a'.repeat(64)}`,
    entity: 'DocumentHash',
    read: 'none',
    update: 'none',
  },
  {
    collection: 'chunks',
    docPath: `${MATTER}/documents/doc-1/chunks/chunk-1`,
    entity: 'Chunk',
    read: 'none',
    update: 'none',
  },
  // Notes (CORE-13): clients only pin, soft delete and restore; text goes through notes-update.
  { ...matterRecord('notes', 'Note', 'note.write'), seed: { privileged: false }, change: { pinned: true } },
  // A note's earlier versions (CORE-13): server-written, read with the note.
  {
    collection: 'revisions',
    docPath: `${MATTER}/notes/doc-1/revisions/revision-1`,
    entity: 'NoteRevision',
    read: 'members',
    update: 'none',
  },
  // Offers are always privileged (without prejudice): privileged.view roles only.
  {
    ...matterRecord('offers', 'Offer'),
    read: 'privileged.view',
    update: PERMISSIONS['matter.edit'].filter((role) => PERMISSIONS['privileged.view'].includes(role as never)),
  },
  {
    collection: 'suggestions',
    docPath: `${MATTER}/suggestions/suggestion-1`,
    entity: 'Suggestion',
    seed: { status: 'proposed' },
    read: 'members',
    update: 'clerk.use',
    change: { status: 'dismissed' },
  },
  { ...matterRecord('parties', 'Party'), seed: { orgId: ORG, matterId: 'matter-1' } },
  // Matter events (CORE-10): written through deadlines-upsertEvent and deadlines-deleteEvent.
  { ...matterRecord('events', 'MatterEvent'), update: 'none' },
  matterRecord('disbursements', 'Disbursement', 'time.record'),
  matterRecord('assets', 'Asset'),
  matterRecord('liabilities', 'Liability'),
  matterRecord('distributions', 'Distribution'),
  matterRecord('proceedings', 'Proceeding'),
  matterRecord('courtEvents', 'CourtEvent'),
  matterRecord('orders', 'CourtOrder'),
  matterRecord('chronology', 'ChronologyEntry'),
  matterRecord('issues', 'Issue'),
  matterRecord('evidence', 'Evidence'),
  matterRecord('subpoenas', 'Subpoena'),
  matterRecord('courtBooks', 'CourtBook'),
];

/** The spec for a collection id (throws if there is none). */
export function specFor(collection: string): CollectionSpec {
  const spec = COLLECTIONS.find((s) => s.collection === collection);
  if (!spec) throw new Error(`No collection spec for ${collection}`);
  return spec;
}

/** Roles expected to pass a read or update rule (excluding owner-only specs). */
export function rolesFor(rule: CollectionSpec['read'] | CollectionSpec['update']): readonly Role[] {
  if (Array.isArray(rule)) return rule;
  switch (rule) {
    case 'members':
    case 'signed-in':
      return ROLES;
    case 'none':
    case 'owner':
      return [];
    default:
      return PERMISSIONS[rule as Action];
  }
}

/** Seed data for a spec: the factory output (if any) with the overrides applied. */
export function seedData(spec: CollectionSpec): Record<string, unknown> {
  const base = spec.entity ? (ENTITY_FACTORIES[spec.entity][1] as () => Record<string, unknown>)() : {};
  return { ...base, ...spec.seed };
}

/** The whitelisted change to try, defaulting to the first update-schema key. */
export function changeFor(spec: CollectionSpec): Record<string, unknown> {
  if (spec.change) return spec.change;
  const entity = spec.entity
    ? (ENTITY_FACTORIES[spec.entity][0] as { update: { shape?: Record<string, unknown> } })
    : undefined;
  const field = Object.keys(entity?.update.shape ?? {})[0];
  // Collections with no whitelist are read-only for clients; any field will do.
  return { [field ?? 'note']: 'changed by the rules test' };
}
