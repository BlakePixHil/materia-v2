import type { Firestore } from 'firebase-admin/firestore';

import {
  REFERRER_THANK_YOU_TASK_ID,
  referrerThankYouDue,
  referrerThankYouEnabled,
  referrerThankYouTitle,
  Task,
  type DateOnly,
} from '@materia/domain';

import { contactNames, matterPath } from './shared';

type Data = Record<string, unknown>;

/** The "Thank referrer" task's path on a matter (one per matter). */
export const thankYouTaskPath = (orgId: string, matterId: string) =>
  `${matterPath(orgId, matterId)}/tasks/${REFERRER_THANK_YOU_TASK_ID}`;

/**
 * The task title when a matter opening now should get a "Thank referrer" task (CORE-18): the org
 * turned `settings.referrals.thankYouTask` on and the matter has a referrer contact. Undefined
 * otherwise. Reads the referrer's name (a deleted or merged referrer still gets the generic title).
 */
export async function thankYouTaskTitle(
  db: Firestore,
  orgId: string,
  org: Data | undefined,
  matter: { referrerContactId?: unknown },
): Promise<string | undefined> {
  const referrerId = matter.referrerContactId;
  if (!referrerThankYouEnabled(org) || typeof referrerId !== 'string' || !referrerId) return undefined;
  const names = await contactNames(db, orgId, [referrerId]);
  return referrerThankYouTitle(names.get(referrerId));
}

/**
 * The task document: a task for the responsible lawyer, due a week after the matter
 * opens. `countedOpen: true`, so the writer adds it to the matter's `openTaskCount` itself
 * (CORE-08: tasks-onWrite then leaves the count alone).
 */
export function thankYouTaskData(options: {
  orgId: string;
  matterId: string;
  title: string;
  assigneeUid: string | undefined;
  openedOn: DateOnly;
  uid: string;
  now: Date;
  requestId: string;
}): Data {
  return Task.schema.parse({
    title: options.title,
    status: 'todo',
    priority: 'medium',
    ...(options.assigneeUid ? { assigneeUid: options.assigneeUid } : {}),
    dueDate: referrerThankYouDue(options.openedOn),
    group: 'Referral',
    checklist: [],
    order: 0,
    source: 'manual',
    countedOpen: true,
    orgId: options.orgId,
    matterId: options.matterId,
    createdAt: options.now,
    createdBy: options.uid,
    updatedAt: options.now,
    updatedBy: options.uid,
    _requestId: options.requestId,
    schemaVersion: Task.version,
  }) as Data;
}
