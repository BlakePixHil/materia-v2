import type { Firestore, Query, QuerySnapshot, Transaction } from 'firebase-admin/firestore';

import {
  can,
  computeTimeEntry,
  defaultBillable,
  DomainError,
  keyFactEventKind,
  keyFactPatch,
  keyFactsFor,
  keyFactValue,
  ManualDeadlineCreateInput,
  Matter,
  MatterDocument,
  MatterTypeSchema,
  orderBetween,
  partyDocId,
  Deadline,
  Task,
  TimeEntry,
  type FactMatter,
  type RateMatter,
  type RateMember,
  type SuggestionKind,
} from '@materia/domain';

import { registerSuggestionHandler, type ApplyContext, type SuggestionHandler } from './registry';
import { type Data } from './shared';
import { compact, stamp } from '../contacts/shared';
import type { CallableContext } from '../core/callable';
import { recordEvent } from '../deadlines/events';
import { deadlinesPath, eventsPath, tasksPath } from '../deadlines/shared';
import { keepFactCitations } from '../matters/fact-citations';
import { upsertPartyChange } from '../matters/parties';
import { matterPath } from '../matters/shared';
import { createNote } from '../notes/create';
import { rateOrg } from '../time/shared';

/**
 * The built-in accept handlers (AI-07, ADR-037), one per kind, each through the domain logic of
 * the manual path: tasks and manual deadlines as the client creates them (validated by the same
 * schemas; the triggers count, remind and log them), events through the `deadlines-upsertEvent`
 * logic (which recomputes the deadlines), parties through `matters-upsertParty`'s, notes through
 * `notes-create`'s, key facts through `keyFactPatch` (or their event) with what Clerk cited kept
 * beside them (CORE-06a), a document's category and title as the documents screen edits them, and
 * time as a draft entry of the person accepting (BILL-01; `time-onWrite` prices it and counts it
 * into WIP). The litigation kinds (`chronology`, `order`, `evidence`; LIT tickets) have none yet.
 */

/** What the shared helpers use of a handler's context (everything but the typed payload). */
type ApplyBase = Omit<ApplyContext<SuggestionKind>, 'payload'>;

const isLive = (data: Data | undefined) => !!data && (data['deletedAt'] === undefined || data['deletedAt'] === null);

/** The context a shared callable core expects, for the person accepting. */
function callableContext<T>(ctx: ApplyBase, input: T): CallableContext<T> {
  return {
    input,
    uid: ctx.uid,
    orgId: ctx.orgId,
    role: ctx.role,
    token: {},
    requestId: ctx.requestId,
    log: ctx.log,
    clock: ctx.clock,
    db: ctx.db,
    ports: ctx.ports,
    auth: () => {
      throw new Error('Accepting a suggestion never uses Auth');
    },
  };
}

const invalid = (fields: Record<string, string[]>) =>
  new DomainError('INVALID_ARGUMENT', 'The suggestion can’t be applied as it stands', { fields });

/** Field errors from a failed schema parse, keyed by path. */
function issuesOf(error: { issues: { path: PropertyKey[]; message: string }[] }): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) (fields[issue.path.map(String).join('.')] ??= []).push(issue.message);
  return fields;
}

/** An assignee must be an active, non-read-only member. */
async function assertAssignee(ctx: ApplyBase, tx: Transaction, uid: string | undefined) {
  if (!uid) return;
  const member = await tx.get(ctx.db.doc(`orgs/${ctx.orgId}/members/${uid}`));
  if (!member.exists || member.get('status') !== 'active' || member.get('role') === 'readonly') {
    throw invalid({ assigneeUid: ['Choose an active member who can work on the matter'] });
  }
}

/** A live record in a matter collection with this exact title and due date (absent matches absent). */
async function sameTitleAndDue(
  ctx: {
    db: Firestore;
    read: { query: (q: Query) => Promise<QuerySnapshot> };
  },
  path: string,
  title: string,
  dueDate: string | undefined,
): Promise<boolean> {
  const snap = await ctx.read.query(ctx.db.collection(path).where('title', '==', title));
  return snap.docs.some((doc) => isLive(doc.data()) && (doc.get('dueDate') ?? undefined) === dueDate);
}

const task: SuggestionHandler<'task'> = {
  kind: 'task',
  exists: (ctx) => sameTitleAndDue(ctx, tasksPath(ctx.orgId, ctx.matterId), ctx.payload.title, ctx.payload.dueDate),
  async apply(ctx) {
    const { db, orgId, matterId, uid, requestId, payload, join } = ctx;
    const collection = db.collection(tasksPath(orgId, matterId));
    const ref = collection.doc();
    const now = ctx.clock.now();
    await db.runTransaction(async (tx) => {
      await join.read(tx);
      await assertAssignee(ctx, tx, payload.assigneeUid);
      const last = await tx.get(collection.orderBy('order', 'desc').limit(1));
      const lastOrder = last.docs[0]?.get('order');
      const order = orderBetween(typeof lastOrder === 'number' ? lastOrder : undefined, undefined) ?? now.getTime();
      // As a client creates a manual task (`MatterTaskCreateInput`), with `source: 'clerk'`:
      // tasks-onWrite counts it, notifies its assignee and logs the activity.
      tx.create(
        ref,
        Task.schema.parse(
          compact({
            title: payload.title,
            descriptionMd: payload.descriptionMd,
            status: 'todo',
            priority: payload.priority,
            assigneeUid: payload.assigneeUid,
            dueDate: payload.dueDate,
            group: payload.group,
            checklist: [],
            order,
            source: 'clerk',
            orgId,
            matterId,
            countedOpen: false,
            createdAt: now,
            createdBy: uid,
            ...stamp(uid, now, requestId),
            schemaVersion: Task.version,
          }),
        ),
      );
      join.write(tx, ref.path);
    });
    return { resultRef: ref.path };
  },
};

const deadline: SuggestionHandler<'deadline'> = {
  kind: 'deadline',
  exists: (ctx) => sameTitleAndDue(ctx, deadlinesPath(ctx.orgId, ctx.matterId), ctx.payload.title, ctx.payload.dueDate),
  async apply(ctx) {
    const { db, orgId, matterId, uid, requestId, payload, join } = ctx;
    const ref = db.collection(deadlinesPath(orgId, matterId)).doc();
    const now = ctx.clock.now();
    await db.runTransaction(async (tx) => {
      await join.read(tx);
      const matter = (await tx.get(db.doc(matterPath(orgId, matterId)))).data() ?? {};
      const responsible = typeof matter['responsibleUid'] === 'string' ? matter['responsibleUid'] : undefined;
      const assigneeUid = payload.assigneeUid ?? responsible ?? uid;
      if (payload.assigneeUid) await assertAssignee(ctx, tx, payload.assigneeUid);
      // A manual deadline, exactly as a client creates one (CORE-10): deadlines-onWrite schedules
      // its reminders and updates the matter's next deadline.
      const fields = ManualDeadlineCreateInput.safeParse(
        compact({
          orgId,
          matterId,
          title: payload.title,
          dueDate: payload.dueDate,
          dueTime: payload.dueTime,
          kind: payload.kind,
          critical: payload.critical,
          assigneeUid,
          privileged: matter['privileged'] === true,
        }),
      );
      if (!fields.success) throw invalid(issuesOf(fields.error));
      tx.create(
        ref,
        Deadline.schema.parse({
          ...fields.data,
          pastOnCreation: false,
          createdAt: now,
          createdBy: uid,
          ...stamp(uid, now, requestId),
          schemaVersion: Deadline.version,
        }),
      );
      join.write(tx, ref.path);
    });
    return { resultRef: ref.path };
  },
};

/** Records an event through the `deadlines-upsertEvent` logic (which recomputes the deadlines). */
async function applyEvent(
  ctx: ApplyBase,
  fields: {
    eventId?: string | undefined;
    kind: string;
    date: string;
    time?: string | undefined;
    label?: string | undefined;
    sourceDocumentId?: string | undefined;
  },
): Promise<string> {
  let eventId = fields.eventId;
  if (!eventId && (fields.kind === 'date_of_death' || fields.kind === 'grant_issued')) {
    // A single-valued event (it sets a key fact): edit the one already recorded, as the key facts
    // card does, rather than add a second date of death.
    const existing = await ctx.db
      .collection(eventsPath(ctx.orgId, ctx.matterId))
      .where('kind', '==', fields.kind)
      .get();
    eventId = existing.docs.find((doc) => isLive(doc.data()))?.id;
  }
  const result = await recordEvent(
    callableContext(
      ctx,
      compact({
        requestId: ctx.requestId,
        matterId: ctx.matterId,
        eventId,
        kind: fields.kind,
        date: fields.date,
        time: fields.time,
        label: fields.label,
        sourceDocumentId: fields.sourceDocumentId,
      }) as never,
    ),
    ctx.join,
  );
  return `${eventsPath(ctx.orgId, ctx.matterId)}/${result.eventId}`;
}

const event: SuggestionHandler<'event'> = {
  kind: 'event',
  async exists(ctx) {
    const snap = await ctx.read.query(
      ctx.db.collection(eventsPath(ctx.orgId, ctx.matterId)).where('kind', '==', ctx.payload.kind),
    );
    return snap.docs.some((doc) => isLive(doc.data()) && doc.get('date') === ctx.payload.date);
  },
  async apply(ctx) {
    return { resultRef: await applyEvent(ctx, compact({ ...ctx.payload })) };
  },
};

const keyFact: SuggestionHandler<'key_fact'> = {
  kind: 'key_fact',
  exists: async (ctx) => keyFactValue(ctx.matter as FactMatter, ctx.payload.field) === ctx.payload.value,
  async apply(ctx) {
    const { db, orgId, matterId, uid, requestId, payload } = ctx;
    // What Clerk cited is kept with the fact, in the same transaction (CORE-06a).
    const join = keepFactCitations(ctx.join, { ...ctx, field: payload.field, value: payload.value });
    const eventKind = keyFactEventKind(payload.field);
    if (eventKind) {
      // The date of death and the grant date are events (CORE-10): recording them recomputes.
      return { resultRef: await applyEvent({ ...ctx, join }, { kind: eventKind, date: String(payload.value) }) };
    }
    const matterRef = db.doc(matterPath(orgId, matterId));
    const now = ctx.clock.now();
    await db.runTransaction(async (tx) => {
      await join.read(tx);
      const matter = (await tx.get(matterRef)).data() ?? {};
      const type = MatterTypeSchema.safeParse(matter['type']);
      if (!type.success || !keyFactsFor(type.data).some((fact) => fact.id === payload.field)) {
        throw invalid({ field: ['This matter type doesn’t record that key fact'] });
      }
      let patch: Data;
      try {
        patch = keyFactPatch(matter as FactMatter, payload.field, payload.value);
      } catch {
        throw invalid({ value: ['This fact can’t be set on this matter yet'] });
      }
      const checked = Matter.update.safeParse(patch);
      if (!checked.success) throw invalid(issuesOf(checked.error));
      tx.update(matterRef, { ...patch, ...stamp(uid, now, requestId) });
      join.write(tx, matterRef.path);
    });
    return { resultRef: matterRef.path };
  },
};

const note: SuggestionHandler<'note'> = {
  kind: 'note',
  async apply(ctx) {
    // A note from privileged material is privileged (Clerk rule 6); the matter's flag still applies.
    const result = await createNote(
      callableContext(ctx, {
        requestId: ctx.requestId,
        matterId: ctx.matterId,
        bodyMd: ctx.payload.bodyMd,
        pinned: ctx.payload.pinned,
        privileged: ctx.suggestion.privileged,
      }),
      { source: 'clerk', join: ctx.join },
    );
    return { resultRef: `${matterPath(ctx.orgId, ctx.matterId)}/notes/${result.noteId}` };
  },
};

const party: SuggestionHandler<'party'> = {
  kind: 'party',
  async exists(ctx) {
    const id = partyDocId(ctx.payload.role, ctx.payload.contactId);
    const snap = await ctx.read.doc(ctx.db.doc(`${matterPath(ctx.orgId, ctx.matterId)}/parties/${id}`));
    return snap.exists && isLive(snap.data());
  },
  async apply(ctx) {
    const result = await upsertPartyChange(
      callableContext(
        ctx,
        compact({
          requestId: ctx.requestId,
          matterId: ctx.matterId,
          contactId: ctx.payload.contactId,
          role: ctx.payload.role,
          share: ctx.payload.share,
          notes: ctx.payload.notes,
        }),
      ),
      ctx.join,
    );
    return { resultRef: `${matterPath(ctx.orgId, ctx.matterId)}/parties/${result.partyId}` };
  },
};

const documentMeta: SuggestionHandler<'document_meta'> = {
  kind: 'document_meta',
  async exists(ctx) {
    const snap = await ctx.read.doc(
      ctx.db.doc(`${matterPath(ctx.orgId, ctx.matterId)}/documents/${ctx.payload.documentId}`),
    );
    const data = snap.data();
    if (!snap.exists || !isLive(data)) return false;
    return (
      (ctx.payload.category === undefined || data?.['category'] === ctx.payload.category) &&
      (ctx.payload.title === undefined || data?.['name'] === ctx.payload.title)
    );
  },
  async apply(ctx) {
    const { db, orgId, matterId, uid, role, requestId, payload, join } = ctx;
    const ref = db.doc(`${matterPath(orgId, matterId)}/documents/${payload.documentId}`);
    const now = ctx.clock.now();
    await db.runTransaction(async (tx) => {
      await join.read(tx);
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!snap.exists || !isLive(data) || (data?.['privileged'] === true && !can(role, 'privileged.view'))) {
        throw new DomainError('NOT_FOUND', 'Document not found', { documentId: payload.documentId });
      }
      // The fields the documents screen edits (`MatterDocument.update`): the title is the name.
      const patch = MatterDocument.update.safeParse(compact({ name: payload.title, category: payload.category }));
      if (!patch.success) throw invalid(issuesOf(patch.error));
      tx.update(ref, { ...patch.data, ...stamp(uid, now, requestId) });
      join.write(tx, ref.path);
    });
    return { resultRef: ref.path };
  },
};

const timeEntry: SuggestionHandler<'time_entry'> = {
  kind: 'time_entry',
  async exists(ctx) {
    const snap = await ctx.read.query(
      ctx.db
        .collection(`${matterPath(ctx.orgId, ctx.matterId)}/timeEntries`)
        .where('date', '==', ctx.payload.date)
        .where('minutes', '==', ctx.payload.minutes),
    );
    const narrative = ctx.payload.narrative.trim();
    return snap.docs.some((doc) => isLive(doc.data()) && String(doc.get('narrative') ?? '').trim() === narrative);
  },
  async apply(ctx) {
    const { db, orgId, matterId, uid, requestId, payload, join } = ctx;
    const ref = db.collection(`${matterPath(orgId, matterId)}/timeEntries`).doc();
    const now = ctx.clock.now();
    await db.runTransaction(async (tx) => {
      await join.read(tx);
      const [matterSnap, org, member] = await Promise.all([
        tx.get(db.doc(matterPath(orgId, matterId))),
        tx.get(db.doc(`orgs/${orgId}`)),
        tx.get(db.doc(`orgs/${orgId}/members/${uid}`)),
      ]);
      const matter = (matterSnap.data() ?? {}) as RateMatter;
      if (payload.taskId) {
        const linked = await tx.get(db.doc(`${tasksPath(orgId, matterId)}/${payload.taskId}`));
        if (!linked.exists || !isLive(linked.data())) throw invalid({ taskId: ['That task isn’t on this matter'] });
      }
      // A draft of the person accepting, as a client creates one (`TimeEntryCreateInput`) but with
      // `source: 'clerk'`; priced here for the preview, and re-priced and counted by time-onWrite.
      const billing = rateOrg(org.data());
      const values = billing
        ? computeTimeEntry({
            minutes: payload.minutes,
            date: payload.date,
            org: billing,
            matter,
            member: (member.data() as RateMember | undefined) ?? null,
          })
        : { units: 0, rateCents: 0, amountCents: 0 };
      const entry = TimeEntry.schema.safeParse(
        compact({
          orgId,
          matterId,
          uid,
          date: payload.date,
          minutes: payload.minutes,
          units: values.units,
          rateCents: values.rateCents,
          amountCents: values.amountCents,
          narrative: payload.narrative.trim(),
          billable: payload.billable ?? defaultBillable(matter),
          status: 'draft',
          source: 'clerk',
          taskId: payload.taskId,
          wipCountedCents: 0,
          createdAt: now,
          createdBy: uid,
          ...stamp(uid, now, requestId),
          schemaVersion: TimeEntry.version,
        }),
      );
      if (!entry.success) throw invalid(issuesOf(entry.error));
      tx.create(ref, entry.data);
      join.write(tx, ref.path);
    });
    return { resultRef: ref.path };
  },
};

/** Registers the built-in handlers (idempotent). */
export function registerBuiltInHandlers(): void {
  for (const handler of [task, deadline, event, keyFact, note, party, documentMeta, timeEntry]) {
    registerSuggestionHandler(handler as unknown as SuggestionHandler);
  }
}

registerBuiltInHandlers();
