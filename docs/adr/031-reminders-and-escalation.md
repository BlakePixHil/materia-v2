# ADR-031: Reminders run from one scheduled dispatcher and a stored next-reminder time

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [CORE-11](https://linear.app/materia-web/issue/MAT-44)

## Context

Deadlines carry reminder offsets (CORE-10). Nothing sent them yet, critical deadlines didn't escalate, and tasks had no due-date reminders. CORE-11 needs all of these, through the FND-20 pipeline. The constraints:

- reminders must fall at 08:00 org time on business days (the locality calendar);
- reminders must not be duplicated when a job retries or catches up;
- a deadline moved earlier must not resend what was sent;
- a scheduler that was down must catch up once;
- someone must notice when the job stops.

## Decision

We will denormalise each deadline's next reminder instant (`nextReminderAt`) and send everything from one 15-minute scheduled function, `reminders-dispatch`.

- **Pure schedule rules** in `libs/deadlines/src/lib/reminders.ts`:
  - offsets: the deadline's own, else 30/14/7/3/1 for critical deadlines and 7/1 for the rest;
  - each reminder's business day and 08:00 instant (`instantAt` lands on the wall-clock time across daylight saving);
  - the next reminder still ahead;
  - which due reminders to send now;
  - when a critical deadline escalates.
  Past the calendar data's years, only weekends are skipped, so a reminder is never lost to missing data.
- **Scheduling on write.** `deadlines-onWrite` sets `nextReminderAt` only when the date, criticality, offsets in force or status change. Reminders already due at that moment are not sent, which covers a new deadline and a date moved earlier. `reminders-onOrgWrite` reschedules an org's deadlines when its time zone or locality changes. Other edits leave the schedule alone, so a reminder the dispatcher hasn't reached yet isn't dropped.
- **Dispatch.** One query per org (`orgId`, `nextReminderAt <= now`). Each deadline is decided in a transaction that re-reads it:
  - due reminders since the stored `nextReminderAt` collapse into one ("Late reminder" when the scheduler was down or more than one is covered);
  - every covered offset gets `sentAt`;
  - `nextReminderAt` moves to the next unsent one.
  Notifications are written in the same transaction (`notify(..., {tx})`) and enqueued after it commits.
- **Escalation** is a second query: critical, upcoming deadlines due from today to a short horizon, filtered exactly in code. At 08:00 three business days out, an unacknowledged one notifies the responsible lawyer's supervisor and every owner and admin. The send records `escalatedAt`/`escalatedTo`, so it happens once per date. `escalatedTo` feeds the Today screen.
- **Acknowledgement** is a callable, `deadlines-acknowledge`, rather than a client write of `ackAt`. The data-access driver has no server-time sentinel for arbitrary fields, and the callable also audits.
- **Task reminders** are part of the same run, from 08:00 org time. The day is `taskReminderDays` (the assignee's preference, default 1) before the due date, on a business day. `reminderSentFor` on the task makes it once per due date.
- **Heartbeat.** Each run writes `heartbeats/reminders-dispatch` and logs `ok`. A log-based metric and an absence alert ("Reminders not running", Terraform) email the budget alert addresses after an hour without a run.

## Consequences

- Sending writes `reminders[]` with the defaults spelled out. Scheduling compares the offsets in force, so this is not a schedule change.
- `deadlines-flagMissed` moves to 00:15 Melbourne time. Every MVP org is Victorian; per-org local midnight waits for a non-Victorian org.
- Task reminders are calendar-day offsets rolled back to business days. They don't consider quiet hours, because 08:00 is outside the default ones.
- A deadline moved later keeps its sent marks: an offset already sent isn't sent again for the new date.
- Escalation and reminder notifications name the matter by number only in the title (the email subject), never its content (FND-20).

## Alternatives considered

- **One Cloud Task per reminder.** Exact timing, but every date change must find and cancel tasks, an org time zone change must re-enqueue everything, and there is no single place to see that reminders are running.
- **Query every upcoming deadline each run.** No denormalised field, but it reads the whole open deadline set every 15 minutes.
- **Escalate through a field on the reminder schedule.** It conflates two audiences and two acknowledgement rules; a separate query is cheap with the existing (orgId, status, critical, dueDate) index.
