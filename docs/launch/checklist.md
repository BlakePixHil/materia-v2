# Launch checklist

What has to be true before the first practice works in prod, who owns each item, and the evidence (SEC-08, [MAT-118](https://linear.app/materia-web/issue/MAT-118)). The go/no-go meeting walks this page top to bottom; a line that isn't ✅ either gets done or is recorded as an accepted exception in [the go/no-go record](#gono-go-record). Keep the evidence column to links: a ticket, a run, a file.

**State on 8 October 2026.** ✅ done · ⏳ under way · ☐ not started · **Blake** marks a step only the owner can take (they're also on the Honey-Do list).

MVP mode has no staging environment: dev (`materia-v2-dev`) stands in for it wherever SEC-08 says staging ([deploy.md](../runbooks/deploy.md)).

## Readiness

| # | Item | Owner | State | Evidence |
| --- | --- | --- | --- | --- |
| 1 | All M9.1 "Baseline controls" tickets Done: SEC-01 to SEC-05 | agents | ✅ | [MAT-111](https://linear.app/materia-web/issue/MAT-111), [MAT-112](https://linear.app/materia-web/issue/MAT-112), [MAT-113](https://linear.app/materia-web/issue/MAT-113), [MAT-114](https://linear.app/materia-web/issue/MAT-114), [MAT-115](https://linear.app/materia-web/issue/MAT-115) |
| 2 | External pentest: every critical and high finding fixed and retested | Blake | ✅ Confirmed by Blake on 2026-10-08 with the SEC-02a sign-off. The vendor's report isn't in the repo; findings he passes on become `[SEC-PT-n]` tickets | [SEC-02a MAT-170](https://linear.app/materia-web/issue/MAT-170), [MAT-118 comment](https://linear.app/materia-web/issue/MAT-118), scope in [pentest-plan.md](../security/pentest-plan.md) |
| 3 | Accessibility audit (WCAG 2.2 AA) passed | agents, Blake | ✅ No automated violations; every critical, serious and moderate finding fixed; screen reader checks signed off on 2026-10-08 (SEC-06a); follow-ups done (SEC-06b) | [audit-2026-10-07.md](../accessibility/audit-2026-10-07.md), [MAT-173](https://linear.app/materia-web/issue/MAT-173), [MAT-174](https://linear.app/materia-web/issue/MAT-174), statement at `/legal/accessibility` |
| 4 | Performance budgets met | agents | ⏳ Reads, INP and CLS met on every screen and the hot callables met at 10× peak. LCP on a mid-tier phone is held at measured ceilings on the emulators: re-measure it on the prod CDN after the release. Numbering, invoicing, search and the note fan-out are watched in prod instead of load-tested (MAT-181 descoped) | [perf-report-2026-10.md](../ops/perf-report-2026-10.md), [ADR-061](../adr/061-performance-budgets.md) |
| 5 | Backups verified by a restore | agents | ✅ on dev: restore drills from a managed backup, an export and PITR, all counts matching, on 2026-10-07. Prod: run `backup-status` a week after the release (7 nightly exports) and the first quarterly drill | [restore.md, Drill](../runbooks/restore.md#drill), runs [37541934598](https://github.com/BlakePixHil/materia-v2/actions/runs/37541934598), [37552119233](https://github.com/BlakePixHil/materia-v2/actions/runs/37552119233), [37553458893](https://github.com/BlakePixHil/materia-v2/actions/runs/37553458893) |
| 6 | A practitioner's sign-off for every flag switched on in prod | Blake | ✅ All 11 signed off on 2026-10-08, and Blake chose to switch them all on at the first release. Costs disclosure (BILL-06a) is signed off too but waits on Tristan's imported matters | [deploy.md, step 7](../runbooks/deploy.md#releasing-to-prod) |
| 7 | Legal documents published | Blake, agents | ⏳ All seven are final (version 1.0, effective 8 October 2026, PR [#329](https://github.com/BlakePixHil/materia-v2/pull/329)), and every prod owner accepts the terms once. **Blake:** the square-bracket placeholders (operator name, ABN, address, privacy, support and accessibility contacts, the accessibility reply time, terms 1.3, 9.1 and 13.2) before the release PR merges | [docs/compliance](../compliance/), `/legal` |
| 8 | The first user's migration completed (MIG-07) | agents, Blake, Tristan | ⏳ Rehearsal 1 passed on 2026-10-07. Next: Tristan's review on dev, rehearsal 2, then the prod cutover after the release | [migration-cutover.md](../runbooks/migration-cutover.md), [MAT-101](https://linear.app/materia-web/issue/MAT-101) |
| 9 | Monitoring and alerts green for 7 days (on dev) | agents | ☐ At go/no-go, record the 7 days: no open alert in Monitoring, both uptime checks passing, and a test alert delivered (`gcloud logging write materia-alert-test "test alert" --project materia-v2-dev`) | [incident-response.md](../runbooks/incident-response.md), Ops overview (dev) dashboard |

## Launch arrangements

| # | Item | Owner | State | Evidence |
| --- | --- | --- | --- | --- |
| 10 | Production domain: chosen (legacy uses the current app domain, so agree it with MIG-10), DNS records for Firebase Hosting, SSL issued | Blake | ☐ | [infra/MANUAL.md](../../infra/MANUAL.md) steps 5 and 7 |
| 11 | After the domain: `auth_authorized_domains` in `envs/prod.tfvars`, the redirect URIs for Xero and the Claude connector, the HSTS header on the custom domain (docs/09) and the HSTS preload submission | agents; preload: Blake | ☐ | |
| 12 | Email: the sending domain verified in Resend and the prod key and webhook set (FND-20) | Blake | ☐ | [infra/MANUAL.md](../../infra/MANUAL.md), Resend steps 2–9 |
| 13 | Runbooks complete | agents | ✅ deploy, rollback, restore, incident response, data breach, rotate secret, disable Clerk, migration cutover, Xero outage. Microsoft and calendar sync aren't built (INT-01b, INT-02): their runbooks come with them | [runbooks/](../runbooks/), [runbook dry-runs](#runbook-dry-runs) |
| 14 | Each runbook dry-run once, and signed off | agents, Blake | ⏳ | [Runbook dry-runs](#runbook-dry-runs) |
| 15 | On-call: who the alerts reach, the escalation path, business hours and after hours | Blake | ⏳ Today Blake is on call through the alert emails (`TF_VAR_budget_alert_emails`). To decide: after-hours expectations and a second person | [incident-response.md, Who to call](../runbooks/incident-response.md#who-to-call) |
| 16 | Support: in-app Help & feedback that stores the message and emails support | agents | ⏳ SEC-08 | |
| 17 | Support: a support mailbox and response targets | Blake | ☐ Then set the support address for the functions and fill the support contact in `docs/compliance` | |
| 18 | Status page: a hosted status page, linked from the app's help menu | Blake chooses the vendor; agents add the link | ☐ | |
| 19 | Prod flags: step 7 of the deploy runbook, plus a decision for every other flag dev has on (Clerk and its features, Xero, the guided tour) | Blake | ⏳ The signed-off flags are decided; the others aren't | [deploy.md, step 7](../runbooks/deploy.md#releasing-to-prod), `pnpm materia-scripts flags-report` |
| 20 | The release itself: release PR [#27](https://github.com/BlakePixHil/materia-v2/pull/27) merged and promoted to prod | Blake | ☐ | [deploy.md, Releasing to prod](../runbooks/deploy.md#releasing-to-prod) |

## Runbook dry-runs

A dry run follows the runbook on dev, or as a walk-through where acting it out would cause the problem it handles. Record the date, who ran it and what changed in the runbook.

| Runbook | How to dry-run it | State | Evidence |
| --- | --- | --- | --- |
| [deploy](../runbooks/deploy.md) | Every dev deploy runs it | ✅ | Actions → `deploy-dev` |
| [rollback](../runbooks/rollback.md) | Hosting-only rollback on dev, then redeploy `main` | ☐ | |
| [restore](../runbooks/restore.md) | The `backup-drill` workflow | ✅ 2026-10-07 | [Drill table](../runbooks/restore.md#drill) |
| [incident response](../runbooks/incident-response.md) | Fire the test alert, then walk an uptime failure through to a status note | ☐ | |
| [data breach](../runbooks/data-breach.md) | A walk-through with Blake of the 30-day assessment and the notification templates | ☐ | |
| [rotate secret](../runbooks/rotate-secret.md) | Rotate `demo-login-password` on dev; then `RESEND_API_KEY` once Resend is set up | ☐ | |
| [disable Clerk](../runbooks/disable-clerk.md) | Switch one Clerk feature off and on again for the demo practice on dev, in Settings → Clerk and AI | ☐ | |
| [migration cutover](../runbooks/migration-cutover.md) | MIG-07's rehearsals | ✅ rehearsal 1, 2026-10-07 | [MAT-101](https://linear.app/materia-web/issue/MAT-101) |
| [Xero outage](../runbooks/integrations.md#when-xero-is-down) | A walk-through: an invoice that ends `unavailable`, then "Try again" | ☐ | |
| Microsoft 365 outage, calendar sync replay | Not built yet (INT-01b, INT-02) | n/a | |

## Go/no-go record

Hold the meeting once every line above is ✅ or has a proposed exception. Record:

- **Date and who was there.**
- **Each open line**, and whether it's accepted as an exception, with the reason and the ticket that closes it.
- **The decision:** go or no-go. For a go: the release version, the launch date, who is on call for the first two weeks, and the rollback plan ([rollback.md](../runbooks/rollback.md)).

_Not held yet._

## Launch day

1. Merge the release PR and promote it to prod: [deploy.md, Releasing to prod](../runbooks/deploy.md#releasing-to-prod), steps 1–7, including the backfills and the prod flags.
2. Check `/health` on the prod domain, sign in, and run the smoke checklist with the first firm at its cutover ([migration-cutover.md, T0](../runbooks/migration-cutover.md#t0), step 10).
3. Watch the Ops overview (prod) dashboard and Error Reporting through the first working day.
4. Add the launch date and version here.

## Post-launch review

Two weeks after launch, review and record here:

- **Errors:** Error Reporting's top errors by count, server and web.
- **Performance:** field data from Performance Monitoring (75th percentile LCP, INP and CLS on mobile against the budgets), callable p95 for invoicing, search and the note fan-out, and the numbering transactions' `attempts` logs ([perf-report-2026-10.md](../ops/perf-report-2026-10.md)).
- **Clerk cost:** each firm's `metrics/clerk-YYYY-MM` against its spend limit, and the Clerk reply queue's waits ([incident-response.md](../runbooks/incident-response.md#capacity-the-clerk-reply-queue)).
- **People's feedback:** what came in through Help & feedback, and what the first firm says.
- **Incidents** and how the runbooks held up.

Create a Linear ticket for each follow-up and list them here.

_Not held yet._
