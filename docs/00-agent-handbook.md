# Agent handbook: start here

This handbook is for any agent, human or AI, picking up a Materia v2 ticket in Linear. Read it before you start a ticket.

## What we are building

Materia v2 is an AI-native practice tool for **Wills & Estates lawyers in Australia**, launching in Victoria (the first firm is in Melbourne and Geelong). It covers:

- matters (wills, POA and enduring guardianship, probate, letters of administration, estate administration, family provision claims, will disputes, testamentary trusts);
- deadlines computed from legal rules;
- tasks, documents and time and billing;
- litigation support for contested estates;
- **Clerk**, an assistant on Claude that proposes and never commits.

v2 replaces the legacy app, *materia* (repo `BlakePixHil/materia-web-app`, Firebase project `matt-r-1fe15`). One existing user will be migrated into v2.

## Reference documents (Linear → Materia team → Documents)

| Doc | Read it when |
|---|---|
| Agent handbook (this) | Always |
| Architecture & ADRs | Always. It holds the stack, the repo layout and the decisions you must not re-litigate |
| Domain model & Firestore schema | You touch data, rules, functions or the UI's data layer |
| Design system & UI conventions | You touch anything visual |
| Environments, CI/CD & release | You touch infra, deploys, secrets or the pipeline |
| Testing & quality strategy | Always. Every ticket ships tests |
| Edge-case register | Always. Check the section for your area |
| Roadmap & release phases | You need to know what's next or what's in scope |
| Ticket map & dependency graph | You want to know what's unblocked, which wave a ticket is in, or the critical path |
| Kickoff prompt (build loop) | You are the owner starting or resuming an agent build session |
| Deadline engine & legal rules (project 01) | Deadlines, rule sets, court dates |
| Clerk (AI) architecture & guardrails (project 03) | Anything AI |
| Legacy migration plan (project 07) | Migration tickets |
| Security, privacy & compliance (project 09) | Auth, rules, PII, retention, logging |

The same documents are mirrored in the repo under `docs/` (ticket FND-01 copies them in). **If the repo copy and Linear disagree, Linear wins.** Fix the repo copy in your PR.

## How tickets are written

Each ticket title starts with a stable key such as `[FND-04]`, `[CORE-10]` or `[AI-06]`, and the body is written as a prompt you can run as-is. Sections:

1. **Prompt**: what to do, in the second person.
2. **Context**: why it matters, and what exists already.
3. **Requirements**: what must be true when you are done.
4. **Implementation notes**: paths, libraries and patterns to follow.
5. **Data contracts**: schemas, collections and function signatures the ticket owns or consumes.
6. **Edge cases**: things you must handle *and test*.
7. **Acceptance criteria**: a checklist. A reviewer ticks every box.
8. **Tests**: the tests you must add.
9. **Out of scope**: do not do these. They belong to other tickets.
10. **Dependencies**: blocking tickets, which are also Linear "blocked by" relations.
11. **References**: design-system components and screens, docs and external links.

## Picking up a ticket

1. Check that every **blocked by** ticket is Done. If one isn't, stop and pick something else, unless the ticket says a stub is acceptable.
2. Move the ticket to **In Progress** and assign it to yourself or your agent identity.
3. Branch from `main` as `<key-lowercase>-<slug>`, for example `core-10-deadlines-feature`. Use Linear's branch name if one is offered.
4. Read the ticket's references. Then look at what already exists: grep the repo for the entities and components the ticket mentions. **Reuse before you build.**
5. If you must decide something not covered by the ticket or an ADR, add a short ADR in `docs/adr/` in the same PR and link it in a ticket comment.
6. Open a PR titled `[KEY] Title`, with a body that maps each acceptance criterion to evidence (a test name, a screenshot or a log line). The PR must link the Linear issue.
7. Keep CI green. Never skip, disable or `.only` a test to get green.
8. When it merges, move the ticket to **Done**. If you found follow-ups, create new tickets in the same format and link them as related. Don't widen your PR.

## MVP mode

The first goal is a working MVP for one Victorian firm, with that firm's legacy user migrated. When the kickoff prompt says **MVP mode is on**, these rules apply. The owner can change the scope by editing this section.

### MVP scope (milestones)

- **In scope:** M0.1, M0.2, M0.3 (Foundations); M1.1, M1.2 (Core); M2.1 (Time capture); M3.1, M3.2 (Clerk gateway and grounded Clerk).
- **Then, once that's done:** M7.1 and M7.2 (Legacy migration), M1.3, M2.2.
- **Out of scope:** everything else. Leave those tickets untouched.

### Human steps in MVP mode

When a ticket says **(Human step)**, use the MVP fallback below instead of waiting for a person. Record in the PR what you used, so the full step can be done later.

| Where | Full step | MVP fallback |
|---|---|---|
| FND-01 | Owner creates the repo and sets branch protection | Create the repo through GitHub if you have permission. Otherwise ask once (see "Must-do human items"). Branch protection: require CI only; agents may squash-merge their own PR once CI is green, unless the kickoff prompt says the owner reviews |
| FND-03 | Three projects (dev, staging, prod), org policies, budgets | **Two projects (dev and prod)**, with staging deferred. Terraform still applies, using the billing account and service account the owner provides. Skip the org-policy constraint |
| FND-05 | Staging deploys, then prod with approval | Merges to `main` deploy to **dev**; a `v*` tag deploys to prod. No approval gate unless the owner asks for one |
| FND-16 | Microsoft and Google SSO app registrations | **Email/password with TOTP MFA, plus Google sign-in** (Firebase-native). Microsoft SSO is deferred, unless the legacy user signs in with Microsoft, in which case it's a must-do item |
| FND-20 | Postmark sender domain and DNS | Firebase Auth's built-in emails for verification and reset. `MailPort` uses the console and in-app fake: invite links are shown to the inviter to copy and send. Postmark comes later |
| FND-21 | Alert channels (email or Slack) | Email the owner's address only |
| FND-22 | reCAPTCHA Enterprise key | Create it with gcloud or Terraform yourself. If you can't, ship App Check in monitor-only mode |
| AI-01 | Provider agreements and residency sign-off | Use the provider the owner has given credentials for. If there are none, build against the fake model, keep `clerk.enabled` off, and list it as a must-do item |
| CORE-12 | ClamAV scanning service | Build it (FND-24 infra). If that's blocked, use the fake scanner in dev only, never in prod |
| Practitioner review | A lawyer signs off on legal rules | **Build the feature and keep its flag off.** The owner turns flags on after they (or the firm's lawyer) check the rules in the Deadline lab |
| SEC-01 | Lawyer-reviewed privacy policy and terms | Placeholder `/legal/*` pages marked "Draft". This is acceptable only while the sole users are the owner's own firm |
| MIG-04 | Import the password hash with the legacy scrypt parameters | Skip the hash import. The migrated user signs in with Google, or through a password reset email; the transform maps legacy uid → new uid |
| Integrations, Xero, trust, pen test, launch | — | Out of MVP scope |

### Must-do human items, even for the MVP

These can't be faked. If one blocks you, do everything else in the ticket. Then comment on the ticket with an exact checklist of what the owner needs to do, add the label **Blocked on human**, and move on to the next eligible ticket.

1. A **GitHub repository**, or permission for the agent to create one.
2. A **Google Cloud billing account** and the ability to create projects. That means owner access, or a service account the owner creates with Project Creator and Billing User roles.
3. **AI provider access** if Clerk is in scope: an Anthropic API key in Secret Manager, or the Claude model enabled on Vertex AI in the project.
4. **Migration only:** read access to the legacy project `matt-r-1fe15`, and the owner's mapping decisions (MIG-01).

## Non-negotiables

- **Tenancy:** every document lives under `orgs/{orgId}/…`, except `users/{uid}` and global reference data. Every query is org-scoped, and every function checks the org claim.
- **No secrets in code or in Firestore.** Secrets go in Secret Manager, accessed through `defineSecret`.
- **Legal dates are `DateOnly` strings (`YYYY-MM-DD`) in the org timezone (default `Australia/Melbourne`).** Never a JS `Date` at midnight UTC.
- **Money is integer cents in AUD.** GST is computed with explicit rounding rules (see the Domain doc).
- **Time is integer minutes**, displayed as 6-minute units (0.1 h). Rounding is per org setting.
- **Clerk never writes domain data directly.** It creates `suggestions` that a human accepts.
- **Privileged material** (`privileged: true`) is never exported, emailed, or sent to an integration without an explicit human action, and it is never shown to read-only roles.
- **Accessibility:** WCAG 2.2 AA, keyboard-first, and every chart has a table view.
- **Australian data residency:** Firestore, Storage, Functions and Cloud Run run in `australia-southeast1`; backups go to `australia-southeast2`. AI processing follows the Clerk ADR.
- **No PII in logs.** Log ids, not names, emails or document text.
- **Rules encoding law carry the `Practitioner review` label.** The code must store the rule source citation and rule-set version alongside every computed deadline.

## Labels

- **Area:** `Infra`, `Frontend`, `Backend`, `AI`, `Data`, `Security`, `Design`.
- **Kind:** `Feature`, `Improvement`, `Bug`, `Spike`, `Chore`.
- **Flags:**
  - `Blocked on human`: an agent did everything it could and is waiting on a must-do human item. The checklist is in the ticket's latest comment.
  - `Needs human`: there is a step an agent cannot do, such as billing, org-admin access, credentials or a legal sign-off. The ticket names exactly which step. Do everything else and leave a checklist for the human.
  - `Practitioner review`: legal logic that needs lawyer sign-off before release. Ship it behind a feature flag until signed off.

## Definition of done (all tickets)

- [ ] The acceptance criteria are met, with evidence in the PR.
- [ ] Unit tests are added. Rules tests are added if rules changed, and e2e tests if a user flow changed.
- [ ] Lint, typecheck, tests, build and the bundle budget all pass in CI.
- [ ] No new axe violations, and it is keyboard operable.
- [ ] Docs are updated (`docs/`, plus the Linear doc if a contract changed).
- [ ] Feature-flagged if the work is incomplete for users or needs practitioner review.
- [ ] An audit-log entry is written for any new mutation of matter data.
