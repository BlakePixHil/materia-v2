import type { Calendar, RuleSetVersion } from '@materia/domain';

import type { CalendarYear, RuleSet } from './model';

type WithoutMeta<T> = Omit<
  T,
  'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy' | 'schemaVersion' | 'migration' | 'needsReview'
>;

/** Firestore id of a calendar year: `calendars/{calendarId}-{year}`. */
export function calendarDocId(calendar: Pick<CalendarYear, 'calendarId' | 'year'>): string {
  return `${calendar.calendarId}-${calendar.year}`;
}

/** A calendar year as stored in `calendars/*` (meta fields added by the writer). */
export function toCalendarDoc(calendar: CalendarYear): WithoutMeta<Calendar> {
  return {
    jurisdiction: calendar.jurisdiction,
    year: calendar.year,
    calendarId: calendar.calendarId,
    kind: calendar.kind,
    holidays: calendar.holidays.map((h) => ({
      date: h.date,
      name: h.name,
      ...(h.provisional ? { provisional: true } : {}),
    })),
    closures: calendar.closures.map((c) => ({ from: c.from, to: c.to, body: calendar.calendarId, name: c.name })),
    source: calendar.source,
    verified: calendar.verified,
  };
}

/**
 * A rule set as stored in `ruleSets/{ruleSetId}/versions/{version}`: each rule keeps its id, title
 * and citation as fields, with the rest of its definition alongside.
 */
export function toRuleSetDoc(ruleSet: RuleSet): WithoutMeta<RuleSetVersion> {
  return {
    ruleSetId: ruleSet.ruleSetId,
    version: ruleSet.version,
    jurisdiction: ruleSet.jurisdiction,
    published: ruleSet.published,
    practitionerReviewed: ruleSet.practitionerReviewed,
    rules: ruleSet.rules.map(({ id, title, citation, ...definition }) => ({ id, title, citation, definition })),
  };
}
