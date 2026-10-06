# Runbook: migration auth import (MIG-04)

How the migrated user's Firebase Auth account moves from legacy (`matt-r-1fe15`) into v2 Identity Platform with the **same uid**, using `materia-migrate auth-import` ([tool README](../../tools/migration/README.md#auth-import-mig-04), [decision D-16](../migration/decisions.md#d-16-auth-import-new)). The load (MIG-06) keys everything on that uid, so the auth import runs first.

**When:** at cutover (MIG-07), after the prod launch. Rehearsals run on dev (D-15). Nobody imports into prod before cutover.

**What moves:**

- the uid;
- the Auth record's email (not the profile's) and whether it is verified;
- the display name, photo and creation time;
- every sign-in identity with the provider's own id for the person, so the user's first Google sign-in in v2 lands on the imported account rather than creating a new one;
- the password hash and salt, if the user has a password.

**What doesn't move:**

- legacy custom claims: v2 sets its own at the load (FND-17, MIG-06);
- the legacy last sign-in time: v2's starts empty;
- second factors: the import stops instead, because v2 uses TOTP only.

## Credentials

- **Target (v2):** your own gcloud account (the default) or `--target-adc`. It needs `roles/firebaseauth.admin` on the v2 project. With a password it also needs `roles/secretmanager.secretAccessor` on the `LEGACY_SCRYPT_PARAMS` secret.
- **Legacy (read-only):** the tool impersonates `legacy-migration-reader@matt-r-1fe15.iam.gserviceaccount.com`, as the audit does. It checks with IAM that those credentials can't write before it reads, and stops with exit code 3 otherwise. A `--record` file replaces the legacy read.
- Behind an HTTPS proxy, set `NODE_USE_ENV_PROXY=1`.

## The Google-only user (Tristan Burke)

Tristan signs in with Google only (MIG-01 audit), so there are no hash parameters and no export file: steps 2 and 3 of the next section don't apply.

1. **Dry run against prod.** It reads the legacy account and checks prod: Google sign-in is on, and no prod user already holds his email or Google identity.

   ```sh
   NODE_USE_ENV_PROXY=1 pnpm materia-migrate auth-import --target materia-v2-prod \
     --profile tools/migration/profiles/tristan-burke.json --dry-run
   ```

   Expect `would import fen5jJdhNHTkGBpgAdsLSKQRvXx2 … with google.com (provider uids kept) and no password`. Exit code 4 means it stopped for a person: read the reasons (see [Stops](#stops)).

2. **Import:** the same command with `--confirm-prod` in place of `--dry-run`. It ends with `Imported … and checked it`. The check reads the account back and compares the email and identities.
3. **Re-run it once:** it must say `nothing to do`.
4. **Load (MIG-06)** sets his claims (org and role) through FND-17.
5. **Sign-in check:**
   - Tristan signs in to prod with Google.
   - In the Firebase console (Authentication › Users), his row shows the legacy uid, Google as the provider and a sign-in time.
   - If his org requires MFA (SEC-04), the app asks him to set up an authenticator app.

## A user with a password

Only if the dry run says the account has a password. Do steps 2 and 3 on a trusted machine, never in a shared folder or chat.

1. **Run the dry run** above. It stops with "doesn't show its hash": the read-only account sees password hashes redacted.
2. **Copy the hash parameters into v2's Secret Manager:**
   - In the legacy console, open Authentication › Users › ⋮ › Password hash parameters.
   - Paste the four values as JSON on stdin, so they never reach a file or your shell history, then press Ctrl-D:

     ```sh
     gcloud secrets create LEGACY_SCRYPT_PARAMS --project <v2-project> \
       --replication-policy user-managed --locations australia-southeast1 --data-file=-
     # {"base64_signer_key":"…","base64_salt_separator":"…","rounds":8,"mem_cost":14}
     ```

3. **Export the account, filtered at once:**

   ```sh
   dir=$(mktemp -d) && chmod 700 "$dir"
   firebase auth:export "$dir/all.json" --format=json --project matt-r-1fe15
   jq --arg uid "<legacyUid>" '{users: [.users[] | select(.localId == $uid)]}' "$dir/all.json" > "$dir/user.json"
   rm "$dir/all.json"
   ```

   The tool refuses a file that holds more than one account.

4. **Import:** run the dry run, then the import, adding `--record "$dir/user.json"`.
5. **Clean up straight away:**
   - `rm -r "$dir"`;
   - `gcloud secrets delete LEGACY_SCRYPT_PARAMS --project <v2-project>`;
   - add a row to the [cleanup record](#cleanup-record).

## Stops

Exit code 4 lists what needs a person. It never prints emails or hashes.

| Stop | What to do |
| -- | -- |
| The legacy account is disabled | Ask Blake and the user why before going on |
| Second factors | v2 can't import them. Ask whether to go on; the user then enrols TOTP in v2 |
| A provider is off in the target | Turn it on first. For Microsoft, follow the app registration in `infra/MANUAL.md` (FND-16). Then check its tenant matches the user's |
| v2 already has the uid with another email | Stop: it is another person, or the email changed. Ask |
| A v2 user already holds the email or identity | Usually a test account made by signing in to v2 before the import. Deleting it needs Blake's approval. Then re-run with `--replace-user <thatUid>`, which deletes exactly that user first |
| The hash isn't available, or `LEGACY_SCRYPT_PARAMS` is missing | Follow [A user with a password](#a-user-with-a-password) |

## Rehearse on dev

With the made-up fixture account (no real data):

```sh
export NODE_USE_ENV_PROXY=1
M="pnpm materia-migrate auth-import --target materia-v2-dev --uid AlexRiversLegacyUid000000001 \
  --record tools/migration/fixtures/legacy/auth-export.json"
$M --dry-run && $M && $M && $M --rollback
```

A MIG-07 rehearsal with the real user imports his account into dev the same way (with `--profile` instead of `--uid` and `--record`). It is rolled back with the rest of the rehearsal (`--rollback`).

- **On dev:** `--rollback` deletes the account even after a sign-in. The sign-in log the `beforeSignIn` hook wrote (`users/{uid}/private/session` and `users/{uid}/signIns`) is left for the load's rollback to remove.
- **On prod:** `--rollback` refuses once the user has signed in, since that would lock them out.

## Exit codes

| Code | Meaning |
| -- | -- |
| 0 | Imported, rolled back, planned (`--dry-run`) or nothing to do |
| 1 | Bad arguments, a refused target or an error |
| 3 | The legacy credentials could write, or can't read Auth |
| 4 | Stopped for a person to decide |

The tool refuses to write to a legacy project, and it refuses `materia-v2-prod` without `--confirm-prod`.

## Cleanup record

Every export file and hash secret ever created, and when it was deleted.

| Date | What | Deleted |
| -- | -- | -- |
| 2026-10-06 | Dev rehearsal (MIG-04): two made-up accounts and the sign-in log of one. No export or hash parameters were created: the real user is Google-only, and the password rehearsal used a made-up scrypt key | Same day: both accounts and the log deleted, none left |
