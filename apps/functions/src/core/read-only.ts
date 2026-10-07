import { DomainError, ORG_DELETION_CALLABLES, ORG_EXPORT_CALLABLE, OFFBOARDING_CALLABLES } from '@materia/domain';

import type { SessionPolicy } from './sessions';

/**
 * The callables that still run while a practice waits to be deleted (SEC-05, ADR-058): reads,
 * exports and downloads (so the practice can take its data away), cancelling or confirming the
 * deletion, placing a legal hold (which stops it), and taking access away (a member, a connection,
 * a key). Everything else is refused with ORG_READ_ONLY by the callable wrapper; the web app shows
 * why.
 */
export const READ_ONLY_CALLABLES: ReadonlySet<string> = new Set([
  // Reading
  'audit-query',
  'billing-wip',
  'clerk-getApiKeyStatus',
  'contacts-activity',
  'contacts-findDuplicates',
  'docs-previewTemplate',
  'documents-citationText',
  'matters-closingChecklist',
  'orgs-memberSecurity',
  OFFBOARDING_CALLABLES.plan,
  'system-echo',
  'xero-options',
  // Exports and downloads
  'audit-exportCsv',
  'docs-downloadTemplate',
  'documents-getDownloadUrl',
  'documents-startZip',
  'exports-create',
  ORG_EXPORT_CALLABLE,
  'jobs-getExportUrl',
  'matters-destructionCertificateUrl',
  'safeCustody-receipt',
  'safeCustody-stocktakeReport',
  'time-exportCsv',
  // The deletion itself, and what stops it
  ORG_DELETION_CALLABLES.request,
  ORG_DELETION_CALLABLES.cancel,
  'matters-setLegalHold',
  // Taking access away
  'clerk-removeApiKey',
  'integrations-disconnect',
  'orgs-removeMember',
  'orgs-suspendMember',
  'security-revokeSessions',
]);

/** Refuses a callable that changes a practice waiting to be deleted (ORG_READ_ONLY). */
export function assertWritable(name: string, session: Pick<SessionPolicy, 'deletionScheduledAt'>): void {
  if (!session.deletionScheduledAt || READ_ONLY_CALLABLES.has(name)) return;
  throw new DomainError('ORG_READ_ONLY', 'The practice is scheduled for deletion, so it is read-only', {
    deletionScheduledAt: session.deletionScheduledAt.toISOString(),
  });
}
