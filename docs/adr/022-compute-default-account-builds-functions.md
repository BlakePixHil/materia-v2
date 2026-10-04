# ADR-022: The Compute default account builds functions and loses Editor

- Status: Accepted
- Date: 2026-10-04
- Relates to: [ADR-021](021-app-engine-default-account-and-the-deployer.md), MAT-9

## Context

Gen2 functions are built by Cloud Build as the Compute default account
(`<project number>-compute@developer.gserviceaccount.com`). Creating a function makes the Functions API require
`iam.serviceaccounts.actAs` on it for the caller. The first `deploy-dev` that reached creation failed with a 403 for all 24
functions. firebase-tools 15.x has no option to choose another build account.

Google grants that account `roles/editor`. Letting the deployer act as it would let a deploy run code as Editor.

## Decision

- Terraform grants the deployer `roles/iam.serviceAccountUser` on the Compute default account only.
- Terraform grants that account `roles/cloudbuild.builds.builder`, which is what a build needs.
- The `roles/editor` binding is removed with `gcloud` (recorded in `infra/MANUAL.md`), as for the App Engine account.

## Alternatives

- Grant ActAs and keep Editor: rejected, the deployer could escalate to Editor.
- `google_project_default_service_accounts` with DEPRIVILEGE: rejected, it would also remove the roles builds need and is not
  limited to this account.
- A dedicated build account: not supported by the firebase-tools version we pin. Revisit when it is.

## Consequences

If a build fails on a missing permission, add the narrowest role to the build account in Terraform. A new environment applies the
binding only once the Compute default account exists (it is created when the Compute API is enabled).
