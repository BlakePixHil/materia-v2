# firebase

Firebase configuration for Materia v2. Run the CLI with `--config firebase/firebase.json`, or use the root scripts (`pnpm emulators`). Emulators bind to `127.0.0.1`.

| File                     | What                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `firebase.json`          | Functions codebase `core` (built to `dist/apps/functions`), Hosting (`dist/apps/web/browser`), and emulator ports                                                                                                                                                                                                                                                                      |
| `.firebaserc`            | Project aliases. `default` is the offline `demo-materia` emulator project; `dev` and `prod` are the project ids planned in `infra/terraform/envs/*.tfvars` (FND-03); `staging` is deferred in MVP mode. If a suffix is needed because an id is taken, change it here too. `targets` maps the `files` Storage target to each project's bucket (`<project>-files`, created by Terraform) |
| `firestore.rules`        | Tenancy and role rules for every collection (FND-14). Default deny; claims `{orgId, role}`; client updates only for whitelisted fields; creates are callables; no hard deletes                                                                                                                                                                                                         |
| `storage.rules`          | Matter files (read after a clean scan; uploads to `pending/` only, at most 50 MB) and avatars (FND-14)                                                                                                                                                                                                                                                                                 |
| `firestore.indexes.json` | The initial composite indexes from the Domain doc, plus the `chunks` vector index (768 dimensions, flat)                                                                                                                                                                                                                                                                               |
| `tests/`                 | The rules suite (`pnpm nx run firebase:test-rules`): `support/collections.ts` lists every collection and its expected access                                                                                                                                                                                                                                                           |

## Changing the rules

1. Add or change the `match` block. Gate it with `can(orgId, '<action>')` (the PERMISSIONS matrix in `libs/domain`) and allow updates with `clientUpdate(fields<Entity>())`.
2. If you changed PERMISSIONS or an entity's `update` schema, run `pnpm materia-scripts rules-sync`. It rewrites the generated role lists and field whitelists in both rules files, and a unit test fails if they drift.
3. Add the collection to `tests/support/collections.ts`. The suite generates read and update tests for all five roles, a cross-org deny, an unauthenticated deny, a forbidden field, bad `updatedBy` / `updatedAt`, and denied creates and hard deletes. It fails if a `match` block has no spec, or a domain collection has neither.
4. Run `pnpm nx run firebase:test-rules`. It fails below 90% rules coverage and writes the report to `dist/rules-coverage/` (CI uploads it as `rules-coverage`).

Gotcha: in a list query, `resource.data.get(field, default)` on a field the query does not constrain evaluates to the default. Never use a default in a read condition that should restrict a query (see `visible()`).

## Deploying

Rules and indexes deploy with the CD pipeline (FND-05). By hand: `pnpm exec firebase deploy --only firestore:rules,firestore:indexes,storage --project dev --config firebase/firebase.json`. `storage.rules` uses cross-service `firestore.get()`; on the first deploy the CLI asks to grant the Storage service agent read access to Firestore.

Storage rules deploy through the `files` target, not the default bucket. Terraform creates a named bucket (`<project>-files`) and links it to Firebase, so a project has no default bucket and an untargeted `storage` deploy fails with "Firebase Storage has not been set up". Don't click Get Started in the console: it creates a second, unmanaged bucket. For a new project, add its bucket under `targets` in `.firebaserc`.
