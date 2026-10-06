# @materia/domain

The single source of truth for Materia's entities and values (ADR-007, ADR-008). Pure TypeScript: no Angular, no Firebase. It runs in the web app, in functions and in tools.

| Import | What |
| -- | -- |
| `@materia/domain` | zod schemas (`X.schema`, `X.create`, `X.update`) and types for every entity in *Domain model & Firestore schema*; enums; `DateOnly`, `Cents`, `Minutes` and id utilities; the permissions matrix |
| `@materia/domain/firestore` | `firestoreConverter(X)` and `adminConverter(X)`: Timestamp ↔ Date, strict or lenient validation, lazy `schemaVersion` upgrades |
| `@materia/test-utils` | `makeX(overrides)` factories for every entity (fictional data) |

## Values

- **`DateOnly`**: `YYYY-MM-DD` legal dates. Calendar arithmetic only (`addDays`, `addMonths` clamps to month end). `fromIsoInstant(iso, tz)` and `today(tz)` use `Intl` timezone data, never naive `Date` maths.
- **`Cents`**: integer AUD. `fromDollars` parses strings exactly; `gstOf` rounds each line half away from zero (credits mirror invoices).
- **`Minutes`**: integer minutes; `toUnits(m, 6, 'up' | 'nearest')`.
- **Ids**: `newId()` (20-char base62) and `deterministicId(namespace, key)` (sha256 → base62) for idempotent migration.

## Entities

Each entity `X` exports `{ schema, create, update, version, path }` built by `withMeta()`, plus the named aliases `XSchema`, `XCreateSchema` and `XUpdateSchema` (the same objects), and `type X`:

- `schema` is the stored shape: strict, with `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `schemaVersion`, plus soft-delete and migration fields where they apply.
- `create` is the callable input: no meta and no server-owned fields (counters, denormalised fields).
- `update` is a partial of the whitelisted fields only.

## Permissions

`can(role, action, { privileged })`. A privileged resource also needs `privileged.view`, so read-only users never see privileged material. The table below is generated from `PERMISSIONS`; regenerate it with `UPDATE_PERMISSIONS_README=1 pnpm nx test domain` after changing the matrix (the test fails if it drifts). The Firestore rules mirror it (FND-14).

<!-- permissions:start -->

| Action | owner | admin | lawyer | paralegal | readonly |
| -- | -- | -- | -- | -- | -- |
| `matter.view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `matter.create` | ✓ | ✓ | ✓ | ✓ |  |
| `matter.edit` | ✓ | ✓ | ✓ | ✓ |  |
| `matter.delete` | ✓ | ✓ | ✓ |  |  |
| `matter.close` | ✓ | ✓ | ✓ |  |  |
| `matter.status` | ✓ | ✓ | ✓ |  |  |
| `matter.restore` | ✓ | ✓ |  |  |  |
| `matter.legalHold` | ✓ | ✓ |  |  |  |
| `matter.destroy` | ✓ | ✓ |  |  |  |
| `matter.renumber` | ✓ | ✓ | ✓ |  |  |
| `matter.fee` | ✓ | ✓ | ✓ |  |  |
| `contact.edit` | ✓ | ✓ | ✓ | ✓ |  |
| `contact.delete` | ✓ | ✓ | ✓ |  |  |
| `contact.merge` | ✓ | ✓ |  |  |  |
| `conflict.run` | ✓ | ✓ | ✓ | ✓ |  |
| `conflict.determine` | ✓ | ✓ | ✓ |  |  |
| `privileged.view` | ✓ | ✓ | ✓ |  |  |
| `document.upload` | ✓ | ✓ | ✓ | ✓ |  |
| `document.delete` | ✓ | ✓ | ✓ |  |  |
| `task.edit` | ✓ | ✓ | ✓ | ✓ |  |
| `note.write` | ✓ | ✓ | ✓ | ✓ |  |
| `deadline.override` | ✓ | ✓ | ✓ |  |  |
| `time.record` | ✓ | ✓ | ✓ | ✓ |  |
| `time.approve` | ✓ | ✓ | ✓ |  |  |
| `billing.view` | ✓ | ✓ | ✓ |  |  |
| `billing.issue` | ✓ | ✓ |  |  |  |
| `billing.void` | ✓ | ✓ |  |  |  |
| `trust.record` | ✓ | ✓ | ✓ |  |  |
| `clerk.use` | ✓ | ✓ | ✓ | ✓ |  |
| `clerk.configure` | ✓ | ✓ |  |  |  |
| `members.manage` | ✓ | ✓ |  |  |  |
| `org.settings` | ✓ | ✓ |  |  |  |
| `org.delete` | ✓ |  |  |  |  |
| `audit.view` | ✓ | ✓ |  |  |  |
| `export.run` | ✓ | ✓ |  |  |  |
| `export.includePrivileged` | ✓ | ✓ |  |  |  |
| `safeCustody.edit` | ✓ | ✓ | ✓ | ✓ |  |
| `safeCustody.release` | ✓ | ✓ | ✓ |  |  |

<!-- permissions:end -->
