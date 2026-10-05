import type { Firestore } from 'firebase-admin/firestore';

import {
  DEFAULT_LOCALITY,
  fromRuleSetDoc,
  latestRuleSet,
  LOCALITY_CALENDARS,
  statutoryFlagKey,
  type EngineEvent,
  type RuleSet,
} from '@materia/deadlines';
import {
  EVENT_KEY_FACTS,
  EventKindSchema,
  isFlagKey,
  keyFactValue,
  type DateOnly,
  type EventKind,
  type FactMatter,
} from '@materia/domain';

import { isDeleted } from '../contacts/shared';
import { isEnabled, type FlagContext } from '../core/flags';
import type { Log } from '../core/log';
import { matterPath } from '../matters/shared';

/** Shared helpers for the deadlines functions (CORE-10). */

type Data = Record<string, unknown>;

export const eventsPath = (orgId: string, matterId: string) => `${matterPath(orgId, matterId)}/events`;
export const deadlinesPath = (orgId: string, matterId: string) => `${matterPath(orgId, matterId)}/deadlines`;
export const changesPath = (orgId: string, matterId: string) => `${matterPath(orgId, matterId)}/deadlineChanges`;
export const tasksPath = (orgId: string, matterId: string) => `${matterPath(orgId, matterId)}/tasks`;

/** Matter statuses whose deadlines are no longer recomputed. */
export const CLOSED_STATUSES: ReadonlySet<unknown> = new Set(['closed', 'archived']);

/**
 * The published versions of a rule set stored in `ruleSets/{ruleSetId}/versions/*` (versions
 * newer than the bundled ones are published there). A version that doesn't validate is skipped
 * with a warning, never half-applied.
 */
export async function storedRuleSets(db: Firestore, ruleSetId: string, log?: Log): Promise<RuleSet[]> {
  const snap = await db.collection(`ruleSets/${ruleSetId}/versions`).where('published', '==', true).get();
  const sets: RuleSet[] = [];
  for (const doc of snap.docs) {
    try {
      sets.push(fromRuleSetDoc(doc.data()));
    } catch {
      log?.warn('invalid stored rule set skipped', { ruleSetId, version: doc.id });
    }
  }
  return sets;
}

/** The latest published version of a rule set, bundled or stored. */
export async function currentRuleSet(db: Firestore, ruleSetId: string, log?: Log): Promise<RuleSet | undefined> {
  return latestRuleSet(ruleSetId, await storedRuleSets(db, ruleSetId, log));
}

/**
 * Whether a rule set version's statutory rules apply: its practitioner-review flag
 * (`deadlines.ruleset.vic.v1`) when the registry has one, else whether the version is marked
 * practitioner-reviewed. Off means statutory rules are skipped, not removed.
 */
export async function statutoryEnabled(ctx: FlagContext, ruleSet: RuleSet): Promise<boolean> {
  const key = statutoryFlagKey(ruleSet);
  return isFlagKey(key) ? isEnabled(ctx, key) : ruleSet.practitionerReviewed;
}

/** The org's locality calendar for reminders (`org.holidayLocality`). */
export function localityCalendar(org: Data | undefined): string {
  const locality = org?.['holidayLocality'];
  return (typeof locality === 'string' && LOCALITY_CALENDARS[locality]) || DEFAULT_LOCALITY;
}

export interface StoredEvent {
  id: string;
  data: Data;
}

/**
 * The engine's anchor events: the matter's live events, plus a date of death or grant date known
 * only as a key fact (`deceased.dateOfDeath`, `estate.grantDate`) when no event of that kind is
 * recorded, as template due dates read them (CORE-07).
 */
export function engineEvents(matter: Data, events: readonly StoredEvent[]): EngineEvent[] {
  const live: EngineEvent[] = events.flatMap(({ id, data }) => {
    if (isDeleted(data)) return [];
    const kind = EventKindSchema.safeParse(data['kind']);
    if (!kind.success || typeof data['date'] !== 'string') return [];
    const meta = data['meta'];
    return [
      {
        id,
        kind: kind.data,
        date: data['date'] as DateOnly,
        ...(meta && typeof meta === 'object' ? { meta: meta as EngineEvent['meta'] } : {}),
      },
    ];
  });
  for (const [kind, fact] of Object.entries(EVENT_KEY_FACTS) as [
    EventKind,
    NonNullable<(typeof EVENT_KEY_FACTS)[EventKind]>,
  ][]) {
    if (live.some((event) => event.kind === kind)) continue;
    const value = keyFactValue(matter as FactMatter, fact);
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) live.push({ kind, date: value as DateOnly });
  }
  return live;
}

/**
 * The facts rule conditions and amounts read: the matter's `estate` (`estate.hasMainResidence`),
 * `grant.filed` (an application filed or a grant issued) and the org's settings.
 */
export function matterFacts(matter: Data, events: readonly EngineEvent[]): Record<string, unknown> {
  const estate = (matter['estate'] as Data | undefined) ?? {};
  const filed = events.some((event) => event.kind === 'probate_filed' || event.kind === 'grant_issued');
  return { estate, grant: filed ? { filed: true } : {}, org: {} };
}

/** A matter's template deadline rules when it follows a template that names them (CORE-07). */
export function templateRuleIds(template: { deadlineRuleIds: readonly string[] } | undefined): string[] | undefined {
  return template && template.deadlineRuleIds.length ? [...template.deadlineRuleIds] : undefined;
}
