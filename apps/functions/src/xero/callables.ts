import type { Firestore } from 'firebase-admin/firestore';

import {
  can,
  DomainError,
  PERMISSIONS,
  SaveXeroSettingsInput,
  SendToXeroInput,
  XERO_CALLABLES,
  XeroOptionsInput,
  type SaveXeroSettingsResult,
  type SendToXeroResult,
  type XeroOptionsResult,
  type XeroSettings,
} from '@materia/domain';

import { queueXeroPush, xeroDocPath, type XeroPushTask } from './push';
import { syncIn, xeroClient, xeroSettingsOf, xeroStatusPath } from './shared';
import { audit } from '../audit/audit';
import { creditNotesPath, invoicesPath } from '../billing/invoice-shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { requireFlag } from '../core/flags';
import { OAUTH_SECRETS } from '../integrations/providers';
import { XeroApiError } from '../ports';

type Data = Record<string, unknown>;

/** The most documents one "Send unsent to Xero" queues; pressing it again sends the rest. */
export const XERO_SEND_ALL_LIMIT = 200;

/** A Xero error, as the callable answers it. */
function xeroCallError(error: unknown): unknown {
  if (!(error instanceof XeroApiError)) return error;
  if (error.failure === 'forbidden') {
    return new DomainError('INTEGRATION_RECONNECT_REQUIRED', 'Xero refused access', { provider: 'xero' });
  }
  if (error.failure === 'rejected') {
    return new DomainError('FAILED_PRECONDITION', error.messages.join(' ') || 'Xero refused the request');
  }
  return new DomainError('UNAVAILABLE', 'Xero didn’t respond');
}

const orgData = async (db: Firestore, orgId: string): Promise<Data> => {
  const data = (await db.doc(`orgs/${orgId}`).get()).data();
  if (!data) throw new DomainError('NOT_FOUND', 'Organisation not found');
  return data;
};

/**
 * Invoices and credit notes issued since `sendFrom` that aren't in the chosen Xero organisation
 * yet (failed, or never sent), oldest first. Void invoices never sent stay out.
 */
export async function unsentToXero(
  db: Firestore,
  orgId: string,
  settings: Pick<XeroSettings, 'tenantId' | 'sendFrom'>,
  limit: number,
): Promise<XeroPushTask[]> {
  const unsent = (data: Data) => syncIn(data, settings.tenantId)?.status !== 'synced';
  const [invoices, notes] = await Promise.all([
    db
      .collection(invoicesPath(orgId))
      .where('issueDate', '>=', settings.sendFrom)
      .orderBy('issueDate')
      .limit(2000)
      .get(),
    db
      .collection(creditNotesPath(orgId))
      .where('issueDate', '>=', settings.sendFrom)
      .orderBy('issueDate')
      .limit(2000)
      .get(),
  ]);
  const tasks: XeroPushTask[] = [
    ...invoices.docs
      .filter((doc) => doc.get('status') !== 'draft' && doc.get('status') !== 'void' && unsent(doc.data()))
      .map((doc) => ({ orgId, kind: 'invoice' as const, id: doc.id })),
    ...notes.docs
      .filter((doc) => unsent(doc.data()))
      .map((doc) => ({ orgId, kind: 'creditNote' as const, id: doc.id })),
  ];
  return tasks.slice(0, limit);
}

/**
 * `xero-options` (BILL-09; owners and admins; behind `integrations.xero`): the Xero organisations
 * the connection reaches, and the accounts of one (the one asked for, else the saved one, else the
 * only one), for Settings → Integrations.
 */
export const optionsDefinition = {
  name: XERO_CALLABLES.options,
  input: XeroOptionsInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  secrets: OAUTH_SECRETS,
  handler: async (ctx): Promise<XeroOptionsResult> => {
    const { input, orgId, db, clock } = ctx;
    await requireFlag({ orgId, db, clock }, 'integrations.xero');
    const saved = xeroSettingsOf(await orgData(db, orgId))?.tenantId;
    const { client } = xeroClient(ctx, orgId);
    try {
      const tenants = await client.tenants();
      const only = tenants.length === 1 ? tenants[0]?.tenantId : undefined;
      const tenantId =
        [input.tenantId, saved, only].find((id) => !!id && tenants.some((tenant) => tenant.tenantId === id)) ?? null;
      const accounts = tenantId ? await client.accounts(tenantId) : [];
      return { tenants, tenantId, accounts };
    } catch (error) {
      throw xeroCallError(error);
    }
  },
} satisfies CallableDefinition<typeof XeroOptionsInput, XeroOptionsResult>;

/**
 * `xero-saveSettings` (BILL-09, ADR-053; owners and admins; behind `integrations.xero`;
 * idempotent): which Xero organisation, the accounts for fees and disbursements, whether to send
 * as things happen, and from which issue date. The organisation must be one the connection
 * reaches and both accounts active in it. Audited.
 */
export const saveSettingsDefinition = {
  name: XERO_CALLABLES.saveSettings,
  input: SaveXeroSettingsInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  secrets: OAUTH_SECRETS,
  handler: async (ctx): Promise<SaveXeroSettingsResult> => {
    const { input, orgId, uid, db, clock, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock }, 'integrations.xero');
    const current = xeroSettingsOf(await orgData(db, orgId));
    const next = input.settings;
    const { client } = xeroClient(ctx, orgId);
    let tenantName: string;
    try {
      const tenant = (await client.tenants()).find((candidate) => candidate.tenantId === next.tenantId);
      if (!tenant) {
        throw new DomainError(
          'FAILED_PRECONDITION',
          'That Xero organisation isn’t connected. Reconnect Xero and choose it.',
          {
            field: 'tenantId',
          },
        );
      }
      tenantName = tenant.tenantName;
      const codes = new Set((await client.accounts(next.tenantId)).map((account) => account.code));
      for (const field of ['feesAccountCode', 'disbursementsAccountCode'] as const) {
        if (!codes.has(next[field])) {
          throw new DomainError('FAILED_PRECONDITION', `Xero has no active account ${next[field]}`, { field });
        }
      }
    } catch (error) {
      throw xeroCallError(error);
    }

    const xero: XeroSettings = { ...next, tenantName };
    const changed = (Object.keys(xero) as (keyof XeroSettings)[]).filter((key) => current?.[key] !== xero[key]);
    if (current && !changed.length) {
      return { saved: false, unsent: (await unsentToXero(db, orgId, xero, XERO_SEND_ALL_LIMIT)).length };
    }
    await db.doc(`orgs/${orgId}`).update({ xero, updatedAt: clock.now(), updatedBy: uid, _requestId: requestId });
    await audit(ctx, {
      action: 'xero.settings_updated',
      entity: { path: xeroStatusPath(orgId) },
      summary: `Xero settings changed: ${changed.join(', ')}`,
      data: { changed, tenantName, autoPush: xero.autoPush, sendFrom: xero.sendFrom },
    });
    log.info('xero settings saved', { changed });
    return { saved: true, unsent: (await unsentToXero(db, orgId, xero, XERO_SEND_ALL_LIMIT)).length };
  },
} satisfies CallableDefinition<typeof SaveXeroSettingsInput, SaveXeroSettingsResult>;

/**
 * `xero-send` (BILL-09; behind `integrations.xero`; idempotent): "Send to Xero" or "Try again" on
 * one invoice or credit note (`billing.issue`), or "Send unsent to Xero" for everything issued
 * since the "send from" date (owners and admins). Queues them; the `xero-push` task sends them.
 */
export const sendDefinition = {
  name: XERO_CALLABLES.send,
  input: SendToXeroInput,
  roles: PERMISSIONS['billing.issue'],
  idempotent: true,
  handler: async (ctx): Promise<SendToXeroResult> => {
    const { input, orgId, role, db, clock, requestId } = ctx;
    await requireFlag({ orgId, db, clock }, 'integrations.xero');
    const settings = xeroSettingsOf(await orgData(db, orgId));
    if (!settings) {
      throw new DomainError('FAILED_PRECONDITION', 'Choose the Xero organisation in Settings → Integrations first');
    }
    const single = input.invoiceId
      ? { kind: 'invoice' as const, id: input.invoiceId }
      : input.creditNoteId
        ? { kind: 'creditNote' as const, id: input.creditNoteId }
        : null;

    if (single) {
      const task: XeroPushTask = { orgId, ...single };
      const doc = await db.doc(xeroDocPath(task)).get();
      if (!doc.exists) throw new DomainError('NOT_FOUND', 'Not found');
      if (doc.get('status') === 'draft') throw new DomainError('FAILED_PRECONDITION', 'Issue the invoice first');
      await queueXeroPush(ctx, task, `xero-${task.kind}-${task.id}-send-${requestId}`, { markQueued: true });
      await audit(ctx, {
        action: 'xero.sent',
        entity: { path: doc.ref.path },
        summary: `${single.kind === 'invoice' ? 'Invoice' : 'Credit note'} ${String(doc.get('number'))} sent to Xero`,
        data: { kind: single.kind },
      });
      return { queued: 1 };
    }

    if (!can(role, 'org.settings')) {
      throw new DomainError('PERMISSION_DENIED', 'Only owners and admins send everything unsent to Xero');
    }
    const tasks = await unsentToXero(db, orgId, settings, XERO_SEND_ALL_LIMIT);
    for (const task of tasks) {
      await queueXeroPush(ctx, task, `xero-${task.kind}-${task.id}-send-${requestId}`, { markQueued: true });
    }
    await audit(ctx, {
      action: 'xero.sent',
      entity: { path: xeroStatusPath(orgId) },
      summary: `${tasks.length} unsent invoices and credit notes sent to Xero`,
      data: { queued: tasks.length },
    });
    return { queued: tasks.length };
  },
} satisfies CallableDefinition<typeof SendToXeroInput, SendToXeroResult>;

export const options = defineCallable(optionsDefinition);
export const saveSettings = defineCallable(saveSettingsDefinition);
export const send = defineCallable(sendDefinition);
