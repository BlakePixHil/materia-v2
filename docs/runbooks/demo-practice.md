# The demo practice on dev

A ready-to-show practice on dev for demos: **Harbour & Vine Legal**, the fictional Geelong wills and estates firm the local seed uses, with a year and a half of history. Everything in it is invented (Victorian law, Geelong suburbs, made-up people and grant numbers); it never holds real client data, so the `dev-script` workflow may load it (D-23 keeps CI runners away from real data, not from this).

## Sign in

- https://materia-v2-dev.web.app as **`demo@harbourvine.example`** (Priya Shah, owner). The other roles: `demo.lawyer@`, `demo.paralegal@` and `demo.readonly@harbourvine.example`, same password.
- The password is the Secret Manager secret **`demo-login-password`** in `materia-v2-dev` ([console](https://console.cloud.google.com/security/secret-manager/secret/demo-login-password/versions?project=materia-v2-dev), or `gcloud secrets versions access latest --secret demo-login-password --project materia-v2-dev`). The first load creates it with a random value; resets keep it. To change it, add a new version and run the reset.
- `.example` is a reserved domain that takes no mail, and the accounts are marked undeliverable, so nothing is ever emailed to them. MFA is off for the org.

## What's in it

- 39 matters: the seed's twelve (every type and status, the Doyle probate with its estate register, deadlines from the rules engine and Clerk threads and suggestions), the six conflict-check scenarios, and 21 closed wills, powers of attorney and estates opened over the past 18 months.
- Time on every matter (drafts, approved and billed), disbursements, fee arrangements and budgets, costs disclosures, notes, tasks, documents (sample PDFs, ingested for Clerk) and the safe custody register.
- 36 issued invoices numbered `INV-000001` on, with payments (EFT, card, from trust with the r 42(3) notice), one part paid, one current and one overdue with a payment reminder to send; their PDFs are in each matter's documents. Today's aged debtors.
- Insights from the first matter on (`backfill-metrics --from earliest` for the org).
- A few notifications for Priya.
- Org flags (they win over Remote Config): everything the seed turns on, plus `clerk.enabled`, `clerk.features.chat`, `suggestions`, `classification`, `insightsNarrative`, `billing.invoicing` and `billing.trustNotice`. Left off: the daily brief, litigation, intake prefill, will extraction, time assist, integrations and mobile voice. Change the list in `DEMO_FLAGS` (`tools/scripts/src/seed/demo.ts`).

Dates are relative to the day it's loaded, so something is always due today. Clerk answers new questions for real (it costs tokens, like any org's use).

## Reset it

Actions → **dev-script** → Run workflow on `main`:

1. command `demo-reset`, dry run on: check the log (it refuses if an account or the org isn't the demo's, or anyone else was added as a member).
2. The same with dry run off. It takes about 10 to 20 minutes: it deletes the org, its files and the accounts' user documents, waits for the delete triggers to settle, loads the practice, renders the invoice PDFs and restates Insights, then checks every document and the accounts' claims.

Don't run it while a `deploy-dev` run is in progress: both use the Cloud Run CPU quota. Anything changed during a demo is gone after a reset.

- `args: --verify` (dry run off) checks it without changing anything, and reports where the invoice PDFs are (invoices by PDF status, their jobs by status, and the first few jobs that haven't finished).
- `args: --pdfs` (dry run off) starts again the invoice PDF renders that didn't finish, waits a few minutes and reports; with dry run on it only reports.
- `args: --remove` deletes the demo (org, files, accounts); the secret stays.

Locally: `pnpm materia-scripts demo-reset --project demo-materia` with the emulators running (the seed password). `nx run scripts:test-seed` runs it twice and verifies it.

## Measure a page with Lighthouse

Actions → **dev-script** → Run workflow on `main`, command `demo-lighthouse`, dry run off (MOB-02b). It signs in as the demo owner in a headless Chrome on the runner and runs mobile Lighthouse (simulated throttling, 4× CPU) on Today five times, keeping the browser's storage between runs as a signed-in person's phone would. The job summary has every run, the median, where its main thread went and which other sites it called (Auth, App Check, Firestore, reCAPTCHA); the run's `lighthouse-<run id>` artifact has the reports. It also says whether App Check had a valid saved token when the runs began: without one, each run starts by running reCAPTCHA, which a returning person's phone skips while its token is less than about six hours old.

- `args: --path /matters --runs 7` for another page or more runs; `--account lawyer` (or `paralegal`, `readonly`) for another role.
- `args: --url https://materia-v2-dev--pr-123-abc.web.app` measures a PR's preview channel (the URL from its preview comment) against dev's data, before it merges.
- With dry run on it only signs in, opens the page and reports App Check's saved token.
- App Check: a headless Chrome scores too low with reCAPTCHA to get an App Check token itself, so by default (`--app-check saved`) the run registers an App Check debug token on dev, signs in with it, and removes it before Lighthouse starts. The runs then start with a saved token, as a phone that passed reCAPTCHA in the last few hours does. `args: --app-check none` measures a start-up without one, which runs reCAPTCHA first (a phone's first visit after its token expired). The debug token is never printed; a failed run's token is removed by the next run.

The runner is in the US, so dev's data is a long way off; compare runs with each other rather than with a phone in Australia. Locally: `pnpm materia-scripts demo-lighthouse --project demo-materia` after `demo-reset`, with the e2e build on the Hosting emulator.
