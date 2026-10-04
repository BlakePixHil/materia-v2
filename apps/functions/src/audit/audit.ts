import type { Firestore } from 'firebase-admin/firestore';

import { DomainError } from '@materia/domain';

import type { Clock } from '../ports';
import { entityFromPath, expiryFor, redactFields, type DocData } from './entry';
import { retentionYears } from './retention';

/** A semantic event: `invoice.issued`, `member.role_changed`, `deadline.override`… */
export interface AuditEvent {
  action: string;
  /** The document the event is about (`orgs/{orgId}/invoices/{id}`). */
  entity: { path: string };
  /** One line, from ids and enums, never client text ("Invoice INV-0042 issued"). */
  summary: string;
  /** Extra detail, redacted like a diff. */
  data?: DocData;
}

/** The parts of a callable's context `audit()` needs. */
export interface AuditContext {
  uid: string;
  orgId: string;
  requestId: string;
  db: Firestore;
  clock: Clock;
}

const SEMANTIC_ACTION = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

/**
 * Records a semantic event from inside a callable (FND-18), alongside the trigger's entry for the
 * underlying write. Returns the audit entry id.
 */
export async function audit(ctx: AuditContext, event: AuditEvent): Promise<string> {
  if (!SEMANTIC_ACTION.test(event.action))
    throw new Error(`Audit action "${event.action}" must look like "invoice.issued"`);
  if (!event.entity.path.startsWith(`orgs/${ctx.orgId}/`)) {
    throw new DomainError('INVALID_ARGUMENT', 'The audited entity is not in the caller’s organisation');
  }
  const at = ctx.clock.now();
  const years = await retentionYears(ctx.db, ctx.orgId, at.getTime());
  const ref = ctx.db.collection(`orgs/${ctx.orgId}/audit`).doc();
  const entry: DocData = {
    at,
    actor: { uid: ctx.uid },
    action: event.action,
    entity: entityFromPath(event.entity.path),
    summary: event.summary,
    requestId: ctx.requestId,
    source: 'callable',
    expireAt: expiryFor(at, years),
    createdAt: at,
    createdBy: ctx.uid,
    updatedAt: at,
    updatedBy: ctx.uid,
    schemaVersion: 1,
  };
  if (event.data) entry['data'] = redactFields(event.data, Object.keys(event.data));
  await ref.create(entry);
  return ref.id;
}
