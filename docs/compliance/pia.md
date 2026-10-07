# Privacy impact assessment

> **Draft — not yet reviewed.** Prepared by an agent for SEC-01 (MAT-111) on 2026-10-07 from the repository's architecture and domain model. A lawyer or privacy professional reviews and signs it off in SEC-01a. Internal document: not published in the app.

This assessment follows the OAIC's *Guide to undertaking privacy impact assessments*. It covers Materia v2 as built at the date above: what personal information it handles, where it goes, how it measures against the Australian Privacy Principles (APPs 1–13), and the risks that remain, each cross-referenced to the ticket that mitigates it.

## 1. The project

Materia is a practice management tool for Australian wills and estates lawyers, launching with one firm in Victoria. Firms keep their matters in it (wills, powers of attorney, probate, estate administration, family provision claims and will disputes): contacts, parties, key dates and statutory deadlines, tasks, documents, file notes, time and billing, an estate register and a will safe custody register. Clerk, an optional AI assistant, answers questions about a matter, suggests tasks and deadlines, reads and sorts documents, and drafts text; it proposes and never commits.

**Roles.** For the client information a firm enters, the firm is the APP entity that collects it and decides how it is used; the operator ([Operator legal name]) handles it on the firm's behalf, as its service provider, under the [Terms of service](terms-of-service.md) and [Data processing addendum](dpa.md). For firm users' account information, the operator is the APP entity. The operator commits to the APPs whether or not the small business exemption applies to it (to confirm: R1).

**Status at assessment.** MVP mode: the only users are the operator's own firm. The legal documents are drafts (`/legal/*`, marked "Draft"), which the handbook accepts only while that remains true.

## 2. Data inventory

From the domain model ([`docs/02-domain-model.md`](../02-domain-model.md), the zod schemas in `libs/domain`). Paths are under `orgs/{orgId}/` unless shown otherwise.

| Category | Whose | What (examples) | Sensitivity | Stored | Kept |
| --- | --- | --- | --- | --- | --- |
| User accounts | Firm users | Identity Platform account (email, name, password hash, TOTP enrolment, Google link); `users/{uid}` profile and preferences; `members/{uid}` (role, status, title, admission number, rates, budgets, supervisor) | Personal | Identity Platform (global, verify); Firestore Sydney | Until removed or the agreement ends |
| Security records | Firm users | `users/{uid}/signIns` (time, provider, coarse device and browser, second factor; no IP or raw user agent); hashed recovery codes; `sessionsValidAfter` | Personal | Firestore Sydney | Sign-ins 90 days (TTL) |
| Invites | Invitees | Email, role, token hash | Personal | Firestore Sydney | Expire after 7 days |
| Contacts | Clients, deceased persons, beneficiaries, executors, other parties, referrers | Names, dates of birth and death, emails, phones (E.164), addresses, tags, referrer details, notes, ABN for organisations | Personal; often about deceased or vulnerable people | Firestore Sydney | Firm's retention |
| Matters and parties | As above | Matter type, status, parties and their roles, key facts (date of death, will located, grant issued), conflict checks | Personal; confidential; often privileged | Firestore Sydney | Firm's retention (7 years after closing by default) |
| Documents | As above | Wills, codicils, death certificates, grants, affidavits, identity documents, financial records, medical evidence, correspondence; versions, previews, extracted text chunks and embeddings | **Sensitive** (health information); government identifiers in ID documents; **privileged** | Cloud Storage and Firestore Sydney; embeddings in Firestore | Firm's retention; chunks destroyed with the matter |
| File notes | As above | Notes (Markdown) and their revisions, mentions | Personal; often privileged | Firestore Sydney | Firm's retention |
| Estate register | Deceased persons, beneficiaries, creditors | Assets, liabilities, distributions, superannuation, joint holdings | Personal; financial | Firestore Sydney | Firm's retention |
| Time and billing | Clients; firm users | Time entries and narratives, disbursements, invoices, credit notes, payments, reminders, costs disclosures, trust balance snapshots (copied, never a ledger) | Personal; financial | Firestore Sydney; invoices to Xero if connected | Firm's retention |
| Safe custody | Testators | Packets: testator, items, location, movements, release authorities | Personal; high-value originals | Firestore Sydney | Indefinitely while held |
| Clerk | As above | Threads and messages, suggestions, citations, daily briefs, insight narratives | Derived from the above; privileged flag carried through | Firestore Sydney; requests processed by the firm's AI provider | With the matter; pending suggestions marked expired after 14 days |
| Notifications | Firm users | In-app notifications (title and body never privileged), digests, delivery outcomes, push tokens | Personal | Firestore Sydney; email via Resend (US); push via FCM | Notifications 90 days |
| Audit and activity | Firm users; record subjects | Who changed what and when; before/after values with free text replaced by length and hash; activity feed | Personal (metadata) | Firestore Sydney | Audit 7 years (org retention period) |
| Exports | As above | CSV, PDF and zip exports a user asks for | As the source | Cloud Storage Sydney | 7 days |
| Integrations | Firm users | KMS-encrypted OAuth refresh tokens and the firm's Anthropic API key; connection status | Credentials | Firestore Sydney (server-only) | Until disconnected |
| Operations | — | Structured logs and error reports (ids only, client errors scrubbed), metrics, uptime checks | Not personal by design | Cloud Logging and Error Reporting | About 30 days |
| Legacy migration | The migrated firm's records | One-time export of the legacy app's data for its one user | As the source | Migration bucket Sydney (CMEK) | 90 days |
| Browser cache | Firm users and record subjects | Firestore offline cache (IndexedDB), preferences in local storage | As the source | The user's device | Cleared on sign-out; "shared computer" keeps the session to the tab |

**Sensitive information.** Health information (capacity disputes, medical evidence) is the main sensitive category; wills can also reveal religious beliefs, relationships and similar. Firms may upload documents containing **tax file numbers** (financial records); the Privacy (Tax File Number) Rule 2015 then applies to the firm (R11).

**Government related identifiers (APP 9).** Driver licence, passport and Medicare numbers appear inside identity documents. Materia never adopts them as identifiers or uses them to look anyone up.

## 3. Information flows

```
Firm user's browser ──TLS──▶ Firebase Hosting (CSP, App Check)
     │  sign-in ───────────────▶ Identity Platform (global) [+ Google sign-in, optional]
     │  reads, simple writes ───▶ Firestore (australia-southeast1), rules check org, role, membership
     │  callables ──────────────▶ Cloud Functions (australia-southeast1)
     │                               ├─▶ Cloud Tasks / Cloud Run jobs and services (australia-southeast1):
     │                               │     malware scan (ClamAV), previews, PDF render, exports
     │                               ├─▶ Vertex AI embeddings (australia-southeast1)
     │                               ├─▶ Anthropic API (firm's own key, outside Australia), only with Clerk on
     │                               ├─▶ Resend (US): notification emails
     │                               ├─▶ FCM (global): push, once devices register
     │                               └─▶ Xero / Microsoft 365 / Google Workspace, only when connected
     │  uploads ────────────────▶ Cloud Storage (australia-southeast1), quarantined until scanned
     └─ offline cache in the browser (cleared on sign-out)

Backups: PITR and managed backups (australia-southeast1); nightly exports and file copies to australia-southeast2
```

1. **Account and sign-in.** Identity Platform holds the account; `auth-beforeSignIn` writes the sign-in log; claims carry `orgId` and `role`.
2. **Matter work.** The browser reads and writes Firestore directly where rules allow, and through callables for invariants and anything privileged; triggers maintain the audit log, activity and denormalised fields.
3. **Documents.** Upload to Storage, malware scan, then ingestion (AI-04): text extraction, OCR of scanned pages through Clerk (the firm's AI provider), chunking, Vertex embeddings in Sydney, classification suggestion.
4. **Clerk.** Context assembled server-side from what the asking user can open (AI-03), privileged material only for roles allowed to see it, sent to the firm's AI provider under its key; answers and suggestions stored in Firestore.
5. **Notifications.** In-app always; email through Resend; push through FCM. Titles never contain matter content; bodies never contain privileged content.
6. **Integrations.** OAuth server-side with KMS-encrypted refresh tokens (INT-01); Xero receives issued invoices and the billed client's name, email and address (BILL-09).
7. **Exports and destruction.** Exports to Storage for 7 days; destruction deletes live data and leaves a tombstone, the audit trail and a certificate (CORE-19).

## 4. Sub-processors

The published [Sub-processor list](subprocessors.md) is the reference. In summary: Google Cloud and Firebase in Australia for all data; Google's global Firebase services (Identity Platform, App Check with reCAPTCHA Enterprise, FCM, Remote Config, Cloud Logging and Error Reporting) for account, device and technical data; Resend, Inc. (US) for email. Firm-directed: Anthropic (Clerk, under the firm's own account, ADR-011b), Xero, Microsoft 365 and Google Workspace. It matches [ADR-011a](../adr/ADR-011a-clerk-provider.md), [ADR-011b](../adr/ADR-011b-clerk-byok.md), [ADR-012](../adr/012-retrieval.md) and ADR-057 (Resend, FND-20b).

## 5. Assessment against the APPs

| APP | Requirement | How Materia meets it | Gaps and actions |
| --- | --- | --- | --- |
| 1 Open and transparent management | A clearly expressed, up-to-date privacy policy; practices, procedures and systems to comply | Privacy policy at `/legal/privacy`, versioned; this PIA; the security doc; the data breach response plan; privacy by design in the architecture (tenancy, rules tests, no PII in logs) | Policy is a draft (SEC-01a). Name a privacy officer (R1) |
| 2 Anonymity and pseudonymity | Allow dealing anonymously where practicable | Not practicable for accounts (the firm must know its users). Firms' clients deal with their firm, not with Materia | None |
| 3 Collection of solicited information | Collect only what is reasonably necessary; sensitive information only with consent or an exception | User data is limited to what accounts and security need (no IP addresses in the sign-in log). Client information is collected by firms for legal services; the firm relies on consent or the exceptions for legal practice | Firms' own obligation; the collection notice (Part 2) helps them |
| 4 Unsolicited information | Destroy or de-identify what couldn't have been collected | Firms control what they upload and can delete records and documents; destruction workflow for matters | None for Materia |
| 5 Notification of collection | Tell people about collection at or before the time | Collection notice at `/legal/collection-notice`, linked from the sign-in pages; Part 2 gives firms wording for their clients, including the overseas disclosures | Firms to adopt the wording (R10) |
| 6 Use or disclosure | Only for the primary purpose, or a permitted secondary purpose | Client information used only to provide Materia to the firm (DPA 1.2); no advertising, sale or model training; Clerk scoped to what the asking user can open | None |
| 7 Direct marketing | No direct marketing without meeting the APP's conditions | Materia sends no marketing; emails are service notifications that users control in preferences | None |
| **8 Cross-border disclosure** | Reasonable steps so overseas recipients don't breach the APPs; the entity stays accountable (s 16C) | See section 6 below | R2, R3, R4 |
| 9 Government related identifiers | Don't adopt, use or disclose them as identifiers | Never adopted; they sit inside documents only | None |
| 10 Quality | Accurate, up to date, complete | Users edit their own profile; firms maintain records; duplicate contact detection and merge (CORE-01); key-fact citations for Clerk's values (CORE-06a) | None |
| **11 Security** | Reasonable steps to protect from misuse, interference, loss and unauthorised access; destroy or de-identify when no longer needed | See section 7 below | R5–R9, R12 |
| 12 Access | Give access on request, within a reasonable time | Users see their profile, sessions and sign-in history; firms can find and show a client's records. Full self-service export is SEC-05 | Org export pending (SEC-05); until then on request |
| 13 Correction | Correct on request or on its own initiative | Users correct their own details; firms correct client records; the audit log keeps the history | None |

## 6. APP 8: cross-border disclosure

| Recipient | What leaves Australia | Basis and safeguards | Assessment |
| --- | --- | --- | --- |
| Resend, Inc. (US), email | Recipient address, subject, body of notification emails (invites, reminders, digests, weekly report) | Engaged by the operator (ADR-057). Subjects never carry matter content (ADR-030); bodies never carry privileged content; open and click tracking off. Needs a contract with APP-equivalent obligations (Resend's DPA) | Low to moderate. Action R2: execute Resend's DPA, record it in `infra/MANUAL.md` |
| Google global services | Account identity and sign-in events (Identity Platform), browser and device signals (reCAPTCHA Enterprise), push tokens and notification titles (FCM), Remote Config fetches, technical logs (ids only) | Google Cloud's data processing terms. Client files, documents and notes stay in Sydney | Low. Action R3: confirm the locations and terms of each service (marked "verify") |
| Anthropic (outside Australia), Clerk | For each request: the question, key facts, relevant document and note excerpts, or a scanned page for OCR | ADR-011a (owner accepted processing outside Australia for the MVP); ADR-011b: each firm uses its own Anthropic account and terms, so the disclosure is the firm's, made when it saves its key, after the AI-13 data-use disclosure. Context is scoped to what the asking user can open (AI-03); privileged material only for allowed roles; no prompt or completion text in our logs | Moderate (sensitive and privileged content). Actions R4 (firms to consider zero data retention with Anthropic and tell clients); the Bedrock `AU` route in ADR-011a is the documented path if Australian processing becomes a requirement |
| Xero, Microsoft, Google Workspace | What the firm's connected features send (Xero: issued invoices and the billed client's name, email and address) | Firm-directed; explicit connect per user or per org; privileged items excluded from sync by default; scoped OAuth | Firm's disclosure; listed for transparency |

Embeddings never leave Australia (Vertex AI in `australia-southeast1`, ADR-012), and no third-party search service is used.

## 7. APP 11: security

The controls are in [Security, privacy & compliance](../09-security-privacy-compliance.md). In summary:

- **Tenancy and access:** everything under `orgs/{orgId}`; default-deny rules tested per role and across orgs (FND-14, FND-17); callables re-check role and active membership (FND-15, ADR-021); privileged material hidden from read-only roles; Clerk scoping (AI-03).
- **Identity:** Identity Platform with breached-password checks, TOTP MFA that orgs enforce, session limits, idle timeout, remote sign-out, re-authentication for sensitive actions (FND-16, SEC-04).
- **Application:** enforced CSP and security headers, App Check with reCAPTCHA Enterprise (FND-22); malware scanning before access, signed downloads (CORE-12); KMS-encrypted secrets and tokens (ADR-019, ADR-051, ADR-011b).
- **Detection:** append-only audit log with redaction, kept 7 years (FND-18); alerts and incident response (FND-21); no PII in logs, client error scrubbing.
- **Resilience:** PITR, managed backups, exports and file copies to Melbourne, quarterly restore drills (SEC-03).
- **Destruction:** CORE-19's approved, certified destruction; backups expire on schedule (within about 13 months) and are never restored over a destruction.
- **Assurance:** threat model, scanning and a penetration test (SEC-02), pending.

## 8. Risks and mitigations

| ID | Risk | Likelihood | Impact | Mitigation | Ticket | Residual |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | The legal documents aren't reviewed, the operator's Privacy Act status isn't settled, and no privacy officer is named | Certain until done | Medium | Drafts marked "Draft"; MVP limited to the operator's own firm; human checklist | SEC-01a | Low once signed off |
| R2 | Email content disclosed in the US without a contract that binds the provider to the APPs | Low | Medium | No matter content in subjects, no privileged content in bodies; execute Resend's DPA | FND-20b, SEC-01a | Low |
| R3 | Global Google services' locations and terms not confirmed | Low | Low | Only account, device and technical data; confirm and update the list | SEC-01a | Low |
| R4 | Sensitive or privileged client material processed by the AI provider outside Australia | Medium (when Clerk is on) | High | Off by default; firm's own key and terms (BYOK); AI-13 disclosure acknowledged before use; scoping and privilege filters; no prompts in logs; zero data retention recommended; Bedrock `AU` documented | AI-01, AI-02a, AI-03, AI-13 | Medium, accepted by the owner for the MVP |
| R5 | Cross-tenant access through a rules or callable defect | Low | High | Default-deny rules with per-role and cross-org tests, server re-checks, membership checks | FND-14, FND-17, SEC-02 | Low |
| R6 | Account takeover of a firm user | Medium | High | MFA enforceable per org (on by default for new orgs after 24 hours), breached-password check, session limits, remote sign-out, re-auth for exports | FND-16, SEC-04 | Low |
| R7 | A malicious upload, or prompt injection through a document | Medium | Medium | Scan before access, no inline HTML, sandboxed PDF viewer; Clerk is read-only and proposes only | CORE-12, AI-03, AI-07 | Low |
| R8 | Personal information in logs or error reports | Low | Medium | Ids only; scrubbing in browser and server; review in incident response | FND-21 | Low |
| R9 | Data kept longer than needed, or destroyed too early | Medium | Medium | Retention per org (minimum 7 years), holds for originals, minors and legal holds, approval per matter, certificates; destruction flag off until practitioner sign-off | CORE-19, CORE-19a | Low once signed off |
| R10 | Firms' clients aren't told about Materia and its overseas disclosures | Medium | Medium | Collection notice Part 2 wording; DPA 6.2 | SEC-01, firm action | Low |
| R11 | Tax file numbers in uploaded financial documents | Medium | Medium | Firms' obligation under the TFN Rule; documents stay in Australia and are never sent to integrations; consider a TFN detection and redaction prompt later | Follow-up | Medium |
| R12 | A breach isn't assessed or notified in time | Low | High | Data breach response plan with roles, 30-day assessment, 72-hour firm notice, OAIC template; alerts; quarterly test of the alert path | SEC-01, FND-21 | Low |
| R13 | Data not returned or not deleted when a firm leaves | Low | Medium | Terms 12 and DPA 10; self-service export and org deletion with certificate | SEC-05 | Medium until SEC-05 ships |
| R14 | Backups keep destroyed data | Certain (by design) | Low | Disclosed in the retention policy and certificates; encrypted, access-restricted; expire within about 13 months; never restored over a destruction | SEC-03, CORE-19 | Low |
| R15 | Legacy migration data retained after cutover | Low | Medium | Migration bucket in Sydney with CMEK, 90-day lifecycle; read-only legacy access | MIG-02 | Low |

## 9. Recommendations

1. Sign off the drafts, settle the operator's details and name the privacy officer (SEC-01a).
2. Execute Resend's DPA and confirm Google's global service locations; update the sub-processor list (verify markers).
3. Ship SEC-05 (org export and deletion) before a second firm is onboarded, and SEC-02's penetration test before general launch.
4. Ask firms using Clerk to consider zero data retention with Anthropic and to adopt the client wording in the collection notice.
5. Re-assess this PIA when a new sub-processor, integration or Clerk feature is added, before onboarding a second firm, and at least once a year.

## 10. Sign-off

| Role | Name | Decision | Date |
| --- | --- | --- | --- |
| Reviewer (lawyer or privacy professional) | [Name] | [Approved / changes] | [Date] |
| Operator (owner) | [Name] | [Accepted residual risks] | [Date] |
