---
key: dpa
title: Data processing addendum
summary: How we handle the client information firms keep in Materia, on their instructions: security, sub-processors, breach notification, and return and deletion.
version: 0.1
effective: 2026-10-07
status: draft
order: 4
---

# Data processing addendum

> **Draft — not yet reviewed.** This addendum is a draft for review by a lawyer or privacy professional (SEC-01a). It is not legal advice and is not in its final form. Text in square brackets is a placeholder to be completed before it is finalised.

This addendum (DPA) forms part of the [Terms of service](terms-of-service.md) between [Operator legal name] (ABN [ABN]) ("we", "us") and the law firm using Materia ("your firm", "you"). It has the same version as the terms and is accepted with them. Words defined in the terms have the same meaning here.

## 1. Roles

1.1 Your firm collects client information and decides the purposes for which it is used and disclosed. It is responsible for its own obligations to its clients and others whose information it keeps, including under the Privacy Act 1988 (Cth), the Australian Privacy Principles (APPs) and the Legal Profession Uniform Law (Victoria).

1.2 We handle client information only on your firm's behalf, to provide Materia, and on your firm's documented instructions: these terms, and your firm's use and configuration of Materia. If we think an instruction breaks the law, we will tell your firm.

1.3 We handle our own users' account information (names, emails, sign-in records) as described in our [Privacy policy](privacy-policy.md).

## 2. The information covered

2.1 **People:** your firm's clients and prospective clients; deceased persons; testators, executors, administrators, attorneys, guardians, trustees and beneficiaries; other parties, their lawyers and witnesses; referrers; and anyone else your firm records in a matter.

2.2 **Information:** identity and contact details; dates of birth and death; relationships; estate assets, liabilities and distributions; financial, billing and trust balance records; wills, identity documents, certificates, court documents and correspondence; file notes; and anything else your firm puts in Materia. It may include **sensitive information** (such as health information) and material subject to **legal professional privilege**.

2.3 **Processing:** storing, organising, searching, displaying, calculating deadlines from, scanning uploads for malware, extracting and indexing document text, sending notifications about, exporting, and (when your firm turns on Clerk) sending relevant parts to your firm's AI provider.

## 3. Our personnel

3.1 Only personnel who need it to provide, support or secure Materia can reach client information. They are bound by confidentiality, their access is limited to what the task needs, and it is logged. We don't open client files except at your firm's request, to investigate a security incident, or where the law requires it.

## 4. Security measures

4.1 We maintain these measures, and will not materially reduce them during the agreement:

- **Location:** client information, documents and backups are stored in Google Cloud in Australia: Sydney (`australia-southeast1`) for the live service and Melbourne (`australia-southeast2`) for backups.
- **Encryption:** TLS in transit everywhere; Google-managed encryption at rest; integration credentials encrypted with Cloud KMS and never readable by the browser.
- **Separation:** every firm's data sits under its own organisation, and every read and write is checked against the user's firm, role and active membership.
- **Access:** role-based access (owner, admin, lawyer, paralegal, read-only), with privileged material hidden from read-only roles; two-step sign-in that your firm can require; session time limits, an idle timeout, remote sign-out, and a fresh sign-in for sensitive actions such as exports and role changes.
- **Audit:** an append-only audit log of changes to your firm's data, kept for seven years.
- **Uploads:** files are scanned for malware before anyone else can open them.
- **Logging:** our technical logs and error reports contain ids, never names, emails or document text.
- **Resilience:** point-in-time recovery for seven days, daily backups and exports in a second Australian region, and restore drills each quarter.
- **Application security:** a strict content security policy, App Check bot protection, dependency and code scanning, and an external penetration test before general launch [SEC-02].

## 5. Sub-processors

5.1 Your firm authorises the sub-processors on the [Sub-processor list](subprocessors.md). We remain responsible for the sub-processors we engage and impose obligations on them that protect client information at least as well as this DPA.

5.2 We will give your firm at least [30] days' notice, in Materia and by email to its owner, before adding or replacing a sub-processor that handles client information. If your firm reasonably objects, we will work with it in good faith; if we can't resolve the objection, your firm may end the agreement and receive its data as in section 10.

5.3 Integrations your firm or its users choose to connect (such as Xero, Microsoft 365 or Google Workspace), and the AI provider your firm configures for Clerk, are services your firm engages under its own agreements. We send them only what your firm's configuration directs, and they are listed for transparency.

## 6. Cross-border disclosure (APP 8)

6.1 We keep client information in Australia, except:

- **email notifications**, sent through Resend, Inc. in the United States: the recipient's address and the email's subject and body. Subjects never contain matter details and emails never contain privileged content;
- **Google's global services** that Materia depends on (sign-in, bot protection, push notifications and feature settings), which handle account and device information rather than client files; and
- **what your firm directs**: Clerk requests to the AI provider your firm configures (currently Anthropic, outside Australia), and data sent to integrations your firm connects.

6.2 For the first two, we take reasonable steps to ensure the recipient does not breach the APPs. For the third, the disclosure is your firm's, made under its own agreement with the provider, and your firm is responsible for telling its clients about it where the APPs require. [Reviewer: confirm the APP 8 analysis for the firm-directed disclosures.]

## 7. Data breaches

7.1 We will notify your firm's owner **within [72] hours** of becoming aware of a data breach, or a suspected data breach, affecting your firm's data. [Reviewer: 72 hours is a placeholder.] The notice will say, as far as we know at the time, what happened, when, what information and which people may be involved, what we have done to contain it, and who to contact. We will update it as we learn more.

7.2 We will help your firm assess whether the breach is an eligible data breach under the Notifiable Data Breaches scheme, within 30 days of becoming aware of it, and give it what it needs to notify the OAIC and affected individuals. Unless your firm and we agree otherwise, your firm notifies its clients and others whose client information is involved, and we notify individuals whose user account information we hold. Where both of us hold the information, one assessment and one notification, by agreement, can satisfy both of us. [Reviewer: confirm the joint-entity provisions in Part IIIC of the Privacy Act, including ss 26WJ and 26WM.]

7.3 We will not tell your firm's clients or the OAIC about a breach of your firm's data without first consulting your firm, unless the law requires us to.

7.4 Our process is in our data breach response plan, which we will share with your firm on request.

## 8. Helping your firm

8.1 Materia lets your firm find, correct, export and delete client information, so it can answer access and correction requests (APPs 12 and 13). If someone asks us directly about client information your firm holds, we will refer them to your firm.

8.2 We will give your firm reasonable information and help with privacy impact assessments, regulator inquiries and audits about Materia. [Reviewer: audit rights, frequency and cost.]

## 9. Legal requests

9.1 If a court, regulator or law enforcement agency asks us for your firm's data, we will refer it to your firm where we can, tell your firm promptly unless the law prevents us, disclose only what we are legally required to, and claim privilege on your firm's behalf where it may apply.

## 10. Return and deletion

10.1 During the agreement your firm can export its data and delete matters under its own retention settings, as described in the [Retention policy](retention-policy.md).

10.2 When the agreement ends, your firm has 30 days to export its data, or to ask us for an export. We then delete it from the live service within [30] days, except for anything under a legal hold your firm has placed or that the law requires us to keep. Copies in backups expire on the schedule in the retention policy (at most about 13 months for the monthly backup copies), are kept secure in the meantime, and are never restored into the live service. We will confirm the deletion in writing on request.

## 11. General

11.1 This DPA continues for as long as we hold any of your firm's data. If it conflicts with the terms of service on the handling of client information, this DPA prevails.
