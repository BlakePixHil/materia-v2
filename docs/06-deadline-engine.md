# Deadline engine & legal rules

> ⚠️ **Every legal rule on this page is illustrative until a practising Victorian Wills & Estates lawyer signs it off.** Tickets that encode rules carry the `Practitioner review` label, and those rules ship behind the `deadlines.ruleset.<id>` flag until sign-off. The engine records the citation and rule-set version on every computed deadline, so if a rule turns out to be wrong we can find every deadline it produced.

## Design

The engine lives in `libs/deadlines`. It is pure TypeScript and deterministic, so it runs identically in the browser (previews), in functions (persisted computation) and in tools (migration).

```ts
compute(input: {
  matter: { type: MatterType; jurisdiction: Jurisdiction; facts: Record<string, unknown> };
  events: MatterEvent[];            // anchor facts with DateOnly dates
  ruleSet: RuleSetVersion;          // immutable data
  calendar: JurisdictionCalendar;   // holidays + registry closures for relevant years
  today: DateOnly;                  // injected clock
}): ComputedDeadline[]              // each with trace[]
```

### Rule shape (data, stored in `ruleSets/{id}/versions/{v}`)

```ts
{
  id: 'vic.fp.limitation',
  title: 'Family provision claim limitation',
  citation: 'Administration and Probate Act 1958 (Vic) s 99',
  appliesTo: { matterTypes: ['probate','loa','admin','fp','contest'], jurisdictions: ['VIC'] },
  anchor: { event: 'grant_issued' },         // Victoria: runs from the grant, not from death
  offset: { months: 6 },                     // or { days }, { businessDays }, { years }
  direction: 'after',                        // 'before' for "at least N days before X"
  counting: 'exclude_anchor_day',            // court-rules style: the day of the event is not counted
  monthEnd: 'clamp',                         // 31 Jan + 1 month = 28/29 Feb
  nonBusinessDay: 'roll_forward',            // 'roll_forward' | 'roll_back' | 'none'
  calendar: 'VIC_SUPREME_COURT',              // court calendar, not the firm's local one
  kind: 'statutory', critical: true,
  conditions?: [{ fact: 'estate.hasNotionalEstateRisk', eq: true }],
  reminders: [30, 14, 7, 3, 1],
  createsTask?: { title: 'Advise beneficiaries re FP window', stage: 'administration' },
  explain: 'Claims must be made within 6 months after the grant unless the court extends time.'
}
```

### Calendar data (`calendars/{calendarId}-{year}`)

There are two kinds of calendar, and rules must say which one they use.

- **Court calendars**, e.g. `VIC_SUPREME_COURT` and `VIC_COUNTY_COURT`.
  - Victorian public holidays as observed in Melbourne, plus the court and registry closures (including the Christmas–New Year closure).
  - Court and statutory deadlines use these.
- **Firm locality calendars**, e.g. `VIC_GREATER_GEELONG`.
  - Victorian holidays with **municipal substitutions**. In Greater Geelong, Melbourne Cup Day (first Tuesday in November) is usually replaced by Geelong Cup Day (the Wednesday before it).
  - Internal reminders and "business day" UX use the org's locality calendar (`org.holidayLocality`).
  - So a Geelong firm works on Melbourne Cup Day while the Melbourne court registry is closed. Rules must use the court calendar.
- Other Victorian specifics: the AFL Grand Final Friday public holiday, and King's Birthday on the second Monday in June.
- Daylight saving dates for `Australia/Melbourne` are informational only; `DateOnly` arithmetic is unaffected.
- The data is loaded by a yearly ops ticket and a scheduled check. If next year's calendar is missing on 1 October, the job alerts. Municipal substitutions are gazetted each year, so they need checking annually.

### The trace (explainability)

Every computed deadline carries a trace like this:

```
anchor grant_issued = 2026-03-14 (event ev_12, entered by AB on 2026-03-20)
+ 6 months → 2026-09-14 (Monday)
business day on VIC_SUPREME_COURT → no roll
rule vic.fp.limitation v3 · Administration and Probate Act 1958 (Vic) s 99
```

The UI shows it in the DeadlineChip tooltip and in the deadline detail. Clerk can cite it.

## Initial Victorian rule set (illustrative — practitioner review)

Victoria is the first jurisdiction (the launch firm is in Melbourne and Geelong). Every row needs verification against the current Act, Rules and Practice Notes before its flag is turned on. Rows marked "verify" are especially uncertain.

| Rule id | What | Anchor → offset | Citation (to verify) |
|---|---|---|---|
| `vic.probate.advert_min` | Advertise the intention to apply for a grant (Supreme Court online advertisement) at least 14 days before filing | `notice_published` + 14 days (earliest filing date) | Supreme Court (Administration and Probate) Rules 2014 |
| `vic.probate.prompt_filing` | Practice reminder when no application has been filed N months after death (org setting, default 6) | `date_of_death` + N months | practice; verify any rule-based delay explanation requirement |
| `vic.caveat.expiry` | A caveat against a grant lapses (verify the period and the renewal mechanism) | `caveat_lodged` + period | Supreme Court (Administration and Probate) Rules 2014 (verify) |
| `vic.fp.limitation` | Family provision claim window | **`grant_issued` + 6 months** | Administration and Probate Act 1958 (Vic) s 99 |
| `vic.distribution.s99a` | Earliest distribution protected against family provision claims (no notice of a claim received) | `grant_issued` + 6 months | Administration and Probate Act 1958 (Vic) s 99A |
| `vic.distribution.s33_notice` | Earliest distribution after the statutory notice to creditors and claimants expires | `statutory_notice_published` + notice period (verify; commonly 60 days) | Administration and Probate Act 1958 (Vic) s 33 |
| `vic.distribution.earliest` | Composite: the later of the two rules above | max(`vic.distribution.s99a`, `vic.distribution.s33_notice`) | — |
| `au.cgt.main_residence` | 2-year main residence CGT window for a deceased estate | `date_of_death` + 2 years | ITAA 1997 s 118-195 |
| `au.tax.final_return` | Date-of-death final individual return (reminder) | 31 Oct after the FY of death (agent extension flag) | ATO |
| `vic.offer.o26_expiry` | Offer of compromise expiry | `offer_served` + offer period (verify the minimum, e.g. 14 days) | Supreme Court (General Civil Procedure) Rules 2015 (Vic) O 26; County Court equivalent |
| `vic.order.compliance` | Comply with order "within N days" | `order_made` + N days, from the order's text | the order |
| `org.executor_year` | Executor's year (practice reminder, not statutory) | `date_of_death` + 12 months | practice |

**Differences from NSW that the engine and UI must not assume away** (useful when NSW is added later):
- In Victoria the family provision window runs from the **grant**. Before a grant there is no computed limitation date: the deadline is `blocked` with "No grant yet".
- Victoria has **no notional estate** regime. Assets passing outside the estate (superannuation, joint tenancy) can't be brought back for a family provision claim. The estate register (CORE-16) still records them.
- Formal validity and dispensing: Wills Act 1997 (Vic) s 7 and s 9. In NSW these are the Succession Act s 6 and s 8.

## Recompute semantics

1. Editing an anchor event recomputes every deadline anchored to it, in the `deadlines-recompute` callable.
2. If a deadline's date changes and the deadline is `upcoming`, the system creates a **change proposal**. Nothing is overwritten. The responsible lawyer confirms each change. A critical deadline needs a typed confirmation.
3. `override` always wins, but the engine keeps computing in the background. If the computed date moves to *earlier* than the override, it flags the deadline.
4. A rule-set version bump never changes existing deadlines automatically. A migration job proposes the changes, matter by matter.
5. Deleting an anchor event marks its dependent deadlines `superseded`, after confirmation.

## Edge cases the engine must test

- **Month ends:** 31 Jan + 1 month; 29 Feb (leap) + 12 months; 30 Aug + 6 months.
- **Rolling:** an anchor on a public holiday; a deadline landing on a holiday; consecutive holidays (Christmas, Boxing Day, a weekend).
- **The court Christmas–New Year closure** spanning a deadline.
- **Municipal holiday substitution:** a Geelong firm's locality calendar has Geelong Cup Day and not Melbourne Cup Day. Court deadlines must use the court calendar, and reminders the locality calendar.
- **No grant yet:** `vic.fp.limitation` and `vic.distribution.s99a` are `blocked` until `grant_issued` exists. A grant date entered later triggers the recompute proposals.
- **Daylight saving:** events entered at 00:30 on the October DST change. `DateOnly` arithmetic must be unaffected.
- **Missing facts:** an unknown date of death (the deadline is `blocked` with a reason, not computed from today); a date of death in the future (validation error); an approximate date of death (`datePrecision != 'day'`, so compute the earliest possible date and flag it).
- **Jurisdiction:** the deceased is domiciled outside Victoria with Victorian assets (reseal of a foreign or interstate grant), where the rule applicability and the grant date anchor differ.
- **Two rules producing the same task:** de-duplicate by `dedupeKey`.
- **Time-of-day:** a deadline "by 4pm" (`dueTime`); registry hours.
- **Calendar data:** a year with no calendar data must fail loudly, never silently treat holidays as business days.
- **Retroactive entry:** a deadline already in the past on entry (a legacy migration, or a late-instructed matter) is created as `missed?` and goes to a review queue, not marked missed.
