/**
 * The bundled data: the Victorian rule set v1 and the Victorian court and locality calendars for
 * 2025–2028, validated when loaded. Rule sets and calendars are also seeded to Firestore
 * (`ruleSets/*`, `calendars/*`); this copy lets the engine run in the browser and in tests.
 */
import { buildCalendarSet } from './calendar';
import { CalendarYearSchema, RuleSetSchema } from './model';
import vicCountyCourt2025 from '../../data/calendars/VIC_COUNTY_COURT-2025.json';
import vicCountyCourt2026 from '../../data/calendars/VIC_COUNTY_COURT-2026.json';
import vicCountyCourt2027 from '../../data/calendars/VIC_COUNTY_COURT-2027.json';
import vicCountyCourt2028 from '../../data/calendars/VIC_COUNTY_COURT-2028.json';
import vicGreaterGeelong2025 from '../../data/calendars/VIC_GREATER_GEELONG-2025.json';
import vicGreaterGeelong2026 from '../../data/calendars/VIC_GREATER_GEELONG-2026.json';
import vicGreaterGeelong2027 from '../../data/calendars/VIC_GREATER_GEELONG-2027.json';
import vicGreaterGeelong2028 from '../../data/calendars/VIC_GREATER_GEELONG-2028.json';
import vicMelbourne2025 from '../../data/calendars/VIC_MELBOURNE-2025.json';
import vicMelbourne2026 from '../../data/calendars/VIC_MELBOURNE-2026.json';
import vicMelbourne2027 from '../../data/calendars/VIC_MELBOURNE-2027.json';
import vicMelbourne2028 from '../../data/calendars/VIC_MELBOURNE-2028.json';
import vicSupremeCourt2025 from '../../data/calendars/VIC_SUPREME_COURT-2025.json';
import vicSupremeCourt2026 from '../../data/calendars/VIC_SUPREME_COURT-2026.json';
import vicSupremeCourt2027 from '../../data/calendars/VIC_SUPREME_COURT-2027.json';
import vicSupremeCourt2028 from '../../data/calendars/VIC_SUPREME_COURT-2028.json';
import vicV1 from '../../data/rulesets/vic-v1.json';

/** Victoria v1 (illustrative until practitioner sign-off; behind the deadlines.ruleset.vic flag). */
export const VIC_RULESET_V1 = RuleSetSchema.parse(vicV1);

/** Every bundled calendar year. */
export const CALENDAR_YEARS = [
  vicSupremeCourt2025,
  vicSupremeCourt2026,
  vicSupremeCourt2027,
  vicSupremeCourt2028,
  vicCountyCourt2025,
  vicCountyCourt2026,
  vicCountyCourt2027,
  vicCountyCourt2028,
  vicMelbourne2025,
  vicMelbourne2026,
  vicMelbourne2027,
  vicMelbourne2028,
  vicGreaterGeelong2025,
  vicGreaterGeelong2026,
  vicGreaterGeelong2027,
  vicGreaterGeelong2028,
].map((data) => CalendarYearSchema.parse(data));

/** VIC_SUPREME_COURT, VIC_COUNTY_COURT, VIC_MELBOURNE and VIC_GREATER_GEELONG, 2025–2028. */
export const VIC_CALENDARS = buildCalendarSet(CALENDAR_YEARS);

/** Locality calendar ids by `org.holidayLocality`. */
export const LOCALITY_CALENDARS: Readonly<Record<string, string>> = {
  VIC_MELBOURNE: 'VIC_MELBOURNE',
  VIC_GREATER_GEELONG: 'VIC_GREATER_GEELONG',
};
