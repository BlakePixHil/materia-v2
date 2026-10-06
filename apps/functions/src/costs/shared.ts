import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';

import {
  CostsDisclosureSchema,
  DISCLOSURE_UPDATE_REASON_LABELS,
  disclosureTaskId,
  joinNames,
  Task,
  type CostsDisclosure,
  type DateOnly,
  type DisclosureFee,
  type DisclosureUpdateReason,
} from '@materia/domain';

import type { Log } from '../core/log';
import { withDates } from '../docs/store';
import { notify } from '../notifications/notify';
import type { Clock, Ports } from '../ports';

/** Shared helpers for the costs disclosure functions (BILL-06). */

type Data = Record<string, unknown>;

/**
 * A matter's `costsDisclosure` as the domain reads it (Timestamps as Dates). A matter without a
 * readable one is treated as needing a disclosure, with no history.
 */
export function disclosureOf(matter: Data | undefined): CostsDisclosure {
  const parsed = CostsDisclosureSchema.safeParse(withDates(matter?.['costsDisclosure']));
  return parsed.success ? parsed.data : { status: 'required', history: [] };
}

/** Undefined fields dropped at every level (Firestore refuses them), Dates and Timestamps kept. */
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!value || typeof value !== 'object' || value instanceof Date || value.constructor !== Object) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, withoutUndefined(v)]),
  );
}

/** A costs disclosure ready to write: checked against the schema, without undefined fields. */
export function cleanDisclosure(disclosure: CostsDisclosure): Data {
  return withoutUndefined(CostsDisclosureSchema.parse(withoutUndefined(disclosure))) as Data;
}

/** The matter's fee as the disclosure rules read it. */
export function feeOf(matter: Data | undefined): DisclosureFee | undefined {
  const fee = matter?.['fee'];
  return fee && typeof fee === 'object' && typeof (fee as Data)['arrangement'] === 'string'
    ? (fee as DisclosureFee)
    : undefined;
}

export interface DisclosureDueDeps {
  db: Firestore;
  orgId: string;
  clock: Clock;
  log: Log;
  ports: Pick<Ports, 'tasks'>;
}

export interface DisclosureDue {
  taskId: string;
  /** Sends the notification's email or push once the transaction has committed. */
  dispatch: () => Promise<void>;
}

/**
 * Inside `tx`, before the caller's writes (it reads the task): a "send the costs disclosure" task for the responsible lawyer, due today (one per
 * time the disclosure falls due, `disclosureTaskId`, so a retry or a second run never adds another
 * and a done one is never reopened), and a `costs_disclosure` notification to them. The task is
 * a `rule` task (no "assigned to you" notification of its own; tasks-onWrite counts it).
 */
export async function disclosureDue(
  deps: DisclosureDueDeps,
  input: {
    tx: Transaction;
    matterRef: DocumentReference;
    matter: Data;
    kind: 'due' | 'update';
    since: DateOnly;
    today: DateOnly;
    reasons?: readonly DisclosureUpdateReason[];
  },
): Promise<DisclosureDue> {
  const { tx, matterRef, matter, kind } = input;
  const now = deps.clock.now();
  const matterId = matterRef.id;
  const number = typeof matter['number'] === 'string' && matter['number'] ? matter['number'] : 'A matter';
  const responsible = typeof matter['responsibleUid'] === 'string' ? matter['responsibleUid'] : undefined;
  const taskId = disclosureTaskId(kind, input.since);
  const taskRef = matterRef.collection('tasks').doc(taskId);
  // Already made for this time it fell due (a retry, or a second run): never reopened or resent.
  if ((await tx.get(taskRef)).exists) return { taskId, dispatch: async () => undefined };
  const title = kind === 'update' ? 'Send an updated costs disclosure' : 'Send the costs disclosure';
  const why = input.reasons?.length
    ? joinNames(input.reasons.map((reason) => DISCLOSURE_UPDATE_REASON_LABELS[reason]))
    : undefined;
  tx.create(
    taskRef,
    Task.schema.parse({
      title,
      descriptionMd:
        kind === 'update'
          ? `The estimate changed significantly${why ? `: ${why}` : ''}. Generate an updated disclosure from the matter’s Overview and record it as sent.`
          : 'The costs disclosure hasn’t been recorded as sent. Generate it from the matter’s Overview and record it as sent.',
      status: 'todo',
      priority: 'high',
      ...(responsible ? { assigneeUid: responsible } : {}),
      dueDate: input.today,
      group: 'Costs disclosure',
      checklist: [],
      order: 0,
      source: 'rule',
      // tasks-onWrite counts it into the matter's openTaskCount (CORE-08).
      countedOpen: false,
      orgId: deps.orgId,
      matterId,
      createdAt: now,
      createdBy: 'system',
      updatedAt: now,
      updatedBy: 'system',
      schemaVersion: Task.version,
    }),
  );
  const sent = await notify(
    deps,
    {
      kind: 'costs_disclosure',
      matterId,
      recipients: responsible ? [responsible] : [],
      title:
        kind === 'update' ? `Updated costs disclosure needed: ${number}` : `Costs disclosure not yet sent: ${number}`,
      body:
        kind === 'update'
          ? `The estimate on ${number} changed significantly${why ? ` (${why})` : ''}. Send the client an updated costs disclosure.`
          : `${number} needed a costs disclosure from ${input.since}, and none has been recorded as sent.`,
      link: `/matters/${matterId}/overview`,
      key: `costs-disclosure-${matterId}-${kind}-${input.since}`,
    },
    { tx },
  );
  return { taskId, dispatch: sent.dispatch };
}

/** The open server task to complete once the disclosure is sent, if it is still open. */
export async function openDisclosureTask(
  tx: Transaction,
  matterRef: DocumentReference,
  taskId: string | undefined,
): Promise<DocumentReference | undefined> {
  if (!taskId) return undefined;
  const ref = matterRef.collection('tasks').doc(taskId);
  const snap = await tx.get(ref);
  const data = snap.data();
  if (!snap.exists || !data || data['deletedAt'] || data['status'] === 'done' || data['status'] === 'cancelled') {
    return undefined;
  }
  return ref;
}
