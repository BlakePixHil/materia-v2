# Security, privacy & compliance

> This page is engineering guidance, not legal advice. Items marked **(sign-off)** need a lawyer or privacy professional before launch.

## Data we hold

Client personal information is often sensitive: health information in capacity disputes, family relationships, financial details, and identity documents such as death certificates and driver licences. Legal professional privilege attaches to much of it. We treat **all matter data as confidential and potentially privileged**.

## Obligations to design for

- **Privacy Act 1988 (Cth), Australian Privacy Principles.** Collection notices, use limitation, cross-border disclosure (APP 8: keep processing in Australia, or document the sub-processor), security (APP 11), access and correction (APP 12, 13). Notifiable Data Breaches scheme: an assessment within 30 days, and notification. **(sign-off)**
- **Legal Profession Uniform Law, as applied in Victoria, and its Rules.** The regulator is the Victorian Legal Services Board and Commissioner.
  - Confidentiality.
  - Costs disclosure (Part 4.3).
  - File retention: the firm's policy, commonly 7 years after closure. Original wills are held indefinitely in safe custody.
  - Trust money: out of scope for v1. Materia never keeps trust records; it may only show a labelled balance snapshot ([ADR-035](adr/035-trust-accounting.md)).
  - **(sign-off)**
- **Privilege.** Privilege is never waived by the system: no automatic sharing, and privileged flags carry through exports, AI outputs and emails.
- **Data residency.** Primary data stays in `australia-southeast1`, backups in `australia-southeast2`. AI processing follows ADR-011a. Sub-processors are listed in the privacy policy.

## Controls

**Identity**
- Identity Platform. Password policy: minimum 12 characters, breached-password check through the Identity Platform password policy.
- TOTP MFA, enforceable per org. SSO with Microsoft Entra and Google.
- Session revocation on member removal or role downgrade.
- Re-authentication within 5 minutes is required for exports, deletes, role changes and integration connects.

**Authorisation**
- Custom claims `{orgId, role}`.
- Firestore and Storage rules are default-deny, with tests for every role and a cross-org test.
- Callables re-check the role server-side.

**App Check**
- reCAPTCHA Enterprise. Enforced on Firestore, Storage, Functions and Vertex.
- Debug tokens are allowed only in dev.

**Transport and storage encryption**
- TLS everywhere, with HSTS preload on the custom domain.
- Google-managed encryption at rest. CMEK is used for the migration bucket and the token KMS key.

**Secrets**
- Secret Manager, with rotation runbooks.
- OAuth refresh tokens are encrypted with Cloud KMS. Clients have no read path to them.

**Hosting headers**
- A strict CSP: `default-src 'self'`; Firebase and Google endpoints allow-listed. No inline scripts; Angular's `autoCsp` or nonces.
- `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (microphone and camera only on the mobile capture routes).

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
- **MFA:** optional TOTP authenticator apps; per-org enforcement comes in SEC-04 (`AuthState.mfaRequired`).
- **Recovery codes:** ten single-use codes from `auth-generateRecoveryCodes`, which needs a sign-in in the last five minutes. They are stored as scrypt hashes in `users/{uid}/private/recovery`, which no client can read. `auth-useRecoveryCode` removes the authenticator so the person can enrol again. It allows five failed attempts per 15 minutes, gives unknown emails the same answer as wrong codes, and is audited.
- **Sign-up gate:** `auth-beforeCreate` refuses sign-up without a pending invite, except in projects with open sign-up (dev). `auth-beforeSignIn` stamps `users/{uid}/private/session`.
- **Web:** `AuthState` exposes a status (`signedOut`, `needsVerification`, `needsMfa`, `needsOrg`, `ready`), and the guards send people to the missing step. Sign-out runs the feature clean-ups, deletes Firestore's IndexedDB caches and per-user storage, then signs out. "This is a shared computer" uses session persistence.

**Audit log (FND-18)** (`apps/functions/src/audit/`)
- **Capture:** two Firestore triggers record every org write. `audit-onOrgWrite` covers `orgs/{orgId}/{collection}/{docId}` and `audit-onMatterWrite` covers matter subcollections. Each write becomes one `orgs/{orgId}/audit/{eventId}` entry; the event id is the entry id, so a redelivered event adds nothing.
- **Contents:** `at` (event time), `actor` (`updatedBy`, or `deletedBy` for deletes; `system`/`clerk` as themselves), `action` (`create`, `update`, `delete`, `soft_delete`, `restore`), `entity`, `changedFields`, and `source` (`client`, `callable` when `_requestId` is present, `trigger`, or `migration` with `runId`).
- **Redaction:** `before`/`after` hold only the changed fields. Free text (`bodyMd`, `narrative`, `descriptionMd`, `notes`…) and any string over 280 characters become `{ len, sha256 }`; secrets (`encryptedRefreshToken`, `tokenHash`…) are dropped.
- **Not audited:** the `audit`, `metrics`, `activity`, `chunks`, `requests` and `counters` collections, and updates that touch only denormalised fields (`nextDeadline`, `openTaskCount`, `wipCents`, `lastActivityAt`, `search`) or `order`.
- **Semantic events:** callables add them with `audit(ctx, { action: 'invoice.issued', entity, summary, data })`, alongside the trigger's entry for the write.
- **Access:** clients can neither read nor write `audit` (rules). Reads go through `audit-query`: owners and admins query the whole org and see redacted values; other members read one visible matter's entries without values.
- **Retention:** `expireAt` is the event time plus the org's `retentionYears` (default 7), deleted by a TTL policy on `audit.expireAt`.
- **Failures:** a failed trigger never blocks the user's write. It is logged as a dead letter (ids only), and FND-21 adds the alert.

**Backups**
- Firestore PITR (7 days).
- Daily managed exports to `australia-southeast2`, with a 35-day retention and monthly copies kept for 1 year.
- Storage soft-delete and object versioning on the document bucket.
- A quarterly restore drill.

**Supply chain**
- Renovate or Dependabot with grouped updates, `pnpm audit`, CodeQL and gitleaks.
- Actions pinned by SHA.
- SBOM (CycloneDX) generated on release.

**AI**
- See *Clerk (AI) architecture & guardrails*: scoping, privilege handling, injection defence, no prompt or completion text in logs, and a provider data-retention setting.

**Data rights**
- Org export as a zip of JSON plus files, owner only.
- Member removal.
- Org deletion: a 30-day grace period, then purge, except records under legal hold or retention. A deletion certificate is produced.

## Threat model highlights (SEC-02 expands on these)

| Threat | Mitigation |
|---|---|
| Cross-tenant data access through a crafted query | Rules check `orgId` on the path and on collection-group docs; cross-org rules tests |
| A stale role after demotion | Claims refresh is forced (revoke refresh tokens). Rules read `members/{uid}.status` for sensitive collections |
| Prompt injection from an uploaded document | Read-only tools, suggestions-only writes, untrusted-document framing, evals |
| A malicious upload | Scan before access, Content-Disposition attachment, no inline HTML rendering, sandboxed PDF.js |
| Exfiltration through integrations | Explicit per-user connect, scoped OAuth, privileged items excluded from sync by default |
| An insider at the firm | Audit log, export re-auth, role-based access to privileged material |
| Lost device | Short sessions on mobile, remote sign-out (revoke), Firestore cache cleared on sign-out |
