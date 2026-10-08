# Cost model: a target-scale firm, per month (SEC-07, SEC-07h)

What one firm at SEC-07's target scale costs to run each month: 50 members, 10,000 matters, 500,000 documents and 2 million time entries. The model splits what Materia's Google Cloud project pays from what the firm pays Anthropic for Clerk (BYOK, [ADR-011b](../adr/ADR-011b-clerk-byok.md)). It also covers the per-deploy cost that every firm shares.

- **Prices:** USD list prices for `australia-southeast1` (backups: `australia-southeast2`), read on **2026-10-07** from the Google Cloud pricing pages for [Firestore](https://cloud.google.com/firestore/pricing), [Cloud Storage](https://cloud.google.com/storage/pricing), [Cloud Run](https://cloud.google.com/run/pricing), [Cloud Tasks](https://cloud.google.com/tasks/pricing), [Cloud Build](https://cloud.google.com/build/pricing), [Artifact Registry](https://cloud.google.com/artifact-registry/pricing), [Identity Platform](https://cloud.google.com/identity-platform/pricing) and [Vertex AI](https://cloud.google.com/vertex-ai/generative-ai/pricing). No discounts. Free tiers are left out, because they are per project or per billing account, and every firm shares them.
- **Clerk token prices:** from ADR-011b and [docs/07](../07-clerk-ai.md).
- **Measured inputs:** reads per screen from the SEC-07 reads spec, and document sizes from the seeded practice's emulator export. Both are in [perf-report-2026-10.md](perf-report-2026-10.md).
- **Everything else** is a stated assumption. The model is a script (`model.py` in the SEC-07 outputs), so a changed assumption is one edit and a re-run.
- **When to refresh:** when a price, the backup design or a screen's reads change, or once production billing data exists. Then replace the assumptions with the billing export.

## Summary

| Per month, one target-scale firm | Clerk ingestion off | Clerk ingests every document |
| -- | --: | --: |
| Running the app: Firestore reads, writes, storage and egress; Functions; Tasks; document storage and downloads; embeddings | **≈ US$20** | **≈ US$27** |
| Backups (SEC-03): nightly export reads, PITR, managed backups, export storage and the copy to Melbourne | **≈ US$69** | **≈ US$115** |
| **Materia's Google Cloud bill for the firm** | **≈ US$90** | **≈ US$142** |
| Clerk tokens, paid by the firm to Anthropic (BYOK): default model / opt-in model | ≈ US$517 / ≈ US$987 | same |
| Shared by all firms: rebuilding every function on each deploy (dev and prod) | ≈ US$170–200 | same |

What the model shows:

- **Using the app is cheap.** The four key screens cost about US$1.50 a month in reads for the whole firm, and all Firestore reads and writes by people and functions come to about US$3.50.
- **Backups are most of the bill**, and they grow with the data, not with use:
  - The nightly export (SEC-03) is billed one read per document. At about 4 million documents that is 122 million reads a month, about 20 times what the firm's people read.
  - Each export is then kept 35 days in Melbourne (13 monthly copies for 400 days) and copied there across regions every night.
  - Clerk's ingest chunks carry 768-dimension vectors, so they are most of the bytes in the database once every document is ingested. With them in the export, the backup line tripled (US$213 a month).
  - Since SEC-07h the export leaves the chunks out: they are rebuilt from the documents after a restore from an export ([restore runbook](../runbooks/restore.md#clerks-search-chunks)). That takes about US$98 a month off, so Clerk now adds about US$46 to the backup line, all of it PITR and the managed backups, which can't leave a collection out. Rebuilding after a restore costs about US$150 in embeddings for all 500,000 documents, plus OCR of scanned pages on the firm's Clerk key; only a restore from an export needs it.
  - The export still runs every night: see [Export cadence](#export-cadence).
- **Clerk is the largest cost for a firm that uses it, and the firm pays it.** The default model costs half as much as the opt-in one on input and output; cached input is the same price on both.
- **Deploys are the largest fixed cost.** On today's cadence, the per-deploy function rebuild costs more than a whole target-scale firm. It is per project, not per firm, so it shrinks per firm as firms are added.

## Prices used (USD, 2026-10-07)

| Item | Price | Region |
| -- | -- | -- |
| Firestore document reads | $0.038 per 100,000 | australia-southeast1 |
| Firestore writes / deletes | $0.115 / $0.013 per 100,000 | australia-southeast1 |
| Firestore stored data | $0.115 per GiB-month | australia-southeast1 |
| Firestore PITR data / backup data | $0.2025 / $0.038 per GiB-month | australia-southeast1 |
| Firestore egress to Australian destinations | $0.19 per GiB (first 10 GiB a month free per project) | |
| Cloud Storage Standard | $0.023 per GiB-month | australia-southeast1 and australia-southeast2 |
| Cloud Storage Class A / Class B operations | $0.005 / $0.0004 per 1,000 | regional bucket |
| Cloud Storage copy between Oceania regions | $0.08 per GiB | southeast1 → southeast2 |
| Cloud Storage egress to Australian destinations | $0.19 per GiB | |
| Cloud Run request-based billing (2nd gen functions) | $0.0000336 per vCPU-second, $0.0000035 per GiB-second, $0.40 per million requests | australia-southeast1 |
| Cloud Run instance-based billing (not used) | $0.0000216 per vCPU-second, $0.0000024 per GiB-second | australia-southeast1 |
| Cloud Tasks | $0.40 per million operations (first million free per billing account) | |
| Cloud Build, default pool | $0.0075 per build-minute for e2-standard-2 in australia-southeast1 ($0.006 global); 2,500 free build-minutes per billing account | |
| Artifact Registry storage | $0.10 per GiB-month over 0.5 GiB | |
| Identity Platform, email sign-in | free to 50,000 monthly active users | |
| Vertex text embeddings | $0.000025 per 1,000 characters (online) | |
| Clerk tokens (ADR-011b), per million | default model: $2 input, $10 output, $0.20 cache read; opt-in model: $4 input, $20 output, $0.20 cache read | Anthropic, global |

Firestore committed-use discounts (1-year: reads $0.0304, writes $0.092) take about 20% off the Firestore lines once usage is steady.

## The firm and its data

| Quantity | Value | Source |
| -- | --: | -- |
| Members | 50 (1 owner, 2 admins, 25 lawyers, 17 paralegals, 5 read-only) | `seed-large` `ROLE_MIX` |
| Members active on a working day | 45 | assumption |
| Working days a month | 21 | assumption |
| Firestore documents seeded | 2,715,101 | `materia-scripts seed-large --scale 1 --dry-run` |
| Documents the seed doesn't write (audit, activity, notifications, ledgers, idempotency) | +50%, so about 4.07 million in all | assumption |
| Bytes per document in an export | 772 | measured: 105 MB export for 136,091 documents (scale 0.05) |
| Billed bytes per document, with index entries | about 1,930 (2.5× the export bytes) | assumption |
| Firestore storage without chunks | 7.3 GiB | derived |
| Clerk chunks if every document is ingested | 2.2 million (4 pages a document, 1.1 chunks a page) | assumption |
| Bytes per chunk, with its two vector index entries | about 22,000 (text 3.2 kB, vector 6.1 kB, two indexes) | derived from the chunk schema |
| Firestore storage with chunks | 52.9 GiB | derived |
| Document files | 196 GiB (350 kB average, +20% for previews, renditions and old versions) | assumption |

Monthly activity, taken as one 96th of the eight years the seed spans:

| Activity | Per month | Writes |
| -- | --: | --: |
| Time entries | 20,800 | 208,000 (entry, edits, review, billed flag, rollups, fee budget, audit) |
| New matters | 104 | 6,250 |
| New documents | 5,200 | 73,000 (plus 22,900 chunk writes when Clerk ingests) |
| Everyday work: tasks, deadlines, notes, contacts, invoices, notifications, recents | 120 writes a member-day | 113,000 |
| **All writes** | | **≈ 424,000** |

## Reads

Reads are where a careless screen would show up, so they are modelled screen by screen. "Per load" is the measured count from the reads spec, at scale 0.05 for the full-load fee earner with the firm's 50 members. The counts at the target scale are the same except on Deadlines, whose per-row matter lookups grow from 136 to up to 500 (about 1,050 a load, another US$0.26 a month here); see the perf report.

| Screen | Loads per member-day | Reads per load | Reads per member-day |
| -- | --: | --: | --: |
| Today, page load (shell included) | 1 | 78 | 78 |
| Today, from another screen | 8 | 75 | 600 |
| Matters list | 6 | 165 | 990 |
| A matter | 20 | 63 | 1,260 |
| Deadlines | 2 | 688 | 1,376 |
| Other screens (time, documents, contacts, billing, search) | 25 | 40 (assumed) | 1,000 |
| Listener updates (colleagues' changes arriving) | | | 150 |
| Security rules' `get()` of the membership and matter, about 1.5 per request (not seen by the client counter) | | | 1,134 |
| **Per active member-day** | | | **≈ 6,590** |

- **People:** 6,590 × 45 × 21 ≈ **6.2 million reads**, about **US$2.40** a month. Deadlines is a fifth of it. Its follow-up ("Window the Deadlines page and denormalise matter fields onto deadlines") would take about US$0.35 off at this scale, and more for firms that live on that page. The firm's 50 member documents are read by the Matters list, a matter and Deadlines alike; that counts each listener as new, though Firestore bills a listener resumed within 30 minutes only for what changed, so these screens are upper bounds.
- **Functions:** transactions, triggers and rollups read about 2.5 documents per write, about 1.06 million. Scheduled jobs (reminders, digests, debtors, sweeps) read about 600,000. Together about **US$0.63**.
- **Nightly export:** one read per document per night, about 122 million reads. That is **US$46**. With the chunks it was 188 million reads, US$72; the export leaves them out since SEC-07h.

## Monthly estimate, line by line

| Line | Clerk ingestion off | Clerk ingests everything | How it's derived |
| -- | --: | --: | -- |
| Firestore reads: people | 2.37 | 2.37 | 6.2 million reads |
| Firestore reads: functions and scheduled jobs | 0.63 | 0.63 | 1.66 million reads |
| Firestore reads: nightly export | 46.43 | 46.43 | one read per document but chunks, 30 nights |
| Firestore writes and deletes | 0.46 | 0.49 | 424,000 writes, deletes at 5% |
| Firestore storage | 0.84 | 6.08 | 7.3 / 52.9 GiB |
| Firestore PITR (7 days) | 1.48 | 10.71 | about the database size |
| Firestore managed backups (7 daily, 14 weekly) | 5.84 | 42.19 | 21 copies of the database size |
| Firestore egress to browsers | 1.32 | 1.32 | 6.9 GiB (before the project's 10 GiB free) |
| Storage: document files | 4.50 | 4.50 | 196 GiB |
| Storage: exports bucket (8 nights kept) | 0.54 | 0.54 | 8 exports of 2.9 GiB (no chunks) |
| Storage: backups bucket (35 daily, 13 monthly exports, plus the files copy) | 7.73 | 7.73 | 48 exports plus 196 GiB |
| Storage: nightly copy to australia-southeast2 | 7.19 | 7.19 | 30 exports plus new files, at $0.08 per GiB |
| Storage: operations | 0.17 | 0.17 | uploads, renditions, downloads |
| Storage: downloads to browsers | 1.76 | 1.76 | 30 documents per member-day at 350 kB |
| Functions (Cloud Run, request-based) | 8.31 | 8.31 | 650,000 invocations (about 1.2 per write, plus callables), about 228,000 vCPU-seconds |
| Cloud Tasks | 0.01 | 0.01 | 28,000 operations |
| Vertex embeddings for new documents | 0 | 1.56 | 5,200 documents × 4 pages × 3,000 characters |
| **Total** | **≈ 89.58** | **≈ 141.99** | |

Before SEC-07h the export took the chunks too: in the right-hand column, its reads were US$71.51, the exports bucket US$4.17, the backups bucket US$29.54 and the copy US$54.61 (22.7 GiB an export), for a total of about US$240.

### Export cadence

The export could run less often than nightly (`EXPORT_EVERY_DAYS` in `apps/functions/src/backups/export.ts`; the export on the 1st always runs, and a night it skips still logs `ok` for the alert). PITR (7 days) and the daily managed backups already cover the database's own region, so the export adds two things: the copy in another region, and restore points beyond the managed backups (daily for 35 days, then monthly for 400). Its cost per month at the target scale, chunks left out:

| Export every | Exports a month | Reads | Copy | Storage | Total | Restore point if the region is lost, and 8 to 35 days back |
| -- | --: | --: | --: | --: | --: | -- |
| night (now) | 30 | 46.40 | 7.03 | 3.77 | **≈ US$57** | 24 hours |
| 2 days | 16 | 24.75 | 3.75 | 2.33 | ≈ US$31 | 2 days |
| 3 days | 11 | 17.01 | 2.58 | 1.84 | ≈ US$21 | 3 days |
| week | 5 | 7.73 | 1.17 | 1.29 | ≈ US$10 | a week (the same as the weekly managed backups, in-region) |

**Decision (SEC-07h): keep it nightly.** About US$57 a month buys a 24-hour restore point outside the region and for the five weeks after PITR, which a law firm's records want more than the saving. Revisit when one database's export reads pass US$100 a month (about 8.8 million documents, twice the target scale) in the billing report, or if the owner prefers the saving. Changing it is the one constant, plus the RPOs in the [restore runbook](../runbooks/restore.md).

The largest backup line left for a firm that uses Clerk is the managed backups (US$42 a month, 21 copies of the database with its chunks); Firestore's backup schedules can't leave a collection out either, so the lever there is the weekly backups' 14 weeks.

The invocations follow the writes because most writes set off triggers. In the load tests, creating a matter set off about 52 trigger invocations for its 60 or so writes (audit, activity, metrics, search and conflict triggers). A Clerk message set off about 8, six of them `audit-onOrgWrite` on the thread, rate-limit, meter and idempotency documents, which it then skips.

Not included, and all small: Hosting (a deploy's changed chunks for 50 people are well inside Hosting's free transfer; the Firebase pricing page could not be fetched from the build environment, so check it), Identity Platform (free under 50,000 monthly active users; SMS second factors would be extra), Performance Monitoring and Remote Config (no charge), Cloud Logging (within the free 50 GiB per project unless debug logging stays on), and the document services and Cloud Run jobs (CORE-12a, FND-24), which run per upload and per PDF and scale to zero.

## Clerk tokens (BYOK: the firm pays Anthropic)

Under ADR-011b each firm brings its own Anthropic key, so tokens are on the firm's Anthropic bill, not Materia's. A firm still wants the number before it turns Clerk on. ADR-011a costed a 10-lawyer firm. Scaled to the 28 people who run matters here (owner, admins and lawyers) at the same per-person volumes, on global endpoints:

| Feature (ticket) | Calls a month | Default model | Opt-in model |
| -- | --: | --: | --: |
| Chat panel (AI-06) | 8,820 | $312 | $586 |
| Suggestions (AI-07) | 5,600 | $96 | $186 |
| Time capture assist (AI-11) | 2,940 | $30 | $60 |
| Daily brief (AI-09) | 588 | $22 | $43 |
| Drafting (AI-10) | 336 | $21 | $41 |
| Document classification (AI-04) | 1,120 | $17 | $34 |
| Will extraction (AI-08) | 70 | $10 | $20 |
| Chronology (LIT-06) | 17 | $7 | $14 |
| Orders extraction (LIT-04) | 28 | $2 | $4 |
| Insights narrative (INS-04) | 22 | <$1 | $1 |
| **Total** | | **≈ $517** | **≈ $987** |

- Paralegals using the chat panel would add to this.
- OCR of scanned pages (Clerk vision, AI-04) and the one-off ingestion of a migrated firm's documents are extra.
- Budgets and per-user limits (AI-02, AI-13) cap the spend.
- The ops dashboard's "Clerk spend per hour by feature (USD)" chart shows the real figure.

## Shared by every firm: deploys

Every deploy rebuilds every function: about 200 Cloud Run services, each built by Cloud Build. AGENTS.md and the [deploy runbook](../runbooks/deploy.md) call this most of the Google Cloud bill today, which is why daytime dev deploys are held to one every two hours. Cost per month:

```
deploys a month × functions × build-minutes per function × price per build-minute
```

- At about 120 dev deploys and 8 prod deploys a month, 203 functions and about one build-minute each, that is about 26,000 build-minutes.
- After the 2,500 free minutes, at $0.0075 (Sydney) that is **US$170–200 a month**. Each extra deploy costs about US$1.50.
- Artifact Registry holds a new image per function per deploy. The cleanup policy keeps that to a few GiB, at about US$0.10 per GiB-month.

Three things lower it, all outside SEC-07:

- deploy only the functions whose code changed;
- deploy dev less often;
- group functions into fewer services.

The build-minutes per function is the least certain input: read the "Cloud Build" SKU in the billing report for a month and replace it.

## Checking the model against production

- **Reads and writes:** the ops dashboard's "Firestore reads" and "Firestore writes and deletes" charts (`firestore.googleapis.com/document/read_count` and `write_count`), and the billing report filtered to Firestore. The export (`backups-exportFirestore`, 02:00 Melbourne) is billed as reads but may not appear in `read_count`. Compare the billing report's Firestore read SKU with the dashboard total to see its share.
- **Storage, backups and copies:** the billing report by SKU, as Firestore "Backup data", "PITR data", Cloud Storage "Standard Storage Sydney/Melbourne" and "Network Data Transfer within Oceania".
- **Functions:** the dashboard's "Invocations by service" and the billing report's Cloud Run CPU and memory SKUs.
- **Clerk:** the dashboard's spend chart; the firm sees the same on its Anthropic console.
