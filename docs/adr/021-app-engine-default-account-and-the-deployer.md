# ADR-021: The deployer may act as the App Engine default account, which holds no roles

- **Status:** Accepted
- **Date:** 2026-10-04
- **Ticket:** [MAT-9](https://linear.app/materia-web/issue/MAT-9)

## Context

`firebase deploy --only functions` (firebase-tools 15.x) checks `iam.serviceAccounts.actAs` on `<project>@appspot.gserviceaccount.com` before it deploys anything, whatever service account the functions use. Our functions all run as `fn-runtime` (FND-03), and the deployer could act only as `fn-runtime` and `jobs-runtime`, so the first dev deploy failed on this check.

Google grants the App Engine default account the project-wide Editor role when it is created. Letting the deployer act as an account with Editor would let a deploy run code with Editor on the project, which defeats the least-privilege design in `modules/firebase_env/iam.tf`.

## Decision

- We will grant the deployer `roles/iam.serviceAccountUser` on `<project>@appspot.gserviceaccount.com` in Terraform, so the CLI check passes.
- We will remove the Editor role from that account in dev and prod, so acting as it grants nothing. Nothing runs as it (no functions, no Cloud Run services, no App Engine app). This is recorded in `infra/MANUAL.md`.
- We will not use `google_project_default_service_accounts` to do the removal: it also strips the Compute default account, which Cloud Build may use for function builds.

## Consequences

- Functions deploys work without widening what the deployer can reach.
- Removing a role Google granted automatically cannot be expressed in Terraform without a broader resource, so it is a recorded manual step. If a project is recreated, repeat it.
- A new environment applies this binding only once the App Engine default account exists; otherwise apply fails until it does.

## Alternatives considered

- **Grant `actAs` and keep Editor:** simplest, but the deployer could escalate to Editor through a deployed function.
- **Deprivilege both default accounts with `google_project_default_service_accounts`:** could break function builds that rely on the Compute default account.
- **Delete or disable the App Engine default account:** the CLI check would then error and skip, but it is less obvious and harder to reverse.
