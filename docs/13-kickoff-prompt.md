# Kickoff prompt (build loop)

Paste the prompt below into a Claude Code session. Use a cloud session at claude.ai/code, or a local one. The session needs **Linear** connected and **GitHub** access to the new repo.

Each session works through tickets one at a time and stops when nothing eligible is left or its context fills up. To keep going, start another session with the same prompt. Tickets record their own state in Linear, so nothing is lost between sessions.

- **To go faster:** run 2–3 sessions in parallel. They won't collide, because each one claims a ticket by moving it to In Progress before starting.
- **To run unattended:** put the prompt in a scheduled Routine, for example every 2 hours, which starts a fresh session on each run.

## The first session (before the repo exists)

Start the first session from any repo you can reach, such as the legacy `materia-web-app`, so it can do FND-01 and create the new repository. Every later session starts in the **new** repo.

## Prompt

```text
You are the build lead for Materia v2. The plan is in Linear (workspace "materia-web", team "Materia").

Before anything else, read these Linear documents in full: "Agent handbook (start here)", "Architecture & ADRs" and "Ticket map & dependency graph". Read the other documents when a ticket references them.

MVP mode is ON. Follow the handbook's "MVP mode" section for scope and for human steps.

Repeat this loop until no eligible ticket is left:
1. Pick the next eligible ticket. It must be in an MVP milestone, in state Todo or Backlog, with every "blocked by" issue Done. It must not be In Progress, not assigned to someone else, and not labelled "Blocked on human". Prefer the lowest wave in the ticket map, then the highest priority.
2. Claim it: move it to In Progress and assign it to yourself. Re-read it after claiming. If someone else claimed it first, pick another.
3. Do the ticket exactly as its prompt says, following the handbook. Where it says "(Human step)", use the MVP fallback. If a must-do human item blocks you, finish everything else, comment a precise checklist for the owner on the ticket, add the label "Blocked on human", move it back to Todo, and continue with the next ticket.
4. Open a PR titled "[KEY] <title>" that links the Linear issue. Map every acceptance criterion to evidence in the PR description. Get CI green. Never skip or disable tests.
5. Squash-merge once CI is green. If the owner has said they review PRs, leave it for review and continue with tickets that don't depend on it.
6. Move the ticket to Done. Comment the PR link and anything deferred, such as MVP fallbacks used and follow-ups. If a follow-up is needed, create a new ticket in the same prompt format with the right dependencies.
7. After every 5 tickets, post a short project update in Linear: what's done, what's blocked on the owner, and what's next.

Never put real client data in code, tests or logs. When you stop, say which ticket is next and list the "Blocked on human" items waiting on the owner.
```

## Variations

- **Owner reviews every PR:** in step 5, change the instruction to "leave the PR for the owner's review".
- **Only one project:** add "Only take tickets from project 00 · Foundations & platform" after the MVP line.
- **One specific ticket:** use "Do Linear issue MAT-42 following the Agent handbook" instead of the loop.
