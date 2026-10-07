# Security, privacy & compliance

> This page is engineering guidance, not legal advice. Items marked **(sign-off)** need a lawyer or privacy professional before launch.

## Data we hold

Client personal information is often sensitive: health information in capacity disputes, family relationships, financial details, and identity documents such as death certificates and driver licences. Legal professional privilege attaches to much of it. We treat **all matter data as confidential and potentially privileged**.

## Obligations to design for

- **Privacy Act 1988 (Cth), Australian Privacy Principles.** Collection notices, use limitation, cross-border disclosure (APP 8: keep processing in Australia, or document the sub-processor), security (APP 11), access and correction (APP 12, 13). Notifiable Data Breaches scheme: an assessment within 30 days, and notification. **(sign-off)**
- **Legal Profession Uniform Law, as applied in Victoria, and its Rules.** The regulator is the Victorian Legal Services Board and Commissioner.
  - Confidentiality.
  - Costs disclosure (Part 4.3).
  - File retention: the firm's policy, commonly 7 years after closure. Original wills are held indefinitely in safe custody. Materia (CORE-19) dates each closed matter for destruction `retentionYears` after closing (default 7) and never dates a will or POA with originals in custody, a matter involving a minor, or one under legal hold. Nothing is destroyed without an admin approving it, and the `matters.destruction` flag stays off in production until a practitioner signs off the periods (CORE-19a).
  - Trust money: out of scope for v1. Materia never keeps trust records; it may only show a labelled balance snapshot ([ADR-035](adr/035-trust-accounting.md)).
  - **(sign-off)**
- **Privilege.** Privilege is never waived by the system: no automatic sharing, and privileged flags carry through exports, AI outputs and emails.
- **Data residency.** Primary data stays in `australia-southeast1`, backups in `australia-southeast2`. AI processing follows ADR-011a. Sub-processors are listed in the [sub-processor list](compliance/subprocessors.md), which the privacy policy links to.

## Controls

**Identity**
- Identity Platform. Password policy: minimum 12 characters, breached-password check through the Identity Platform password policy.
- TOTP MFA, enforceable per org. SSO with Microsoft Entra and Google.
- Session revocation on member removal or role downgrade.
- Re-authentication within 5 minutes is required for exports, deletes, role changes and integration connects, including connecting Claude and changing the practice's Claude connector settings.

**Authorisation**
- Custom claims `{orgId, role}`.
- Firestore and Storage rules are default-deny, with tests for every role and a cross-org test.
- Callables re-check the role server-side.

**App Check**
- reCAPTCHA Enterprise. Enforced on Firestore, Storage, Functions and Vertex.
- Tokens last 12 hours, set in the Firebase console (`infra/MANUAL.md`, [ADR-056](adr/056-startup-loads-in-parallel.md)).
- Debug tokens are allowed only in dev.

**Transport and storage encryption**
- TLS everywhere, with HSTS preload on the custom domain.
- Google-managed encryption at rest. CMEK is used for the migration bucket and the token KMS key.

**Secrets**
- Secret Manager, with rotation runbooks.
- OAuth refresh tokens are encrypted with Cloud KMS. Clients have no read path to them.

**Hosting headers (FND-22)** (`firebase.json` → `hosting.headers`)
- An enforced CSP: `default-src 'self'`; Firebase and Google endpoints allow-listed (`*.googleapis.com`, `*.cloudfunctions.net`, `*.run.app`, reCAPTCHA, `apis.google.com` and the `<project>.firebaseapp.com` auth iframe for the sign-in popup). `object-src 'none'`, `frame-ancestors 'none'`, `base-uri` and `form-action 'self'`.
- Inline scripts only by hash: the theme boot script and Angular's critical-CSS (Beasties) loader, both recorded in `apps/web/csp-hashes.json`. `materia-scripts csp check` fails a build whose `index.html` has any other inline script or an inline event handler; CI, previews and releases run it.
- Allowed loosenings: `style-src 'unsafe-inline'` (Angular injects component styles; a static host can't nonce them), `'wasm-unsafe-eval'` (PDF.js image decoders) and `worker-src blob:`.
- e2e runs against the Hosting emulator under the same policy plus `http://127.0.0.1:*` (`materia-scripts csp emulator-config`), so a change that the policy breaks fails CI.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), microphone=(self), geolocation=()`, `Cross-Origin-Opener-Policy: same-origin-allow-popups` (the Google sign-in popup).
- Caching: `no-cache` by default (so `index.html` is always fresh), hashed root bundles `immutable` for a year, fonts and PDF.js assets one day.
- HSTS: `*.web.app` is already HSTS-preloaded; add the header when a custom domain is set up.

**Uploads**
- Content-type and extension allow-list. Size limits of 50 MB for documents and 25 MB per migrated legacy file.
- Malware scanning (MalwareScanPort: Cloud Run ClamAV, or a GCP-native option). A file is unreadable to anyone but the uploader until it is scanned clean.
- Office macros are flagged.

**Logging**
- No PII or document text in logs. Log ids only.
- Client error reports are scrubbed (emails, phone numbers, names in URLs).
- Audit log for every mutation, retained 7 years.

**Authentication (FND-16)** (`apps/web/src/app/core/auth/`, `apps/functions/src/auth/`)
- **Methods:** Identity Platform with email and password (minimum 12 characters, email-enumeration protection) and Google sign-in. Microsoft is deferred (infra/MANUAL.md).
- **MFA:** TOTP authenticator apps; each org can require them (SEC-04, below).
- **Recovery codes:** ten single-use codes from `auth-generateRecoveryCodes`, which needs a sign-in in the last five minutes. They are stored as scrypt hashes in `users/{uid}/private/recovery`, which no client can read. `auth-useRecoveryCode` removes the authenticator so the person can enrol again. It allows five failed attempts per 15 minutes, gives unknown emails the same answer as wrong codes, and is audited.
- **Sign-up gate:** `auth-beforeCreate` refuses sign-up without a pending invite, except in projects with open sign-up (dev). `auth-beforeSignIn` stamps `users/{uid}/private/session` and logs the sign-in in `users/{uid}/signIns` (SEC-04).
- **Web:** `AuthState` exposes a status (`signedOut`, `needsVerification`, `needsMfa`, `needsOrg`, `ready`), and the guards send people to the missing step. Sign-out runs the feature clean-ups, deletes Firestore's IndexedDB caches and per-user storage, then signs out. "This is a shared computer" uses session persistence.

**Org security policies (SEC-04)** (`libs/domain/src/lib/security.ts`, `apps/functions/src/security/`, `apps/web/src/app/core/auth/session-policy.ts`, `idle-timeout.ts`)
- **Policy:** `orgs/{orgId}.security` holds `mfaRequired`, `mfaGraceHours`, `sessionIdleMinutes` and `maxSessionDays`. Owners and admins change it on Settings → Security through `security-updatePolicy`; everyone else sees it read-only. New orgs require MFA after a 24-hour grace; turning MFA on starts the grace from then (`mfaEnforceAfter`).
- **Enforcement:** one check in three places. Every callable (`defineCallable`, `core/sessions.ts`), the Firestore rules (`sessionOk()` inside `inOrg()`) and the client (`SessionPolicy`) refuse a sign-in that is older than `maxSessionDays` (the token's `auth_time`), from before the member's `sessionsValidAfter`, or without a second factor (`firebase.sign_in_second_factor`) once MFA is enforced. The org document and the member's own document stay readable so the app can say why. Storage rules check `sessionsValidAfter` only; MFA and session length reach files through the Firestore reads and callables that lead to them.
- **Client:** past the grace period a member without MFA is sent to set it up; during it a banner shows the deadline. A sign-in the policy refuses signs out to `/auth/signed-out?reason=expired|revoked|mfa`.
- **Inactivity:** `IdleTimeout` counts from the last click, key, scroll or touch in any tab (a BroadcastChannel shares activity and the sign-out), warns a minute before `sessionIdleMinutes`, then signs every tab out ("Signed out due to inactivity"). Uploads and recordings hold it off (`ActivityHolds`).
- **Re-authentication:** callables declare `recentLoginMinutes: 5` for sensitive actions (role changes, suspension, removal and offboarding, ownership transfer, policy changes, signing people out, the time-entry CSV and estate inventory exports, the full export, requesting a practice's deletion and deleting an account; the audit-log export, Clerk keys and safe-custody releases check it in their handlers). Connecting Claude (`connector-authorize`) and the practice's Claude connector settings (`connector-setPractice`) declare it too. The client's callable client answers `REAUTH_REQUIRED` with "Confirm it's you" (password, Google popup, then the authenticator code) and retries once.
- **Sessions:** `users/{uid}/signIns` logs each sign-in (time, provider, a coarse device and browser from the user agent, whether a second factor was enrolled; never the IP address or the raw user agent), read only by its owner and deleted by TTL after 90 days. "Sign out everywhere else" and an admin's "Sign out" (`security-revokeSessions`) stamp `sessionsValidAfter` and revoke the refresh tokens. Admins can't sign out an owner.

**Audit log (FND-18)** (`apps/functions/src/audit/`)
- **Capture:** two Firestore triggers record every org write. `audit-onOrgWrite` covers `orgs/{orgId}/{collection}/{docId}` and `audit-onMatterWrite` covers matter subcollections. Each write becomes one `orgs/{orgId}/audit/{eventId}` entry; the event id is the entry id, so a redelivered event adds nothing.
- **Contents:** `at` (event time), `actor` (`updatedBy`, or `deletedBy` for deletes; `system`/`clerk` as themselves), `action` (`create`, `update`, `delete`, `soft_delete`, `restore`), `entity`, `changedFields`, and `source` (`client`, `callable` when `_requestId` is present, or `trigger`).
- **Redaction:** `before`/`after` hold only the changed fields. Free text (`bodyMd`, `narrative`, `descriptionMd`, `notes`…) and any string over 280 characters become `{ len, sha256 }`; secrets (`encryptedRefreshToken`, `tokenHash`…) are dropped.
- **Not audited:** the `audit`, `metrics`, `activity`, `chunks`, `requests`, `counters` and `migrations` collections, and updates that touch only denormalised fields (`nextDeadline`, `openTaskCount`, `wipCents`, `lastActivityAt`, `search`) or `order`.
- **Legacy migration (MIG-06):** the load's writes (those that set or restamp `migration`) and a rollback's or delta's deletes aren't audited one by one. The tool records one entry per run instead (`migration.loaded`, `migration.rolled_back`, `migration.deleted`, `source: 'migration'`, with the run id and counts).
- **Semantic events:** callables add them with `audit(ctx, { action: 'invoice.issued', entity, summary, data })`, alongside the trigger's entry for the write.
- **Access:** clients can neither read nor write `audit` (rules). Reads go through `audit-query`: owners and admins query the whole org and see redacted values; other members read one visible matter's entries without values.
- **Retention:** `expireAt` is the event time plus the org's `retentionYears` (default 7), deleted by a TTL policy on `audit.expireAt`.
- **Failures:** a failed trigger never blocks the user's write. It is logged as a dead letter (ids only), and FND-21 adds the alert.

**Backups** (SEC-03; [restore runbook](runbooks/restore.md))
- Firestore PITR (7 days).
- Firestore managed backups in the database's region: daily, kept 7 days, and weekly, kept 14 weeks (Firestore's maximums).
- Daily managed exports to `australia-southeast2`, with a 35-day retention and monthly copies kept for 1 year.
- Storage soft-delete (30 days) and object versioning (non-current versions kept 90 days) on the document bucket, plus a nightly copy to `australia-southeast2`.
- A quarterly restore drill (the `backup-drill` workflow on dev).
- Destroying a matter (CORE-19) deletes its live data only. Backups, PITR, Storage soft-delete, non-current versions and the nightly Storage copy keep it until they expire (35 days for daily exports, 1 year for the monthly copies), and a restore drill must not bring a destroyed matter back into the live database. The destruction certificate says so.

**Supply chain and security assurance (SEC-02)**
- **Threat model:** [docs/security/threat-model.md](security/threat-model.md), STRIDE per element, reviewed quarterly. **Pentest:** [docs/security/pentest-plan.md](security/pentest-plan.md), before GA, with a 7-day (critical) and 30-day (high) remediation SLA.
- **Dependencies:** Dependabot (`.github/dependabot.yml`) groups npm and Actions updates weekly. The dev-patch group (patch updates of development dependencies) merges itself once `ci` passes (`dependabot-automerge.yml`, which checks the author, branch, tested commit and that only `package.json` and `pnpm-lock.yaml` change); every other update waits for review. `pnpm audit --prod --audit-level=high` gates every PR.
  - `pnpm.overrides` in `package.json` lift transitive packages to a fixed release when upstream hasn't yet (axios, grpc-js, brace-expansion, smol-toml, the MCP SDK under firebase-tools). Advisories left open on purpose (October 2026), none reachable from Materia:
    - **Production:** uuid below 11.1.1 (under the Functions Framework's cloudevents; the flaw needs a `buf` argument to v3, v5 or v6, and only v4 is called) and sprintf-js (under mammoth's argparse, which only its command line uses).
    - **Tooling only:** webpack-dev-middleware 6 (Storybook's local dev server; Storybook 10 still requires ^6), basic-ftp 5 (firebase-tools' proxy agent for `ftp://` PAC files; get-uri still requires ^5), braces 3.0.3 and sprintf-js (no fixed release), and @opentelemetry/core 1.x (firebase-tools' Pub/Sub emulator client).
- **Code:** CodeQL with the `security-extended` queries, daily in the morning run; high-severity findings fail it.
- **Secrets:** gitleaks on every change, with custom rules (`.gitleaks.toml`) for Google service account keys (JSON and base64), Anthropic and Resend keys; `.github/scripts/gitleaks-selftest.sh` proves the rules still fire.
- **Containers:** the jobs, scanner and preview images are scanned with Trivy in CI whenever they change (`.github/actions/trivy`); fixable high and critical findings fail the change. This replaces Artifact Registry's on-push scanning, which is off because it was billed per image on every deploy. The images run `apt-get upgrade` and ship without npm.
- **Terraform:** checkov and tflint in CI.
- **Rules:** the generated per-collection, per-role suite (cross-org denials included) plus a fuzz test of random paths, identities and operations (`firebase/tests/rules-fuzz.spec.ts`).
- **SBOM:** a CycloneDX SBOM (`sbom.cdx.json`, from the lockfile) is attached to every GitHub release (`sbom.yml`, dispatched by `release.yml`).
- **Actions:** GitHub-owned actions only; CLI tools pinned and checksum-verified.
- **Disclosure:** [SECURITY.md](../SECURITY.md), published with the app at `/SECURITY.md`, and `/.well-known/security.txt` (RFC 9116; renew `Expires` yearly, a unit test fails a month before).

**AI**
- See *Clerk (AI) architecture & guardrails*: scoping, privilege handling, injection defence, no prompt or completion text in logs, and a provider data-retention setting.

**Claude connector (INT-07, [ADR-064](adr/064-claude-connector.md))** (`apps/functions/src/connector/`, `libs/domain/src/lib/connector.ts`)
- **What it is:** an MCP server (`/mcp`) and OAuth authorization server on the app's own origin, so a person can use Materia from their own Claude or Claude Code. Off unless the `integrations.claudeConnector` flag is on and an owner or admin turns it on in Settings → Claude connector.
- **Sign-in:** only Claude and Claude Code, pinned with their exact redirect URIs; PKCE `S256`; one-use codes; refresh tokens rotate, and reuse ends the connection. Tokens are opaque and stored only as SHA-256 hashes in `connectorGrants`, which clients can't read and the full export leaves out.
- **Every call:** re-checks the connection, the member and their current role, sign-out-everywhere, the practice's maximum session length and MFA rule, the practice switch and the flag. Read tools never return privileged matters or document text; money only for roles with `billing.view`. Write tools only create suggestion cards a person accepts (ADR-037). Each call is audited (`connector.tool_used`: tool, matter, count, refused) without what was asked or returned, and limited to 120 a minute per connection.
- **Data leaving Materia:** what Claude reads is processed by Anthropic under the person's own Claude account, not the firm's agreement. The consent page and Settings say so. The flag stays off in prod until that wording is reviewed with the legal pages (SEC-01a).

**Data rights** (SEC-05, [ADR-058](adr/058-org-export-and-deletion.md); what Materia keeps and for how long: the [retention policy](compliance/retention-policy.md); operations: the [org deletion runbook](runbooks/org-deletion.md))
- **Full export** (Settings → Data and deletion, owners only, recent sign-in): `exports-orgFull`, after the owner confirms they understand it includes privileged material. Every record as `data/{collection}.jsonl` with `schemas/{collection}.schema.json` (generated from libs/domain), the documents under `files/` (the current version, or every version), the practice's other files, `README.md`, and `manifest.json` with each file's SHA-256. Over 10 GB it is split into self-contained zips. Kept 7 days behind 5-minute signed links, announced by `export_ready`, audited (`export.created`, `export.org_completed`). OAuth tokens, invites, export jobs and Clerk's search chunks are left out.
- **Member offboarding** (Settings → Team and roles → Remove…): a wizard hands the leaver's open tasks, upcoming deadlines and responsible matters to people who can take them (privileged work only to those who can see privileged matters), exports their personal tasks to the admin as a CSV or deletes them, saves a running timer as draft time and revokes their connections, then removes them (`orgs-offboardMember`, audited `member.offboarded`). Their records and history stay.
- **Org deletion** (owners only, recent sign-in, typing the practice's name): `orgs-requestDeletion` schedules it 30 days on and tells every member. Until then the practice is **read-only**: the callable wrapper refuses everything outside an allow-list (`ORG_READ_ONLY`), the rules refuse client writes, uploads and new members are refused, and every page shows a banner. Any owner cancels (`orgs-cancelDeletion`). A **legal hold** on the practice or any matter, or a full export still being written, refuses the request; a hold placed during the grace period stops the deletion when it falls due (`org.deletion_blocked`).
- **Purge:** `orgs-purgeDeletedOrgs` (daily) queues due practices on `orgs-purge`, which writes the tombstone `deletedOrgs/{orgId}` (server-only; from then on triggers and queued tasks skip the practice), revokes and deletes connections, deletes every stored file and version, the org document and everything under it (the audit log included), releases the members (claims recomputed; other practices' memberships stay), verifies nothing is left and emails the owners a **certificate of deletion** (PDF). The tombstone keeps only `{orgId, name, deletedAt, certificateId}` and the counts. Backups are not edited; the certificate says when they expire (every copy within about 13 months), and a restore never brings the practice back ([restore runbook](runbooks/restore.md)).
- **Account deletion:** someone in no practice deletes their own account from the onboarding page (`auth-deleteAccount`, typing DELETE).

## Legal documents and terms acceptance (SEC-01)

The privacy and legal documents are Markdown in [`docs/compliance/`](compliance/). Each is a **draft** until a lawyer or privacy professional signs it off (SEC-01a) **(sign-off)**. Square brackets mark placeholders, such as the operator's legal name, ABN, address and contact emails.

| Document | Source | In the app |
|---|---|---|
| Privacy policy | [privacy-policy.md](compliance/privacy-policy.md) | `/legal/privacy` |
| Collection notice (APP 5), with wording firms can adapt for their clients | [collection-notice.md](compliance/collection-notice.md) | `/legal/collection-notice` |
| Terms of service | [terms-of-service.md](compliance/terms-of-service.md) | `/legal/terms` |
| Data processing addendum, part of the terms (breach notice to firms within [72] hours) | [dpa.md](compliance/dpa.md) | `/legal/dpa` |
| Sub-processor list | [subprocessors.md](compliance/subprocessors.md) | `/legal/subprocessors` |
| Retention and deletion policy | [retention-policy.md](compliance/retention-policy.md) | `/legal/retention` |
| Accessibility statement (SEC-06; draft until the screen reader audit, SEC-06a) | [accessibility-statement.md](compliance/accessibility-statement.md) | `/legal/accessibility` |
| Privacy impact assessment (internal) | [pia.md](compliance/pia.md) | Not published |
| Data breach response plan (internal) | [runbooks/data-breach.md](runbooks/data-breach.md) | Not published |

**One source.** A published document has front-matter (`key`, `title`, `summary`, `version`, `effective`, `status`, `order`). `pnpm materia-scripts legal-docs` compiles them into the registry (`libs/domain/src/lib/legal-documents.generated.ts`, behind `LEGAL_DOCUMENTS` in `legal.ts`), the terms' version (`terms-version.generated.ts`, behind `TERMS_VERSION` in `terms.ts`, kept apart so the app's terms check doesn't put the registry in the initial bundle) and the web app's text (`apps/web/src/app/features/legal/legal-content.generated.ts`). The scripts unit test fails while the generated files are out of date, and the CI gate treats `docs/compliance/` as code, so a change to a document runs the tests and deploys. The pages under `/legal` are public and lazy-loaded, use the minimal layout, and show each document's version, effective date and, while `status: draft`, a "Draft — not yet reviewed" notice. A new document is one more Markdown file with front-matter, as the accessibility statement (SEC-06) is. Links between published documents (`[DPA](dpa.md)`) become `/legal/...` links; a link to anything else in the repository fails the compile.

To change a document: edit its Markdown, raise `version` and set `effective`, run `pnpm materia-scripts legal-docs`, and commit the generated files with it. Once signed off, set `status: final` and remove the draft notice from the top of the Markdown.

**Terms acceptance.** The terms of service and the DPA are one agreement, versioned together (`TERMS_VERSION`, the compile refuses different versions). The org's owner accepts it on the practice's behalf: by ticking the box when creating the practice (`orgs-createOrg` with `acceptTermsVersion`), or on `/accept-terms`, where `termsGuard` sends an owner whose org hasn't accepted the current version, after org selection and before the app. `orgs-acceptTerms` (owner only, idempotent) records `termsAcceptedVersion`, `termsAcceptedAt` and `termsAcceptedBy` on the org and audits `org.terms_accepted`; the fields are server-owned, so the rules refuse them from clients. Admins, lawyers, paralegals and read-only members are never blocked. The check reads the org document `SessionPolicy` already follows, so it adds no read, and it doesn't block when that document can't be read. Raising the terms' version asks every owner again on their next visit. **Until the terms are signed off (`status: final`), prod asks nobody**: `termsAskedIn` (libs/domain `terms.ts`) asks owners outside prod only, so dev and e2e exercise the flow while no one in prod accepts unreviewed terms. Setting `status: final` (SEC-01a) turns it on in prod, and every existing owner is asked once.

**Breaches.** The [data breach response plan](runbooks/data-breach.md) covers containment, the NDB assessment (30 days), notifying firms (the DPA's [72] hours), the OAIC and individuals, and the review. [Incident response](runbooks/incident-response.md) says when to open it.

## Threat model highlights (the full model: [docs/security/threat-model.md](security/threat-model.md))

| Threat | Mitigation |
|---|---|
| Cross-tenant data access through a crafted query | Rules check `orgId` on the path and on collection-group docs; cross-org rules tests |
| A stale role after demotion | Claims refresh is forced (revoke refresh tokens). Rules read `members/{uid}.status` for sensitive collections |
| Prompt injection from an uploaded document | Read-only tools, suggestions-only writes, untrusted-document framing, evals |
| A malicious upload | Scan before access, Content-Disposition attachment, no inline HTML rendering, sandboxed PDF.js |
| Exfiltration through integrations | Explicit per-user connect, scoped OAuth, privileged items excluded from sync by default |
| Matter data leaving through the Claude connector | Off until the practice turns it on; each person connects their own Claude and sees only what they can; privileged matters and document text never shared; suggestions only; every call audited; disconnect, removal or turning it off ends access on the next request |
| An insider at the firm | Audit log, export re-auth, role-based access to privileged material |
| Lost device | Short sessions on mobile, remote sign-out (revoke), Firestore cache cleared on sign-out |
