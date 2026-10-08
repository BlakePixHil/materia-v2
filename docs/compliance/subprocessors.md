---
key: subprocessors
title: Sub-processor list
summary: Every service provider that handles personal information for Materia, what for, what information and where.
version: 1.0
effective: 2026-10-08
status: final
order: 5
---

# Sub-processor list

These are the service providers that handle personal information for Materia. The [Data processing addendum](dpa.md) explains how we choose them, the notice we give before a change, and how a firm can object. The [Privacy policy](privacy-policy.md) explains the rest.

## Engaged by us for every firm

| Provider | What it does for Materia | Information it handles | Where |
| --- | --- | --- | --- |
| Google Cloud and Firebase (Google LLC and its affiliates, including Google Australia Pty Ltd) | Hosting, database (Cloud Firestore), file storage, server functions and task queues, malware scanning and document previews (Cloud Run), document search indexing (Vertex AI embeddings), encryption keys (Cloud KMS) and secrets, backups | All of Materia's data: users' accounts and every firm's client information, documents and notes | Australia: Sydney (`australia-southeast1`) for the live service, Melbourne (`australia-southeast2`) for backups |
| Google (the same entities): global Firebase services | Sign-in and two-step sign-in (Identity Platform), bot protection (App Check with reCAPTCHA Enterprise), push notifications (Firebase Cloud Messaging), feature settings (Remote Config), and technical logs and error reports (Cloud Logging and Error Reporting) | Users' names, email addresses, protected passwords and sign-in events; browser and device signals; push tokens and notification titles; technical logs that contain ids, not names or document text | Google's global infrastructure, including the United States |
| Resend, Inc. (United States) | Sending email notifications, such as invitations, reminders and daily digests | The recipient's email address and the email's subject and body. Subjects never contain matter details; emails never contain privileged content | United States |

## Engaged by a firm, used only at its direction

A firm's owner, an administrator or a user chooses to turn these on. Materia sends them only what the firm's configuration directs, under the firm's own agreement with the provider. We list them so firms and their clients can see where information goes.

| Provider | When it is used | Information it receives | Where |
| --- | --- | --- | --- |
| Anthropic, PBC (United States): the AI provider for Clerk | When a firm saves its own Anthropic API key and turns Clerk on. Clerk runs under the firm's own Anthropic account and terms; Materia's servers relay each request | For each Clerk request: the question or task, the matter's key facts, and the relevant parts of documents and notes (or a document page that needs reading), only from matters the person asking can open | Outside Australia: requests are routed globally and Anthropic stores account data in the United States |
| Xero Limited (New Zealand) | When a firm connects Xero, to send it invoices and receive payments | Issued invoices and credit notes, and the billed client's name, email address and postal address | Xero's hosting, in the United States |
| Microsoft Corporation (Microsoft 365) | When a user connects their Microsoft 365 account (planned) | What the connected feature needs, such as deadlines and court dates sent to the user's calendar | The firm's Microsoft 365 tenant location |
| Google LLC (Google Workspace and Google sign-in) | When a user signs in with Google, or connects their Google Workspace account (planned) | For sign-in, the user's Google account email and name. For Workspace, what the connected feature needs, such as deadlines sent to the user's calendar | Google's global infrastructure |

## Changes

We publish every change to this list here with a new version number and date, and give firms at least 30 days' notice before a new sub-processor handles their client information.
