# ADR-033: Org practice and billing settings change only through `orgs-updateSettings`

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [CORE-21](https://linear.app/materia-web/issue/MAT-66)

## Context

CORE-21 brings the org settings pages. Several settings have side effects or checks the client can't do on its own:

- a time zone or holiday locality change reschedules every deadline reminder, and the owner should see how many first;
- removing a jurisdiction that open matters still use must be refused, naming those matters;
- the first invoice number can't change once an invoice exists (the counter isn't client-readable);
- an org rename must reach every member's claims;
- every change must be audited as one semantic event.

Until now the org document's fields were client-writable for owners and admins.

## Decision

We will make the practice and billing fields of `orgs/{orgId}` server-owned and change them only through one callable, `orgs-updateSettings`.

- **Server-owned fields:** `name`, `abn`, `jurisdictions`, `primaryJurisdiction`, `timezone`, `holidayLocality`, `retentionYears`, `billing`. The rules generator drops them from the client update whitelist. `matterNumberFormat`, `matterTypeCodes` and `feeDefaults` stay client-writable for owners and admins (no side effects).
- **One callable, with a dry run.** `orgs-updateSettings` takes partial sections (`practice`, `billing`, `feeDefaults`, numbering, `nextInvoiceNumber`). With `dryRun: true` it returns the impact without writing: reminders to reschedule, matters blocking a jurisdiction removal, a GST change. The page dry-runs first and asks for confirmation when reminders will move.
- **Rescheduling stays in `reminders-onOrgWrite`.** The callable only counts what will move; the existing trigger does the moving, so there is still one code path for it.
- **Audit:** one `org.settings_updated` event with the changed fields.
- **Member rates, budgets and supervisor** stay client-direct updates under the `members.manage` rule, limited to those fields.
- **The team page stays readable by every member** (FND-17 relies on it). The other settings pages are owners and admins only.
- **Audit CSV export** is a separate callable, `audit-exportCsv`, for owners only, behind a recent sign-in (5 minutes), capped at 5,000 rows, with spreadsheet formulas neutralised.

## Consequences

- Old clients that wrote those org fields directly now get permission denied. There are none outside this app.
- A new settings section with side effects adds a section to `UpdateOrgSettingsInput` rather than a new callable.
- A new settings page adds a route under `settings` and an entry in `SETTINGS_SECTIONS` (`apps/web/src/app/features/settings/settings-nav.ts`).
