# deadlines

The deadline engine (CORE-09; spec: _Deadline engine & legal rules_, `docs/06-deadline-engine.md`). Pure, deterministic TypeScript on `DateOnly`: the same input always gives the same output, in the browser, in functions and in tools.

> Every rule in `data/rulesets/vic-v1.json` is **illustrative** until a practising Victorian wills and estates lawyer signs it off. The rule set ships behind the `deadlines.ruleset.vic` flag, and rules marked `verify: true` need particular attention.

## API

```ts
import { compute, explain, diff, VIC_RULESET_V1, VIC_CALENDARS } from '@materia/deadlines';

const deadlines = compute({
  matter: { type: 'probate', jurisdiction: 'VIC', facts: { estate: { hasMainResidence: true } } },
  events: [{ id: 'ev-grant', kind: 'grant_issued', date: '2026-03-14' }],
  ruleSet: VIC_RULESET_V1,
  calendars: VIC_CALENDARS,
  localityCalendar: 'VIC_GREATER_GEELONG', // org.holidayLocality: dates reminders
  today: '2026-10-04',
});
explain(deadlines[0]); // ['anchor grant_issued = 2026-03-14 (Saturday) · event ev-grant', '+ 6 months → …', …]
diff(previous, next); // added / removed / moved (earlier?) / status: recompute proposals
```

Each `ComputedDeadline` has:

- `status`: `computed`, `blocked` (waiting on a fact, such as "No grant yet") or `invalid` (a future date of death).
- `dueDate`, `dueTime`, `reminders` and `task`. Blocked deadlines propose no task; duplicate tasks are dropped by `dedupeKey`.
- Flags: `approximate` (computed from the earliest possible anchor) and `pastOnCreation` (goes to the review queue, not marked missed).
- `trace`, a list of structured steps that `explain` renders.

A year without calendar data throws `DeadlineEngineError` (`CALENDAR_MISSING`); the engine never treats holidays as business days.

## Persisting deadlines (CORE-10)

The functions persist the engine's output with two more pure modules (ADR-027):

- `rulesets.ts`:
  - `latestRuleSet` picks the latest published version, bundled or stored (`fromRuleSetDoc`);
  - `selectRules` skips statutory rules while the version's flag is off, and keeps only a template's rules;
  - `computeSafely` runs the engine, blocking only the rules whose calendar year is missing (`calendar_missing`) instead of failing the matter.
- `persist.ts`:
  - `planRecompute` turns results plus the stored deadlines and pending proposals into a plan (creates, in-place updates, proposals, superseded proposals, override conflicts and rule tasks);
  - running the plan again on its own result plans nothing.

## Rules

Rules are data (`RuleSetSchema`, validated when loaded):

- **Anchors and offsets:** an anchor event, with an offset in days, business days, months, years, or `afterFyEnd` (31 Oct after the financial year).
- **Counting:** `direction`, `counting` and `monthEnd: 'clamp'`.
- **Non-business days:** `nonBusinessDay` with a named `calendar`. Use `locality` for the org's own calendar.
- **Applicability:** `conditions` on matter facts (`eq`, `in`, `exists`), and composite rules (`max` / `min` of other rules).
- **Output fields:** `dueTime`, `critical`, `reminders` and `createsTask` (with a `dedupeKey`).

**Published versions are immutable.** `data/rulesets/published.lock.json` holds a canonical hash of each published file, and CI fails if a published file changes. To change a rule, add a new version (`vic-v2.json`), lock it, and let the migration propose changes matter by matter.

## Calendars

`data/calendars/<calendarId>-<year>.json` covers 2025–2028:

- **Court calendars:** `VIC_SUPREME_COURT` and `VIC_COUNTY_COURT`. Melbourne holidays plus the Christmas–New Year registry closure.
- **Locality calendars:** `VIC_MELBOURNE`, and `VIC_GREATER_GEELONG`, where Geelong Cup Day replaces Melbourne Cup.

Court and statutory rules use the court calendar. Reminders use the org's locality calendar.

`data/calendars/official-vic-holidays.json` is the source list. `calendar.spec.ts` checks every calendar against it: same holidays, the Geelong substitution, closures on the court calendars only, and movable holidays on the right weekdays.

**Before the flag is turned on, a person must:**

1. Check the source list against the Victorian Government's published public holidays, including the AFL Grand Final Friday dates (marked `provisional` until gazetted).
2. Check the Greater Geelong substitution against the City of Greater Geelong's gazetted dates.
3. Check the closure dates against the Supreme and County Courts' published notices.
4. Set `verified: true` in the files they checked.

`pnpm materia-scripts seed` writes the calendars to `calendars/*` and the rule set to `ruleSets/vic/versions/1`.

## Tests

| Spec                      | What it covers                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `engine.spec.ts`          | Every branch of the engine. The core (`engine`, `calendar`, `model`) is held to 100% coverage.                              |
| `engine.property.spec.ts` | Properties: rolled-forward deadlines never land on a non-business day, and adding a holiday never makes a deadline earlier. |
| `golden/`                 | 48 scenarios with expected dates, and every trace in `__snapshots__/golden.spec.ts.snap` for practitioner review.           |
| `ruleset-lock.spec.ts`    | Published-version immutability.                                                                                             |

## Deadline lab

In a dev build, `/__dev/deadlines` lets practitioners enter a matter's events and see the computed deadlines and traces.
