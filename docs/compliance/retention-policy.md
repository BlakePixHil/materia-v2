---
key: retention
title: Retention and destruction policy
summary: How long Materia keeps each kind of information, how a firm's closed matters are destroyed, and how deletion works with backups.
version: 1.0
effective: 2026-10-08
status: final
order: 6
---

# Retention and destruction policy

Each firm decides how long it keeps its client files, under its professional obligations. Materia applies the firm's choices, keeps everything else only as long as it is needed, and makes destruction deliberate and recorded.

## Client matters

- **Closed matters are kept for the firm's retention period: 7 years after closing by default.** The firm's owner or an administrator can lengthen the period (Settings → Practice); it can't be set below 7 years. When a matter closes, Materia records the date it becomes due for destruction; a later change to the period only ever moves that date later.
- **Closed matters become read-only** 90 days after closing.
- **Some matters are never dated for destruction** until a person decides: wills and powers of attorney whose originals are in safe custody, matters involving a minor, and matters under a legal hold. A legal hold also stops any destruction already scheduled.
- **Nothing is destroyed automatically.** Each month Materia lists the matters that have reached their date. An owner or administrator approves each one individually, after confirming their identity. Destruction then removes the matter's records and files from the live service and issues a destruction certificate. A tombstone (the matter number and dates) and the audit trail are kept.
- Matter destruction stays switched off until a practitioner has signed off the retention rules (CORE-19a).

## Original wills

Original wills, codicils and powers of attorney held in the firm's safe custody are kept **indefinitely** while the firm holds them. The safe custody register keeps each packet's chain of custody, and a packet is released or destroyed only with an authority document and the approval of a lawyer (a second lawyer confirms a destruction).

## Other records

| Information | How long |
| --- | --- |
| Audit log of changes to a firm's data | 7 years from each change (it follows the firm's retention period, 7 years by default) |
| Users' sign-in history | 90 days |
| In-app notifications | 90 days |
| Clerk's suggestions that nobody acted on | Marked expired after 14 days, then kept with the matter. Accepted suggestions become the firm's records |
| Clerk conversations and document search indexes | Kept with the matter and destroyed with it |
| Exported files (CSV, PDF and zip exports) | 7 days |
| Unsent new-matter drafts | 30 days after the last change |
| Pending invitations | Expire after 7 days |
| Technical logs and error reports (ids only, no personal information) | About 30 days |
| Data imported from the previous version of Materia (migration files) | 90 days after the import |
| Users' accounts | Until the firm removes the user, or the agreement ends |

## When the agreement ends

When a firm stops using Materia it has 30 days to export its data. We then delete it from the live service, except anything under a legal hold the firm has placed or that the law requires us to keep, as set out in the [Terms of service](terms-of-service.md) and the [Data processing addendum](dpa.md).

## Backups and deletion

Materia keeps backups so that a firm's data survives an accident or an outage. They are stored in Australia, encrypted, and reachable only by the people who run restores.

| Backup | Kept for |
| --- | --- |
| Point-in-time recovery of the database | 7 days |
| Daily database backups | 7 days |
| Weekly database backups | 14 weeks |
| Daily database exports (Melbourne) | 35 days |
| Monthly database exports (Melbourne) | 400 days (about 13 months) |
| Deleted or replaced files | 30 days (deleted) and 90 days (replaced versions) |
| Nightly copy of files (Melbourne) | The current copy, plus anything it replaced or deleted for 35 days |

Deleting or destroying information removes it from the live service at once. **Copies already in backups are not edited; they expire on the schedule above**, so a destroyed matter has left every backup within about 13 months. Until then the copies stay encrypted and unused. Backups are used only to recover from a disaster or to restore a matter that was damaged; a destroyed matter is never restored, and after any full restore we apply again every destruction made since the backup was taken. Destruction certificates say so.

## Changes

We publish changes to this policy here with a new version number and date.
