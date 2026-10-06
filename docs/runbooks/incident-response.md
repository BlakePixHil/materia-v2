# Incident response

What to do when an alert fires or something is broken (FND-21). Materia is a single-practice app run by one owner, so this is deliberately short: one person is on call, and that person is the owner.

## Where to look

| What | Where |
| --- | --- |
| Ops overview dashboard | Cloud console → Monitoring → Dashboards → **Ops overview (dev)** / **Ops overview (prod)**. Terraform output `ops_dashboard_url` has the direct link (`terraform -chdir=infra/terraform output ops_dashboard_url`). |
| Errors (server and web) | Cloud console → Error Reporting, in the environment's project. Web errors have service `web` and version `<version>+<sha>`. |
| Logs | Cloud console → Logging. Every function line carries `fn` (and `requestId` for callables); filter `jsonPayload.fn="matters-createMatter"`. |
| Uptime | Monitoring → Uptime checks: **Hosting /health** and **system-ping callable**. |
| Deploys | GitHub Actions → `deploy-dev` / `deploy-prod`. Rollback: [rollback.md](rollback.md). |

## Severity levels

| Level | Meaning | Examples | Response |
| --- | --- | --- | --- |
| **SEV-1** | Practice can't work, or data may be exposed or lost | Site down, sign-in broken, a document visible to the wrong person, data deleted | Drop everything. Roll back first, investigate second. Start the NDB assessment if personal information may be involved. |
| **SEV-2** | A feature is broken or a deadline/reminder may be missed | Reminders not running, callable errors over 2%, uploads failing | Same day. Fix forward or roll back. Check whether any deadline reminder was missed and tell the lawyer. |
| **SEV-3** | Degraded or cost risk, nobody blocked | Slow callables, a Firestore cost spike, Clerk budget at 80% | Next working day. |

## Who to call

- **On call:** the owner (Blake), by the alert email. Alerts go to the budget alert addresses (`TF_VAR_budget_alert_emails`).
- **Google Cloud / Firebase outage:** check https://status.cloud.google.com and https://status.firebase.google.com. Nothing to fix on our side; post a status note (below).
- **Model provider (Clerk):** Clerk degrades to "Clerk is unavailable"; nothing else depends on it. Check the provider's status page.
- **Privacy:** the practice's privacy officer, for any SEV-1 involving personal information (see NDB below).

## Alerts and first steps

| Alert | Severity | First steps |
| --- | --- | --- |
| Callable errors over 2% | SEV-2 | Error Reporting for the top error. The dashboard shows which function. If it started with a deploy, roll back hosting and functions ([rollback.md](rollback.md)). |
| Callable p95 latency over 3 s | SEV-3 | Dashboard: latency by function, Firestore reads, Cloud Run instances (cold starts after a deploy settle within minutes). |
| Uptime check failing | SEV-1 | Open `https://<project>.web.app/health`. Down from 2+ regions is real. Check the last deploy and Google status. |
| Firestore reads/writes over 3× the 24-hour baseline | SEV-3 | Cost guard. Usually a listener loop in the web app or a trigger writing to what it listens to. Dashboard: invocations by service. |
| Clerk monthly budget at 80% | SEV-3 | Usage is in `orgs/{orgId}/metrics/clerk-YYYY-MM`. Raise the org's `monthlyTokenBudget` or let it stop at 100% (`CLERK_BUDGET_EXCEEDED`). |
| Scheduled job not running / Reminders not running | SEV-2 | Cloud Scheduler (job paused?) and the function's logs. Every scheduled function is watched (the list is `scheduled_jobs` in the monitoring module). A paused daily or monthly job (deadlines-flagMissed, matters-queueDestruction) does not alert; only one that runs and fails does. Reminders catch up by themselves once the job runs again. |
| Trigger dead-lettered an event | SEV-2 | The `fn` label names the trigger. For `audit-…` a change is missing from the audit log: the dead-letter log entry has the document path and the stack (Error Reporting too). Fix the cause, then replay the write or record the entry. |
| Deadline calendar data missing | SEV-2 | The log lists the `calendars` and `ruleIds`. Add that year's calendar data to `libs/deadlines` (docs/06-deadline-engine.md) and deploy; the next recompute unblocks the deadlines. |
| Test alert | none | A delivery test. Nothing is wrong. |

## Decoding a web stack trace

Web errors arrive minified. Each release's sourcemaps are uploaded privately (never served) to `gs://<project>-sourcemaps/web/<sha>/` by the deploy. To decode:

```sh
# The sha is the part after "+" in the error's version (Error Reporting → the error → version).
gcloud storage cp "gs://materia-v2-prod-sourcemaps/web/<sha>/*" /tmp/maps/
# Paste the stack from Error Reporting into stack.txt, then:
pnpm materia-scripts decode-stack --maps /tmp/maps --file stack.txt
```

Each `chunk-….js:line:col` frame becomes `at <function> (apps/web/src/…ts:line:col)`. Maps are kept for 180 days.

Client errors are scrubbed in the browser and again on the server (emails, phone numbers, long digit runs and quoted text removed; messages cut to 500 characters), so a report never contains a client's details. If one ever does, treat it as a SEV-2 privacy bug: fix the scrubber (`libs/domain/src/lib/client-errors.ts`) and delete the log entries.

## Communication templates

Keep messages short and factual. Never include client names or matter details.

**Investigating (to staff):**

> Materia is having problems with _[what: signing in / saving documents / reminders]_ since _[time]_. We're looking into it. Please don't retry _[action]_ for now; nothing you've already saved is lost. Next update by _[time]_.

**Resolved (to staff):**

> Materia is working normally again as of _[time]_. The problem was _[one line]_. _[If relevant: Reminders due between X and Y were sent late; please check deadlines due today.]_

**Post-incident note (in the incident ticket):** what happened, when it started and ended, who was affected, root cause, what we changed, and follow-up tickets.

## NDB assessment trigger (privacy)

Under the Privacy Act's Notifiable Data Breaches scheme, an **eligible data breach** (unauthorised access to or disclosure of personal information likely to result in serious harm) must be assessed within 30 days and notified to the OAIC and affected individuals as soon as practicable.

Start an assessment **immediately** when any of these happen:

- a privileged or client document was readable by someone outside its organisation or role (rules failure, signed URL leaked);
- personal information appeared in logs, Error Reporting or an email it shouldn't have;
- credentials, tokens or keys were exposed (rotate them first: Secret Manager, then redeploy);
- a backup or export was accessible publicly.

Steps: contain (roll back, revoke, rotate), preserve evidence (export the relevant logs to the backups bucket), record what data and which people may be affected, then follow the practice's NDB response plan (SEC-01, MAT-111) and the [Security, privacy & compliance](../09-security-privacy-compliance.md) doc. The privacy officer decides whether it's notifiable.

## Testing the alert path

Once a month (and after changing notification channels), fire the test alert and check the email arrives:

```sh
gcloud logging write materia-alert-test "test alert" --project materia-v2-prod
```

The "Test alert" incident opens within a minute and closes itself after 30 minutes.
