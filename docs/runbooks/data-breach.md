# Data breach response plan (NDB)

> **Draft — not yet reviewed.** Prepared for SEC-01 (MAT-111); a lawyer or privacy professional reviews and signs it off in SEC-01a. Square brackets are placeholders.

What to do when personal information Materia holds may have been accessed, disclosed or lost without authorisation. It follows the OAIC's four steps (contain, assess, notify, review) and the Notifiable Data Breaches (NDB) scheme in Part IIIC of the Privacy Act 1988 (Cth). It starts from [incident response](incident-response.md), which says when to open it.

## Roles

Materia is run by one owner, so most roles are the same person today. Name a deputy before a second firm is onboarded.

| Role | Who | Does |
| --- | --- | --- |
| Incident lead | The owner (Blake), on call | Runs the response: contains, collects facts, keeps the log, makes the calls below |
| Privacy officer | [Privacy officer name or role] | Decides whether the breach is an eligible data breach, approves every notification |
| Legal adviser | [Lawyer or privacy professional] | Advises on the assessment, privilege and notifications |
| Engineering | Whoever can change the system (the owner, or an agent under the owner's direction) | Containment, evidence, root cause and fixes, following [incident response](incident-response.md), [rollback](rollback.md) and [restore](restore.md) |
| Each affected firm's contact | The firm's owner in Materia | Receives our notice, decides with us who notifies its clients |

Keep a breach log in the incident ticket (Linear, label `Security`): times, facts, decisions and who made them, and every notice sent. Never put client names, document text or other personal information in the ticket; use ids.

## Timeline

| When | What |
| --- | --- |
| Immediately | Contain. Open the incident ticket and the breach log. Preserve evidence |
| Within 24 hours | First assessment: what data, which firms, which people, still happening? |
| **Within 72 hours** of becoming aware | **Notify each affected firm's owner** (DPA clause 7.1; 72 hours is a placeholder for the reviewer), even if the facts are incomplete. Update them as you learn more |
| As fast as possible, **at most 30 days** | Finish the assessment: is it an eligible data breach? (s 26WH) |
| As soon as practicable after deciding it's eligible | Statement to the OAIC and notification of the people at risk (s 26WK, s 26WL), coordinated with the firm |
| Within 2 weeks of closing | Post-incident review |

## Step 1: contain

- Stop the exposure: roll back the release ([rollback](rollback.md)), revoke sessions (`security-revokeSessions`, or Settings → Security → sign out), suspend accounts, revoke signed URLs by rotating what signs them, close the public path.
- Rotate exposed credentials first: Secret Manager versions, then redeploy; for integration tokens, disconnect the integration; for a firm's Anthropic key, ask the firm to revoke it in its Anthropic Console and remove it in Settings → Clerk.
- Turn a feature off with its flag (for example `clerk.enabled`) if it is the path of the breach.
- Preserve evidence before it expires: export the relevant Cloud Logging entries and the audit log entries to the backups bucket, and export the database if records were changed ([restore](restore.md) step 2). Logs are kept about 30 days.

## Step 2: assess

Answer these and record the answers in the log:

1. **What happened**, when it started and ended, and is it contained?
2. **What information**: which collections, documents or fields; is any of it sensitive (health), financial, identity documents, tax file numbers, or privileged?
3. **Whose**: which firms (org ids), which people (count, and categories such as clients, beneficiaries, firm users)? The audit log and access logs show who read or changed what.
4. **Who got it**, and could they use it? Was it encrypted? Was it recovered or deleted, and can we confirm that?
5. **Is serious harm likely?** Consider the kind of information, its sensitivity, the security protecting it, who has it, and the harm (identity fraud, financial loss, distress, damage to legal proceedings or privilege). Remedial action that prevents serious harm means it isn't eligible (s 26WF).

### Decision tree

```
Was personal information accessed, disclosed or lost without authorisation?
├─ No ──────────────────────────────▶ Not a data breach. Close in the log, with reasons.
└─ Yes or not sure
   │
   Notify each affected firm's owner within 72 hours (whatever the answers below).
   │
   Is serious harm to any person likely? (sensitivity, who has it, protections, harm types)
   ├─ No, or remedial action has made it unlikely (s 26WF) ──▶ Not eligible. Record the reasons.
   │                                                            The firm may still choose to tell clients.
   ├─ Not sure ──▶ Keep assessing: reasonable, expeditious, finished within 30 days (s 26WH).
   │               Still unsure at the end: treat it as eligible.
   └─ Yes ──▶ Eligible data breach.
              │
              Whose information?
              ├─ Firm users' account data (we decide its purposes) ──▶ We notify the OAIC and the users.
              ├─ A firm's client information (we hold it for the firm) ──▶ Agree with the firm who notifies.
              │                                                           Default: the firm notifies its clients and the OAIC,
              │                                                           with our statement of the facts; one notice covers both
              │                                                           of us (Part IIIC joint-entity provisions; reviewer to confirm).
              └─ Both ──▶ Both of the above, coordinated so people get one clear message.
              │
              Can we notify the individuals at risk directly?
              ├─ Yes ──▶ Notify all affected individuals, or only those at risk of serious harm.
              └─ No ──▶ Publish the statement on the website and take reasonable steps to publicise it.
```

## Step 3: notify

### The firm (within 72 hours)

Email the firm's owner (and tell them in Materia if it is up). Keep it factual:

> **Subject:** Security incident affecting your firm's data in Materia
>
> On [date and time] we became aware of [one-line description]. It involves [categories of information] relating to [number or description of people]. We have [containment steps]. We are assessing whether it is an eligible data breach under the Notifiable Data Breaches scheme and will finish that by [date, at most 30 days]. We will update you by [date]. Your contact for this is [name, email, phone]. Please don't forward client details by email; we can discuss specifics by phone.

### The OAIC

Use the OAIC's online **Notifiable Data Breach form** (oaic.gov.au → Privacy → Notifiable data breaches → Report a data breach). It asks for the statement required by s 26WK. Prepare it in this template first, in the incident ticket:

| Field | Content |
| --- | --- |
| Entity name and contact details | [Operator legal name], ABN [ABN], [Privacy contact email], [phone]; and the firm's details if notifying jointly |
| Other entities involved | [Each affected firm, if a joint notification] |
| Description of the breach | What happened, when, how it was discovered, whether it is contained |
| Kinds of information involved | For example: names, contact details, dates of birth, identity documents, health information, financial information, legal documents |
| Number of individuals | Actual or estimated |
| Recommended steps for individuals | What people should do: watch for phishing that uses the details, change passwords, contact their bank, IDCARE (1800 595 160) for identity documents |
| What we have done | Containment, investigation, notifications, fixes |

### The individuals

Through the firm for its clients, or directly for our users. The notice contains the same statement as the OAIC's (s 26WL): who we are, what happened, the kinds of information, and the recommended steps. Plain language, no blame, a contact who can answer questions.

### Others to consider

- The **Victorian Legal Services Board and Commissioner**, where a firm's trust records or regulatory obligations are affected (the firm decides).
- **Insurers**: the operator's cyber insurer [placeholder], and the firm's professional indemnity insurer (the firm decides).
- **Police or the ACSC** (cyber.gov.au, ReportCyber) for criminal activity.
- **Sub-processors** involved (Google, Resend, Anthropic) to contain and investigate on their side.

## Step 4: review

Within two weeks of closing: what happened, timeline, root cause, what worked and didn't, and follow-up tickets (with the `Security` label). Update this plan, the [PIA](../compliance/pia.md) risk register and the threat model (SEC-02) where they were wrong. Test this plan once a year with a tabletop exercise.
