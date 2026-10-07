# Runbook: migration rehearsals and cutover (MIG-07)

How Tristan Burke's legacy data moves into Materia v2 for real: rehearsals on dev that he reviews and accepts, a final rehearsal the day before, then the cutover to prod and the 90 days after it ([plan](../08-legacy-migration-plan.md#rehearsal--cutover), [decision D-23](../migration/decisions.md#d-23-rehearsals-and-cutover-new)). Each step has its own runbook; this one puts them in order and adds what happens between them.

**Who:**

- **The operator** runs the commands, in Cloud Shell, as an owner of the target v2 project who can impersonate the legacy reader.
- **Tristan** (the user) reviews his data on dev and accepts it, stops using legacy at cutover, and signs in to prod.
- **Blake** agrees the date with Tristan, grants access in the legacy project, and approves anything that deletes data in prod or changes legacy.

**Rules for every session:**

- **Nothing writes to legacy.** Every legacy read goes through `legacy-migration-reader`, and every tool checks with IAM that it can't write before it reads. The copy reads the legacy bucket server side and never writes to it.
- **Real data stays in Google Cloud, in Australia.** Run the steps in Cloud Shell, never on a laptop, an agent or a CI runner. Reports hold legacy paths and counts only, but they are still about his practice: they go on the ticket or in project files, never in the repo or a chat.
- **Dev keeps none of it** (D-15, D-23). Each rehearsal is rolled back and its run deleted, along with the dev backups taken while it was there ([Clean up a dev rehearsal](#clean-up-a-dev-rehearsal)).
- **Keep the command log** ([Command log](#command-log)). It is the evidence that nothing wrote to legacy.

## The steps

| # | Step | Command (`pnpm materia-migrate …`) | Runbook |
| -- | -- | -- | -- |
| 0 | Check the accounts | `preflight --env <env>` | [Preflight](#preflight) |
| 1 | Export | `export --profile <profile> --env <env> --run-id <runId>` | [migration-export.md](migration-export.md) |
| 2 | Transform | `transform --run <runId> --profile <profile> --target-org new --env <env>` | [migration-transform.md](migration-transform.md) |
| 3 | Copy the files | `copy-files --run <runId> --env <env>` | [migration-copy-files.md](migration-copy-files.md) |
| 4 | Import the account | `auth-import --target materia-v2-<env> --profile <profile>` | [migration-auth-import.md](migration-auth-import.md) |
| 5 | Load | `load --run <runId> --env <env>` | [migration-load.md](migration-load.md#load) |
| 6 | Verify | `verify --run <runId> --env <env>` | [migration-load.md](migration-load.md#verify) |
| 7 | Clerk reads the files, and Insights gets its history | An owner approves in Settings → Clerk and AI; `pnpm materia-scripts backfill-metrics` | `migration-enrichment.md` (MIG-09) |
| 8 | Review | Tristan, in Settings → Import from materia | [D-22](../migration/decisions.md#d-22-in-app-review-new) |

The profile is `tools/migration/profiles/tristan-burke.json`. Exit codes, stops and re-runs are in each step's runbook: every step can be run again and picks up where it stopped.

## Set up Cloud Shell

Once per session, in [Cloud Shell](https://shell.cloud.google.com) signed in as the operator:

```sh
tmux new -A -s mig07                         # a closed tab doesn't stop a step
nvm install 22 && corepack enable            # the repo pins Node 22 and pnpm 10
git clone https://github.com/BlakePixHil/materia-v2.git && cd materia-v2   # private: a GitHub token as the password
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install --frozen-lockfile
script -a ~/mig07-$(date -u +%Y%m%d).log      # the command log; `exit` ends it
export MIG_ENV=dev PROFILE=tools/migration/profiles/tristan-burke.json
gcloud config set project materia-v2-$MIG_ENV
```

- Cloud Shell's Application Default Credentials are already the operator's, which the load, verify and rollback use. Cloud Shell has no proxy, so `NODE_USE_ENV_PROXY` isn't needed.
- On a later day: `tmux new -A -s mig07`, `cd materia-v2 && git pull && pnpm install --frozen-lockfile`, then `script` and the exports again.

## Preflight

```sh
pnpm materia-migrate preflight --env $MIG_ENV
```

It asks IAM whether each account can do its steps, and reads the target's sign-in config. It reads no record, file or account, so it is safe to run any time. Exit 0 prints `Ready`; exit 5 lists each failed check with the grant that fixes it.

| Check | Account | Needs |
| -- | -- | -- |
| act as the writer | you | prod only: Token Creator on `migration-runner` |
| act as the legacy reader | you | Token Creator on `legacy-migration-reader` (in `matt-r-1fe15`) |
| legacy reader is read-only | the reader | reads Firestore, Storage and Auth in legacy, writes nothing |
| write the run | the writer | object admin on `materia-v2-<env>-migration` |
| read the legacy files | the writer | object viewer on `matt-r-1fe15.firebasestorage.app` (prod: shows `·` until the cutover grant) |
| write the files | the writer | object admin on `materia-v2-<env>-files` |
| load and roll back the run, roll back the files | you | prod only: both buckets (an owner has them) |
| call the scanner | you | `run.invoker` on `clamav` |
| import the account and load | you | Firebase Auth admin and Firestore user on the project (an owner has both) |
| Google sign-in | | Google sign-in is on in the target |

The writer is you on dev (dev has no runner account) and `migration-runner` in prod. `--adc` checks Application Default Credentials instead of gcloud's account.

### What dev has (checked from the repo, 2026-10-07)

| Need | Dev |
| -- | -- |
| Writer | Your own account: `enable_migration_runner = false` in `infra/terraform/envs/dev.tfvars` |
| The legacy reader | Only `terraform-agent` holds Token Creator on it (MIG-01). The operator needs it too: in `matt-r-1fe15`, IAM → Service accounts → `legacy-migration-reader` → Permissions → grant the operator **Service Account Token Creator**. Remove it after the cutover with the account itself |
| The legacy bucket | Your account copies from it, so it needs object read on `matt-r-1fe15.firebasestorage.app`. An owner of `matt-r-1fe15` has it. `terraform-agent` doesn't |
| Buckets, scanner, Firestore, Auth | Terraform makes `materia-v2-dev-migration` (CMEK, versioned, objects deleted after 90 days), `materia-v2-dev-files` and `clamav`; a project owner holds every permission the steps need |
| Google sign-in | On since 2026-10-04 |
| Email | Dev sends email only once Postmark is set up there. Until then Tristan gets in-app notifications only. If it is set up before a rehearsal, tell him dev may email him reminders about his real matters |
| Flags (Remote Config) | `billing_costsDisclosure` is on: imported open matters with a disclosure still needed get in-app reminders. `matters_destruction` is on: nothing is destroyed without an admin approving it. `billing_feeBudgets` is on, so budgets show. To rehearse Clerk reading the files, `clerk_enabled` and `clerk_features_suggestions` must be on, with a valid key and the disclosure acknowledged |
| Sign-in security | A migrated org requires an authenticator app after a 24-hour grace (SEC-04), so Tristan enrols one on dev if his review runs past a day. It goes with his dev account at the rollback |
| Backups | Dev's SEC-03 backups capture the rehearsal: PITR for 7 days, managed backups for 7 days (weekly ones 14 weeks), exports for 35 days (on the 1st of a month, 400), and the files copy. The cleanup deletes all but PITR, which expires on its own |

## Dry-run checklist

Before each rehearsal and before the cutover. Tick it in the session's command log.

- [ ] `preflight --env <env>` exits 0.
- [ ] The target runs main with MIG-08 and MIG-09 in it: dev deploys main; prod runs the release that carries them.
- [ ] Nothing is left from an earlier rehearsal. The org's id comes from Tristan's uid, so a leftover org would be reused. The export runbook's [cleanup record](migration-export.md#cleanup-record) shows the last rehearsal deleted, `gcloud storage ls gs://materia-v2-$MIG_ENV-migration/runs/` lists no real run, and the auth import's dry run (below) plans an import, not `nothing to do`.
- [ ] **Export dry run:** `export --profile $PROFILE --env $MIG_ENV --dry-run`. The counts match the latest MIG-01 audit, or the differences are explained (new matters since). Exit 4 means a board isn't mapped: run a fresh audit and `check-profile --report`, and fix the profile first.
- [ ] **Auth import dry run:** `auth-import --target materia-v2-$MIG_ENV --profile $PROFILE --dry-run` says `would import … with google.com (provider uids kept) and no password`.
- [ ] Email and flags on the target are as the table above says (prod: as decided for launch).
- [ ] Tristan knows the window ([templates](#messages-for-tristan)).
- [ ] Deploys are held from the load until verify passes: tell whoever deploys dev; no prod release during the cutover.

## Rehearse on dev

At least two full rehearsals, each from a fresh export, and each rolled back afterwards (D-15).

```sh
export RUN=rehearsal-$(date -u +%Y%m%dT%H%M%SZ)
pnpm materia-migrate export --profile $PROFILE --env $MIG_ENV --run-id $RUN
pnpm materia-migrate transform --run $RUN --profile $PROFILE --target-org new --env $MIG_ENV
pnpm materia-migrate copy-files --run $RUN --env $MIG_ENV
pnpm materia-migrate auth-import --target materia-v2-$MIG_ENV --profile $PROFILE
pnpm materia-migrate load --run $RUN --env $MIG_ENV --dry-run    # prints "Run … into orgs/<orgId>": note the org id
pnpm materia-migrate load --run $RUN --env $MIG_ENV
pnpm materia-migrate verify --run $RUN --env $MIG_ENV
```

Run them one at a time and read each one's output before the next; the step runbooks say what each exit code means. Note each step's start and end time in the [timings](#timings).

1. **Verify must pass.** Download its report before anything is deleted, and attach it to MIG-07 (MAT-101):

   ```sh
   gcloud storage cp gs://materia-v2-$MIG_ENV-migration/runs/$RUN/verify/verify-report.md ~/verify-$RUN.md
   ```

   Cloud Shell's ⋮ → Download saves it. It holds counts and legacy paths, no names or content.
2. **Clerk and Insights:** follow `migration-enrichment.md` (MIG-09). Tristan approves Clerk reading the files only if he wants to see it on dev: it sends his documents to the AI provider. Insights' history comes from `backfill-metrics`, which agents can run on dev through the `dev-script` workflow.
3. **Check the review queue:** Settings → Import from materia shows the run, and its open items match the transform report's `needsReview` totals.
4. **Tristan reviews.** He signs in to https://materia-v2-dev.web.app with Google and works through the review queue (the Today card "Check your import", or Settings → Import from materia). He sets the practice's real name in Settings → Practice: legacy holds the app's name (D-09). Keep the review to a week or less.
5. **Record his feedback** as Linear tickets related to MAT-101, one per problem, without client details.
6. **Clean up** ([below](#clean-up-a-dev-rehearsal)).

**Rehearsal 1:** the steps above, then Tristan's review.

**Fix round:** the feedback tickets (profile and transform fixes), each merged before the next rehearsal. A profile change needs `check-profile --report` against a fresh audit.

**Rehearsal 2:** check rehearsal 1 is gone (the dry-run checklist), then the same steps from a fresh export. Time each phase: the timings set the cutover window. If his review finds nothing new, he accepts ([template 3](#messages-for-tristan)) and the acceptance goes on MAT-101 with its date. More fixes mean another rehearsal.

### Timings

| Phase | Rehearsal 1 | Rehearsal 2 | T-1 |
| -- | -- | -- | -- |
| export | | | |
| transform | | | |
| copy-files | | | |
| auth-import | | | |
| load | | | |
| verify | | | |
| Clerk reads the files | | | |
| **total** | | | |

The cutover window is rehearsal 2's total, plus an hour for the smoke checklist, plus the same again in reserve.

## Clean up a dev rehearsal

The same day as the review ends (or the T-1 rehearsal's verify):

1. **Roll back** the load, twice, a minute apart (triggers can still be finishing):

   ```sh
   pnpm materia-migrate rollback --run $RUN --env $MIG_ENV --dry-run
   pnpm materia-migrate rollback --run $RUN --env $MIG_ENV
   sleep 60 && pnpm materia-migrate rollback --run $RUN --env $MIG_ENV
   ```

   If it refuses because Tristan made records under migrated ones, the dry run lists them. They are his test entries: tell him, delete them in the app, then roll back again.
2. **Remove his dev account:** `pnpm materia-migrate auth-import --target materia-v2-$MIG_ENV --profile $PROFILE --rollback`.
3. **Delete the run and every old version of his files.** The rollback deletes the live files; versioning keeps the old ones for 90 days:

   ```sh
   ORG=<orgId>; UID_=fen5jJdhNHTkGBpgAdsLSKQRvXx2
   gcloud storage rm --all-versions --recursive gs://materia-v2-$MIG_ENV-migration/runs/$RUN/
   gcloud storage rm --all-versions --recursive gs://materia-v2-$MIG_ENV-files/orgs/$ORG/ \
     gs://materia-v2-$MIG_ENV-files/migration-quarantine/$RUN/ gs://materia-v2-$MIG_ENV-files/users/$UID_/
   gcloud storage ls --all-versions --recursive gs://materia-v2-$MIG_ENV-migration/runs/$RUN/ \
     gs://materia-v2-$MIG_ENV-files/orgs/$ORG/ gs://materia-v2-$MIG_ENV-files/users/$UID_/   # must list nothing
   ```

4. **Delete the dev backups taken while his data was there**, from the load to the rollback (dev only; never in prod). `pnpm materia-scripts backup-status --project materia-v2-$MIG_ENV` lists them all.
   - managed backups whose snapshot falls in the window:

     ```sh
     gcloud firestore backups list --project materia-v2-$MIG_ENV --format="table(name.basename(), snapshotTime)"
     gcloud firestore backups delete --backup=<id> --location=australia-southeast1 --project materia-v2-$MIG_ENV
     ```

   - the nightly exports in the window, in both buckets (folders are named by snapshot time):

     ```sh
     gcloud storage ls gs://materia-v2-$MIG_ENV-exports/daily/ gs://materia-v2-$MIG_ENV-exports/monthly/ \
       gs://materia-v2-$MIG_ENV-backups/daily/ gs://materia-v2-$MIG_ENV-backups/monthly/
     gcloud storage rm --all-versions --recursive gs://materia-v2-$MIG_ENV-exports/daily/<time>/ gs://materia-v2-$MIG_ENV-backups/daily/<time>/
     ```

   - the files copy: `gcloud storage rm --all-versions --recursive gs://materia-v2-$MIG_ENV-backups/files/orgs/$ORG/ gs://materia-v2-$MIG_ENV-backups/files/users/$UID_/`.

   PITR keeps the last 7 days and can't be cleared; it expires on its own. Soft-deleted objects (30 days for the files, 7 for the rest) can only be read by restoring them, and expire too.
5. Add a row to the export runbook's [cleanup record](migration-export.md#cleanup-record): the date, the run id, whether verify passed, and what was deleted. Then close the command log (`exit`).

## Cutover

Only after prod has launched (D-15): the release PR is merged, prod's Terraform has run (with `migration-runner`, the SEC-03 backups and App Check), and the release carries MIG-08 and MIG-09.

### T-7 days

- [ ] Agree the date with Tristan and Blake ([template 4](#messages-for-tristan)), and a time when he can stop using legacy for the window.
- [ ] Ask Tristan his practice's name. Set it as `org.name` in the profile (a PR), so the org isn't created as "Materia Technologies" (D-09).
- [ ] **Backups (SEC-03) run in prod:** `pnpm materia-scripts backup-status --project materia-v2-prod` (read-only) shows a managed backup, an export and its off-region copy from the last day.
- [ ] **PITR is on in prod:** `gcloud firestore databases describe --database='(default)' --project materia-v2-prod --format='value(pointInTimeRecoveryEnablement)'` prints `POINT_IN_TIME_RECOVERY_ENABLED`.
- [ ] `preflight --env prod` exits 0, with only the legacy bucket shown as `·`. The operator needs Token Creator on `migration-runner`.
- [ ] `auth-import --target materia-v2-prod --profile $PROFILE --dry-run` plans the import. "A v2 user already holds the email" usually means a test sign-in to prod: deleting it needs Blake's approval (see the auth import's [Stops](migration-auth-import.md#stops)).
- [ ] **Flags in prod:** `billing.costsDisclosure` stays off until Tristan has settled the disclosure on each imported open matter; the other flags as decided for launch.
- [ ] **Calendar:** if v2 syncs calendars by then (INT-02 or INT-04), plan the reconnect and decide what happens to legacy's events (below). If not, tell Tristan his legacy events stay in his calendar and v2 doesn't add any yet.
- [ ] Optional: read-only rules on legacy for the window. It is a change to the legacy repo that Blake approves and deploys, and it must be undone if the cutover rolls back. The default is to rely on Tristan not editing.

### T-1 day

A final rehearsal on dev with that day's export: the [dry-run checklist](#dry-run-checklist), the [rehearsal steps](#rehearse-on-dev) to verify (no review), then the [cleanup](#clean-up-a-dev-rehearsal) the same day. Verify must pass, and the total time must fit the window. If it doesn't pass, move the date.

### T0

```sh
export MIG_ENV=prod PROFILE=tools/migration/profiles/tristan-burke.json RUN=cutover-$(date -u +%Y%m%d)
gcloud config set project materia-v2-prod
```

1. **Tristan stops using legacy** ([template 5](#messages-for-tristan)). If read-only rules were agreed, Blake deploys them now.
2. **Blake grants the copy's read on the legacy bucket:** in `matt-r-1fe15`, give `migration-runner@materia-v2-prod.iam.gserviceaccount.com` **Storage Object Viewer** on `matt-r-1fe15.firebasestorage.app`. Then `preflight --env prod` shows every check ✓.
3. **Export, transform and copy:**

   ```sh
   pnpm materia-migrate export --profile $PROFILE --env prod --run-id $RUN
   pnpm materia-migrate transform --run $RUN --profile $PROFILE --target-org new --env prod
   pnpm materia-migrate copy-files --run $RUN --env prod
   ```

   Read the transform's report (rejects stop here) and the copy's (missing and infected files go to Tristan).
4. **Import his account:** `auth-import --target materia-v2-prod --profile $PROFILE --confirm-prod`, then the same again: it must say `nothing to do`.
5. **Load and verify:**

   ```sh
   pnpm materia-migrate load --run $RUN --env prod --dry-run
   pnpm materia-migrate load --run $RUN --env prod --confirm-prod     # type the org's name when asked
   pnpm materia-migrate verify --run $RUN --env prod
   ```

   Verify must pass. Attach `verify/verify-report.md` to MAT-101. A failure that a second load and verify don't fix is a [rollback](#rollback).
6. **If Tristan edited legacy after the export:** a delta (`export --since <the manifest's readTime>`, `transform --base-run $RUN`, `copy-files`, `delta --confirm-prod`, verify), as the [load runbook](migration-load.md#delta-cutover) says.
7. **Remove the legacy bucket grant** from step 2.
8. **Clerk and Insights:** `migration-enrichment.md` (MIG-09). Tristan, or Blake for him, approves the cost. Then `backfill-metrics --project materia-v2-prod --org <orgId> --from earliest` from Cloud Shell (the `dev-script` workflow is dev only).
9. **Tristan signs in** to prod with Google. His row in Authentication › Users shows the legacy uid and a sign-in time. He sets up his authenticator app when asked.
10. **Smoke checklist,** with him:
    - [ ] The number of matters (open and closed) matches the verify report's.
    - [ ] A matter he picks shows its tasks and notes as legacy had them.
    - [ ] Three attachments open, including an Outlook `.msg` and a PDF.
    - [ ] Budgets show as legacy had them, in the review queue's "Budgets brought across" item, which opens them.
    - [ ] Referrers show, on the Contacts list and on a matter that had one.
    - [ ] The Today card "Check your import" shows, and its count matches the transform report's review totals.
11. **Calendar:** he reconnects his calendar in v2, if v2 syncs calendars by then. The transform report's `MIG_W_CALENDAR_EVENTS_EXIST` lists the tasks whose legacy events are still in his calendar: he deletes those events, or keeps them and doesn't sync those tasks from v2, so nothing shows twice.
12. **Tell him it's done** ([template 6](#messages-for-tristan)), and record the cutover on MAT-101: the run id, the verify report and the command log.

## Rollback

**When:** verify fails and a second load and verify don't fix it, or within 48 hours of T0 Tristan hits a problem that stops his work and can't be fixed in time.

1. **Tristan goes back to legacy,** which never changed ([template 7](#messages-for-tristan)). If read-only rules were deployed, Blake removes them first.
2. **Roll back prod,** the delta first if there was one, twice a minute apart:

   ```sh
   pnpm materia-migrate rollback --run $RUN --env prod --dry-run
   pnpm materia-migrate rollback --run $RUN --env prod --confirm-prod
   ```

   If it refuses because he made records in v2 under migrated ones, the dry run lists them. Decide with him: he re-enters them in legacy, then they are deleted with the rest.
3. **His Auth account stays.** Prod's `auth-import --rollback` refuses once he has signed in, since that would lock him out, and the next cutover finds it as `nothing to do`.
4. **The run stays** in the prod bucket for the next attempt; the bucket deletes it after 90 days.
5. Record what failed on MAT-101 as a ticket, fix it, and plan a new date from T-7.

If prod data was damaged beyond what the rollback removes, the [restore runbook](restore.md) restores from PITR.

## After the cutover

- **Days 0 to 90:** legacy stays readable and unchanged, and `legacy-migration-reader` stays for any re-check. The migration review and the disclosures are Tristan's: `billing.costsDisclosure` goes on in prod once each imported open matter's disclosure is settled.
- **Before day 80:** archive the raw export. The migration bucket deletes the run at 90 days, so copy `runs/<runId>/raw/` and `manifest.json` into an encrypted Coldline archive kept for the org's retention period (`retentionYears`, 7 by default), and adjust the migration bucket's lifecycle to match. It is a Terraform change: file it as a ticket at T0.
- **Day 90:** Blake deletes `legacy-migration-reader` and the operator's Token Creator grants in `matt-r-1fe15`. Decommissioning legacy is MIG-10.

## Messages for Tristan

Short, in Blake's words. Fill in the `<…>`.

1. **Before a rehearsal:** "Hi Tristan, on <date> we'll copy your materia data into the new app's test site so you can check it. Nothing changes in materia, and keep using it as normal. The test copy is deleted once you've reviewed it."
2. **Rehearsal ready:** "Your data is on the test site: <https://materia-v2-dev.web.app>. Sign in with Google as usual. The 'Check your import' card on the Today page walks you through what needs a look, and please set your practice's name under Settings → Practice. Tell me anything that looks wrong by <date>; the test copy is deleted after that. After a day it will ask you to set up an authenticator app."
3. **Acceptance:** "Thanks for checking it. Can you confirm the data on the test site is right and we can move you over for real? A reply saying yes is enough."
4. **Date (T-7):** "We're ready to move you to the new app on <date>. From <time> that day please stop using materia until I tell you it's done, which should be about <hours> hours. Does that work? Also, what's the exact name of your practice?"
5. **T0, stop:** "We're starting the move now. Please don't make changes in materia from here; I'll message you when the new app is ready."
6. **T0, done:** "You're moved over. Sign in at <prod URL> with Google. The 'Check your import' card on Today lists what needs a look, and there are a few matters where the costs disclosure needs confirming. materia stays readable for 90 days if you need to check anything. Tell me straight away if anything stops you working."
7. **Rollback:** "We've hit a problem with the move, so please go back to using materia for now; everything there is as you left it. Anything you added in the new app since <time> needs entering in materia again: <list>. I'll be in touch with a new date."

## Command log

Every session runs under `script -a ~/mig07-<date>.log`, which records each command and its output (counts and paths only). Before the session ends, download the log and attach it to MAT-101 with the session's preflight output. Together they show which commands ran, that the legacy reader can't write, and that no command wrote to `matt-r-1fe15`: the tools send it reads only, and nothing else touches it.

