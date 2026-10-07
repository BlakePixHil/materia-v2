import { createHash } from 'node:crypto';

import { FieldValue, type DocumentReference, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';

import {
  attachmentDisposition,
  can,
  computeTimeEntry,
  defaultBillable,
  CSV_BOM,
  DomainError,
  exportLine,
  Job,
  OFFBOARDING_CALLABLES,
  OffboardingPlanInput,
  OffboardMemberInput,
  OPEN_TASK_STATUSES,
  PERMISSIONS,
  PERSONAL_TASK_EXPORT_COLUMNS,
  SENSITIVE_REAUTH_MINUTES,
  TimeEntry,
  timerEntries,
  today,
  validTimeZone,
  type OffboardingPlan,
  type OffboardMemberResult,
  type PersonalTasksChoice,
  type RateMatter,
  type RateMember,
  type Role,
} from '@materia/domain';

import { assertCanGrant } from './invites';
import { changeMember, endClaudeConnections, revokeIfActive, syncMember, type MemberCtx } from './members';
import { memberPath } from './shared';
import { audit } from '../audit/audit';
import { isDeleted } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { errorReportFields } from '../core/log';
import { storageFiles, type FileStore } from '../documents/files';
import { OAUTH_SECRETS } from '../integrations/providers';
import { removeMemberConnections } from '../integrations/vault';
import { exportFileName } from '../jobs/get-export-url';
import { matterPath } from '../matters/shared';
import { notify } from '../notifications/notify';
import { rateOrg } from '../time/shared';
import { serverElapsedMs, timerPath } from '../time/stop-timer';

/**
 * Offboarding a member (SEC-05; extends FND-17's removal): `orgs-offboardingPlan` counts what they
 * leave behind, and `orgs-offboardMember` hands their open tasks, upcoming deadlines and the
 * matters they are responsible for to the people chosen, saves their timer as draft time, exports
 * their personal tasks to the admin doing this (or deletes them), revokes their own connections
 * (INT-01) and removes them, as `orgs-removeMember` does.
 */

type Data = Record<string, unknown>;
type WorkKind = 'tasks' | 'deadlines' | 'matters';

/** Deadline statuses that still need someone: upcoming, or waiting on a fact (blocked). */
const OPEN_DEADLINE_STATUSES = ['upcoming', 'blocked'] as const;
const CLOSED_MATTER_STATUSES = new Set(['closed', 'archived']);
/** Writes per batch (Firestore allows 500). */
const BATCH = 400;
/** The most of each kind one offboarding hands on; a member with more is offboarded in steps. */
export const OFFBOARD_MAX_ITEMS = 5000;

interface Work {
  tasks: DocumentSnapshot[];
  deadlines: DocumentSnapshot[];
  matters: DocumentSnapshot[];
  privileged: Record<WorkKind, boolean>;
}

const tooMuch = (kind: WorkKind) =>
  new DomainError('FAILED_PRECONDITION', `More than ${OFFBOARD_MAX_ITEMS} ${kind} to hand on`, {
    reason: 'too_many',
    kind,
  });

/** The open work assigned to `uid`: matter tasks (not personal ones), deadlines and matters. */
async function openWork(db: Firestore, orgId: string, uid: string): Promise<Work> {
  const [taskSnap, deadlineSnap, matterSnap] = await Promise.all([
    db
      .collectionGroup('tasks')
      .where('orgId', '==', orgId)
      .where('assigneeUid', '==', uid)
      .where('status', 'in', [...OPEN_TASK_STATUSES])
      .limit(OFFBOARD_MAX_ITEMS + 1)
      .get(),
    db
      .collectionGroup('deadlines')
      .where('orgId', '==', orgId)
      .where('assigneeUid', '==', uid)
      .where('status', 'in', [...OPEN_DEADLINE_STATUSES])
      .limit(OFFBOARD_MAX_ITEMS + 1)
      .get(),
    db
      .collection(`orgs/${orgId}/matters`)
      .where('responsibleUid', '==', uid)
      .limit(OFFBOARD_MAX_ITEMS + 1)
      .get(),
  ]);
  const prefix = `orgs/${orgId}/matters/`;
  const tasks = taskSnap.docs.filter((doc) => doc.ref.path.startsWith(prefix) && !isDeleted(doc.data()));
  const deadlines = deadlineSnap.docs.filter((doc) => doc.ref.path.startsWith(prefix) && !isDeleted(doc.data()));
  const matters = matterSnap.docs.filter(
    (doc) => !isDeleted(doc.data()) && !CLOSED_MATTER_STATUSES.has(String(doc.get('status'))),
  );
  if (tasks.length > OFFBOARD_MAX_ITEMS) throw tooMuch('tasks');
  if (deadlines.length > OFFBOARD_MAX_ITEMS) throw tooMuch('deadlines');
  if (matters.length > OFFBOARD_MAX_ITEMS) throw tooMuch('matters');

  // Tasks don't carry the matter's privileged flag: look their matters up.
  const taskMatterIds = [...new Set(tasks.map((doc) => String(doc.get('matterId') ?? '')).filter(Boolean))];
  const privilegedMatters = new Set<string>();
  for (let i = 0; i < taskMatterIds.length; i += 300) {
    const refs = taskMatterIds.slice(i, i + 300).map((id) => db.doc(matterPath(orgId, id)));
    for (const matter of refs.length ? await db.getAll(...refs) : []) {
      if (matter.get('privileged') === true) privilegedMatters.add(matter.id);
    }
  }
  return {
    tasks,
    deadlines,
    matters,
    privileged: {
      tasks: tasks.some((doc) => privilegedMatters.has(String(doc.get('matterId')))),
      deadlines: deadlines.some((doc) => doc.get('privileged') === true),
      matters: matters.some((doc) => doc.get('privileged') === true),
    },
  };
}

const personalTasksOf = async (db: Firestore, orgId: string, uid: string) =>
  (await db.collection(`${memberPath(orgId, uid)}/tasks`).get()).docs;

/** Their timer, when it runs (or is paused) on this practice. */
async function timerOf(db: Firestore, orgId: string, uid: string): Promise<DocumentSnapshot | null> {
  const timer = await db.doc(timerPath(uid)).get();
  return timer.exists && timer.get('orgId') === orgId ? timer : null;
}

/** The member being offboarded: active or suspended (NOT_FOUND otherwise). */
async function leavingMember(db: Firestore, orgId: string, uid: string): Promise<{ role: Role; name: string }> {
  const member = await db.doc(memberPath(orgId, uid)).get();
  const status = member.get('status');
  if (!member.exists || (status !== 'active' && status !== 'suspended')) {
    throw new DomainError('NOT_FOUND', 'Member not found', { uid });
  }
  return { role: member.get('role') as Role, name: String(member.get('displayName') ?? '') };
}

/** `orgs-offboardingPlan` (SEC-05; `members.manage`): what the member leaves behind. */
export const offboardingPlanDefinition = {
  name: OFFBOARDING_CALLABLES.plan,
  input: OffboardingPlanInput,
  roles: PERMISSIONS['members.manage'],
  handler: async ({ input, orgId, db }): Promise<OffboardingPlan> => {
    await leavingMember(db, orgId, input.uid);
    const [work, personal, timer, integrations] = await Promise.all([
      openWork(db, orgId, input.uid),
      personalTasksOf(db, orgId, input.uid),
      timerOf(db, orgId, input.uid),
      db.collection(`orgs/${orgId}/integrations`).where('uid', '==', input.uid).get(),
    ]);
    return {
      uid: input.uid,
      tasks: work.tasks.length,
      deadlines: work.deadlines.length,
      matters: work.matters.length,
      privileged: work.privileged,
      personalTasks: personal.filter((doc) => !isDeleted(doc.data())).length,
      timer: timer !== null,
      integrations: integrations.size,
    };
  },
} satisfies CallableDefinition<typeof OffboardingPlanInput, OffboardingPlan>;

/**
 * Checks who takes each kind of work: required when there is some, an active member other than the
 * one leaving, not read-only, and able to see privileged matters when any of it is privileged.
 * Errors name the field (`reassign.tasks`), as the wizard shows them.
 */
async function assertTakers(
  db: Firestore,
  orgId: string,
  leaving: string,
  work: Work,
  reassign: { [K in WorkKind]?: string | undefined },
): Promise<void> {
  const fields: Record<string, string[]> = {};
  for (const kind of ['tasks', 'deadlines', 'matters'] as const) {
    const count = work[kind].length;
    const taker = reassign[kind];
    if (!count) continue;
    if (!taker) {
      fields[`reassign.${kind}`] = ['Choose who takes these'];
      continue;
    }
    const member = taker === leaving ? null : await db.doc(memberPath(orgId, taker)).get();
    const role = member?.get('role') as Role | undefined;
    if (!member?.exists || member.get('status') !== 'active' || !role || role === 'readonly') {
      fields[`reassign.${kind}`] = ['Choose an active member who isn’t leaving'];
    } else if (work.privileged[kind] && !can(role, 'privileged.view')) {
      fields[`reassign.${kind}`] = ['Some of this is privileged: choose someone who can see privileged matters'];
    }
  }
  if (Object.keys(fields).length) throw new DomainError('INVALID_ARGUMENT', 'Choose who takes the work', { fields });
}

/** Applies `patch` to every document, in batches. */
async function updateAll(db: Firestore, refs: DocumentReference[], patch: Data): Promise<number> {
  for (let i = 0; i < refs.length; i += BATCH) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + BATCH)) batch.update(ref, patch);
    await batch.commit();
  }
  return refs.length;
}

async function deleteAll(db: Firestore, refs: DocumentReference[]): Promise<number> {
  for (let i = 0; i < refs.length; i += BATCH) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + BATCH)) batch.delete(ref);
    await batch.commit();
  }
  return refs.length;
}

/**
 * Saves the leaving member's timer as draft time entries (one a day, so none passes the 100-hour
 * limit), priced as `time-stopTimer` would, and deletes it. When its matter is gone the timer is
 * just deleted (`discarded`).
 */
async function saveTimer(ctx: MemberCtx, uid: string): Promise<'saved' | 'discarded' | 'none'> {
  const { db, orgId, requestId } = ctx;
  const clock = await orgClock(db, orgId, ctx.clock);
  const [org, member] = await db.getAll(db.doc(`orgs/${orgId}`), db.doc(memberPath(orgId, uid)));
  const timeZone = validTimeZone(org?.get('timezone') as string | undefined);
  const billing = rateOrg(org?.data());
  const timerRef = db.doc(timerPath(uid));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(timerRef);
    const timer = snap.data();
    if (!snap.exists || !timer || timer['orgId'] !== orgId) return 'none';
    const matterId = String(timer['matterId'] ?? '');
    const matter = matterId ? (await tx.get(db.doc(matterPath(orgId, matterId)))).data() : undefined;
    const now = clock.now();
    const parts = timerEntries(now.getTime(), serverElapsedMs(timer, now), timeZone, true).filter(
      (part) => part.minutes > 0,
    );
    if (!matter || isDeleted(matter) || !parts.length) {
      tx.delete(timerRef);
      return 'discarded';
    }
    const taskId = typeof timer['taskId'] === 'string' ? timer['taskId'] : undefined;
    for (const part of parts) {
      const values = billing
        ? computeTimeEntry({
            minutes: part.minutes,
            date: part.date,
            org: billing,
            matter: matter as RateMatter,
            member: (member?.data() as RateMember | undefined) ?? null,
          })
        : { units: 0, rateCents: 0, amountCents: 0 };
      tx.set(db.collection(`${matterPath(orgId, matterId)}/timeEntries`).doc(), {
        orgId,
        matterId,
        uid,
        date: part.date,
        minutes: part.minutes,
        units: values.units,
        rateCents: values.rateCents,
        amountCents: values.amountCents,
        narrative: 'Timer stopped when they left the practice',
        billable: defaultBillable(matter as RateMatter),
        status: 'draft',
        source: 'timer',
        ...(taskId ? { taskId } : {}),
        wipCountedCents: 0,
        createdAt: now,
        createdBy: ctx.uid,
        updatedAt: now,
        updatedBy: ctx.uid,
        schemaVersion: TimeEntry.version,
        _requestId: requestId,
      });
    }
    tx.delete(timerRef);
    return 'saved';
  });
}

const dateOnly = (value: unknown) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '');
const instant = (value: unknown) => {
  const at = value instanceof Date ? value : (value as { toDate?: () => Date } | null | undefined)?.toDate?.();
  return at ? at.toISOString().slice(0, 10) : '';
};

/** The personal tasks as a CSV (with a byte-order mark, so Excel reads it as UTF-8). */
export function personalTasksCsv(tasks: Data[]): string {
  const rows = tasks.map((task) => {
    const checklist = Array.isArray(task['checklist']) ? (task['checklist'] as { done?: unknown }[]) : [];
    return exportLine([
      task['title'],
      task['status'],
      task['priority'],
      dateOnly(task['dueDate']),
      task['group'],
      task['descriptionMd'],
      checklist.length ? `${checklist.filter((item) => item.done === true).length} of ${checklist.length} done` : '',
      instant(task['createdAt']),
    ]);
  });
  return `${CSV_BOM}${[exportLine(PERSONAL_TASK_EXPORT_COLUMNS), ...rows].join('\r\n')}\r\n`;
}

/**
 * Writes the leaving member's personal tasks to a CSV export for the admin doing this (an export
 * job like any other: `jobs-getExportUrl` downloads it, `jobs-sweepExports` deletes it after 7
 * days), and tells them (`export_ready`). Returns the job's id.
 */
async function exportPersonalTasks(
  ctx: MemberCtx,
  files: FileStore,
  leaving: { uid: string; name: string },
  tasks: DocumentSnapshot[],
): Promise<string> {
  const { db, orgId, uid, clock, log, ports } = ctx;
  const now = clock.now();
  const org = (await db.doc(`orgs/${orgId}`).get()).data();
  const day = today(validTimeZone(org?.['timezone'] as string | undefined), now);
  const ref = db.collection(`orgs/${orgId}/jobs`).doc();
  const name = `Personal tasks of ${leaving.name || 'a former member'} ${day}`.slice(0, 250);
  const bytes = Buffer.from(personalTasksCsv(tasks.map((doc) => doc.data() ?? {})), 'utf8');
  const storagePath = `orgs/${orgId}/exports/${ref.id}.csv`;
  await files.write(storagePath, bytes, {
    contentType: 'text/csv; charset=utf-8',
    disposition: attachmentDisposition(exportFileName(name, 'csv')),
  });
  await ref.create(
    Job.schema.parse({
      type: 'csv.export',
      input: { kind: 'personalTasks', memberUid: leaving.uid },
      target: { kind: 'export', name },
      status: 'succeeded',
      progress: { done: tasks.length, total: tasks.length, stage: 'exporting' },
      output: {
        storagePath,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        pages: 0,
        rows: tasks.length,
      },
      warnings: [],
      attempts: 1,
      startedAt: now,
      finishedAt: now,
      createdAt: now,
      createdBy: uid,
      updatedAt: now,
      updatedBy: uid,
      schemaVersion: Job.version,
      _requestId: ctx.requestId,
    }),
  );
  await notify(
    { db, orgId, clock, log, ports },
    {
      kind: 'export_ready',
      exportId: ref.id,
      recipients: [uid],
      title: 'The personal tasks export is ready',
      body: `${tasks.length.toLocaleString('en-AU')} tasks. The file is kept for 7 days.`,
      link: `/exports/${ref.id}`,
      key: `export-${ref.id}`,
    },
  );
  return ref.id;
}

/**
 * `orgs-offboardMember` (SEC-05; `members.manage`, signed in within the last few minutes): hands
 * on the member's work, deals with what is theirs alone, and removes them.
 *
 * Open matter tasks, upcoming deadlines and the matters they are responsible for go to the members
 * named in `reassign` (required for each kind there is; privileged work only to someone who can see
 * it: INVALID_ARGUMENT names the field). Their timer is saved as draft time. Their personal tasks
 * are exported to the caller and deleted, or just deleted. Then, as `orgs-removeMember`: status
 * `removed`, signed out when this was their active practice, claims recomputed (their other
 * practices are untouched) and their own connections revoked. Audited as `member.offboarded`.
 * Retrying after a failure picks up what is left.
 */
export function offboardMemberDefinition(files: () => FileStore = () => storageFiles()) {
  return {
    name: OFFBOARDING_CALLABLES.offboard,
    input: OffboardMemberInput,
    roles: PERMISSIONS['members.manage'],
    idempotent: true,
    recentLoginMinutes: SENSITIVE_REAUTH_MINUTES,
    secrets: OAUTH_SECRETS,
    handler: async (ctx): Promise<OffboardMemberResult> => {
      const { input, db, orgId, clock } = ctx;
      const leaving = await leavingMember(db, orgId, input.uid);
      assertCanGrant(ctx.role, leaving.role);
      const work = await openWork(db, orgId, input.uid);
      await assertTakers(db, orgId, input.uid, work, input.reassign);

      const now = clock.now();
      const stamp = { updatedAt: now, updatedBy: ctx.uid, _requestId: ctx.requestId };
      const moved = {
        tasks: await updateAll(
          db,
          work.tasks.map((doc) => doc.ref),
          { assigneeUid: input.reassign.tasks, ...stamp },
        ),
        deadlines: await updateAll(
          db,
          work.deadlines.map((doc) => doc.ref),
          { assigneeUid: input.reassign.deadlines, ...stamp },
        ),
        matters: await updateAll(
          db,
          work.matters.map((doc) => doc.ref),
          {
            responsibleUid: input.reassign.matters,
            teamUids: FieldValue.arrayUnion(input.reassign.matters),
            ...stamp,
          },
        ),
      };

      const timer = await saveTimer(ctx, input.uid);

      const personal = await personalTasksOf(db, orgId, input.uid);
      const live = personal.filter((doc) => !isDeleted(doc.data()));
      const choice: PersonalTasksChoice = input.personalTasks;
      const exportJobId =
        choice === 'export' && live.length
          ? await exportPersonalTasks(ctx, files(), { uid: input.uid, name: leaving.name }, live)
          : undefined;
      await deleteAll(
        db,
        personal.map((doc) => doc.ref),
      );

      await changeMember(ctx, input.uid, (member) => {
        assertCanGrant(ctx.role, member.role);
        return { status: 'removed' };
      });
      const tokensRevoked = await revokeIfActive(ctx, db, input.uid);
      await syncMember(ctx, input.uid);
      // Best effort: a provider being down never blocks removing someone.
      const integrationsRemoved = await removeMemberConnections(ctx, input.uid).catch((error: unknown) => {
        ctx.log.warn('member integrations not removed', errorReportFields(error));
        return 0;
      });
      const claudeConnectionsEnded = await endClaudeConnections(ctx, input.uid);

      const result: OffboardMemberResult = {
        ok: true,
        tokensRevoked,
        moved,
        personalTasks: { choice, count: live.length, ...(exportJobId ? { exportJobId } : {}) },
        timer,
        integrationsRemoved,
      };
      await audit(ctx, {
        action: 'member.offboarded',
        entity: { path: memberPath(orgId, input.uid) },
        summary: 'Member offboarded and removed',
        data: {
          tokensRevoked,
          moved,
          reassignedTo: {
            ...(moved.tasks ? { tasks: input.reassign.tasks } : {}),
            ...(moved.deadlines ? { deadlines: input.reassign.deadlines } : {}),
            ...(moved.matters ? { matters: input.reassign.matters } : {}),
          },
          personalTasks: { choice, count: live.length, ...(exportJobId ? { exportJobId } : {}) },
          timer,
          integrationsRemoved,
          ...(claudeConnectionsEnded ? { claudeConnectionsEnded } : {}),
        },
      });
      ctx.log.info('member offboarded', { moved, personalTasks: live.length, choice, timer, integrationsRemoved });
      return result;
    },
  } satisfies CallableDefinition<typeof OffboardMemberInput, OffboardMemberResult>;
}

export const offboardingPlan = defineCallable(offboardingPlanDefinition);
export const offboardMember = defineCallable(offboardMemberDefinition());
