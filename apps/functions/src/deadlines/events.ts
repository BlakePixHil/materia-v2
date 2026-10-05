import {
  compareDates,
  DeleteEventInput,
  DomainError,
  PERMISSIONS,
  RecomputeDeadlinesInput,
  today,
  UpsertEventInput,
  type DeleteEventResult,
  type RecomputeSummary,
  type UpsertEventResult,
} from '@materia/domain';

import { recomputeMatter, type RecomputeOutcome } from './recompute';
import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { matterPath } from '../matters/shared';
import { orgTimeZone } from '../templates/shared';

/** The callable's view of a recompute (the internal fields dropped). */
function summary(outcome: RecomputeOutcome): RecomputeSummary {
  const { filledTaskIds, eventId, ...rest } = outcome;
  void filledTaskIds;
  void eventId;
  return rest;
}

/**
 * `deadlines-upsertEvent` (CORE-10; matter.edit, idempotent): records a matter event or edits one
 * (`eventId`), then recomputes the matter's deadlines in the same transaction. A date of death
 * after today (org time zone) is INVALID_ARGUMENT on `date`. A `date_of_death` or `grant_issued`
 * event also sets the key fact it stands for, and template tasks whose due date was pending on the
 * event get one (CORE-07b). Audited as `matter.event_recorded`.
 */
export const upsertEventDefinition = {
  name: 'deadlines-upsertEvent',
  input: UpsertEventInput,
  roles: PERMISSIONS['matter.edit'],
  idempotent: true,
  handler: async (ctx): Promise<UpsertEventResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const clock = await orgClock(db, orgId, ctx.clock);
    if (input.kind === 'date_of_death') {
      const now = today(await orgTimeZone(db, orgId), clock.now());
      if (compareDates(input.date, now) > 0) {
        throw new DomainError('INVALID_ARGUMENT', 'A date of death can’t be in the future', {
          fields: { date: ['A date of death can’t be after today'] },
        });
      }
    }
    const outcome = await recomputeMatter(db, {
      orgId,
      matterId: input.matterId,
      uid,
      role,
      requestId,
      cause: 'event',
      clock,
      log,
      event: {
        eventId: input.eventId,
        fields: {
          kind: input.kind,
          date: input.date,
          time: input.time,
          label: input.label,
          meta: input.meta,
          sourceDocumentId: input.sourceDocumentId,
        },
      },
    });
    const eventId = outcome.eventId as string;
    await audit(
      { uid, orgId, requestId, db, clock },
      {
        action: 'matter.event_recorded',
        entity: { path: `${matterPath(orgId, input.matterId)}/events/${eventId}` },
        summary: `Event ${input.kind} ${input.eventId ? 'edited' : 'recorded'} on matter ${input.matterId}`,
        data: {
          kind: input.kind,
          date: input.date,
          proposed: outcome.proposed.length,
          created: outcome.created.length,
        },
      },
    );
    return { eventId, recompute: summary(outcome), filledTaskIds: outcome.filledTaskIds };
  },
} satisfies CallableDefinition<typeof UpsertEventInput, UpsertEventResult>;

/**
 * `deadlines-deleteEvent` (CORE-10; matter.edit, idempotent): soft-deletes a live event and
 * recomputes: deadlines anchored on it become removal proposals. Audited as `matter.event_deleted`.
 */
export const deleteEventDefinition = {
  name: 'deadlines-deleteEvent',
  input: DeleteEventInput,
  roles: PERMISSIONS['matter.edit'],
  idempotent: true,
  handler: async (ctx): Promise<DeleteEventResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const clock = await orgClock(db, orgId, ctx.clock);
    const outcome = await recomputeMatter(db, {
      orgId,
      matterId: input.matterId,
      uid,
      role,
      requestId,
      cause: 'event',
      clock,
      log,
      event: { eventId: input.eventId, fields: null },
    });
    await audit(
      { uid, orgId, requestId, db, clock },
      {
        action: 'matter.event_deleted',
        entity: { path: `${matterPath(orgId, input.matterId)}/events/${input.eventId}` },
        summary: `Event deleted on matter ${input.matterId}`,
        data: { proposed: outcome.proposed.length },
      },
    );
    return { eventId: input.eventId, recompute: summary(outcome) };
  },
} satisfies CallableDefinition<typeof DeleteEventInput, DeleteEventResult>;

/**
 * `deadlines-recompute` (CORE-10; matter.edit): recomputes a matter's deadlines. Safe to repeat:
 * with nothing changed it writes nothing.
 */
export const recomputeDefinition = {
  name: 'deadlines-recompute',
  input: RecomputeDeadlinesInput,
  roles: PERMISSIONS['matter.edit'],
  handler: async (ctx): Promise<RecomputeSummary> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const clock = await orgClock(db, orgId, ctx.clock);
    const outcome = await recomputeMatter(db, {
      orgId,
      matterId: input.matterId,
      uid,
      role,
      requestId,
      cause: 'recompute',
      clock,
      log,
    });
    return summary(outcome);
  },
} satisfies CallableDefinition<typeof RecomputeDeadlinesInput, RecomputeSummary>;

export const upsertEvent = defineCallable(upsertEventDefinition);
export const deleteEvent = defineCallable(deleteEventDefinition);
export const recompute = defineCallable(recomputeDefinition);
