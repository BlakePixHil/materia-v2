# ADR-026: Counting open tasks with a per-task marker, and task access through the collection group

- **Status:** Accepted
- **Date:** 2026-10-04
- **Ticket:** [CORE-08](https://linear.app/materia-web/issue/MAT-36)

## Context

CORE-08 lets clients create, edit and soft delete tasks directly, and keeps the matter's denormalised `openTaskCount` in a trigger that must stay correct under concurrent edits. Triggers have no retries here (`defineTrigger`), events can arrive out of order, and template tasks (CORE-07) are already counted by the callable that creates them. Separately, "matter tasks follow matter access" and "personal tasks are private, even from admins" have to hold for direct reads and for the `tasks` collection group that My tasks queries.

## Decision

We will count tasks with a server-owned marker on each task, `countedOpen`, rather than with deltas from each event's before and after. `tasks-onWrite` runs one transaction on the task: it reads the task's current state, compares "open" (live and `todo`, `in_progress` or `blocked`) with `countedOpen`, writes the marker and adds ±1 to `openTaskCount` with a server increment when they differ. Client creates must write `countedOpen: false` (the rules require it); server writers that count a task themselves write `true`. A task without the field predates CORE-08 and counts as it stood before the event.

We will check matter access for task reads and writes at the task path (`get()` of the matter: privileged matters need `privileged.view`, writes need a live matter and `task.edit`). Because the collection-group rule also matches single-task reads and can't `get()` each task's matter in a query, through the group a member reads only the tasks assigned to them, and roles with `privileged.view` read all matter tasks. Personal tasks carry `matterId: null` and are always assigned to their owner, so the group never shows them to anyone else.

## Consequences

- The count converges whatever the order of events: a redelivered, late or concurrent event re-reads the task and plans nothing once the marker agrees. Transactions lock only the task, not the matter, so a 500-task bulk update doesn't contend on one document.
- The trigger writes back to the task once per change of open state or completion (`countedOpen`, `completedAt`); its next run is a no-op. The audit treats both fields as noise.
- Paralegals and read-only members can't list every task in the org through the group (they list a matter's tasks at its path, and their own across matters). A future org-wide task report for those roles needs a denormalised `privileged` flag on tasks.
- Tasks written before CORE-08 whose open state changed without a trigger (CORE-07 had none) may leave a matter's count off by the difference; the seed and template writers now set the marker, and a one-off recount can fix existing dev data.

## Alternatives considered

- **Before/after deltas per event:** wrong when events are redelivered or handled out of order, and needs a guard per event that still can't see later writes.
- **Recounting with an aggregation query on every write:** exact, but needs `deletedAt: null` stored on every task and a read of every task index entry per write; it also races between the count and the write unless the matter is locked.
- **Denormalising `privileged` onto tasks:** would let the group rule check privilege per task, but every privilege change on a matter would rewrite its tasks. Not needed for My tasks.
