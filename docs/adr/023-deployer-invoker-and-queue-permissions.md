# ADR-023: Deployer permissions to set function invokers and manage task queues

- Status: Accepted
- Date: 2026-10-04
- Relates to: [ADR-021](021-app-engine-default-account-and-the-deployer.md), [ADR-022](022-compute-default-account-builds-functions.md), MAT-9

## Context

With builds working, `deploy-dev` deployed 20 of 24 functions and failed on the rest:

- `auth-beforeCreate`, `auth-beforeSignIn` and `jobs-startPdf`: firebase-tools could not set the invoker IAM policy on their Cloud Run
  services (`run.services.setIamPolicy`). `roles/run.developer` can read but not set it.
- `system-recordEcho` (a task queue function): `cloudtasks.queues.get` was denied. The CLI creates and updates the queue and sets its
  IAM policy.

## Decision

- A custom role `deployerRunInvoker` holding only `run.services.setIamPolicy`, bound to the deployer.
- `roles/cloudtasks.queueAdmin` for the deployer.

## Alternatives

- `roles/run.admin`: rejected, it also covers jobs, instances and worker pools.
- `roles/cloudtasks.admin`: rejected, same queue permissions plus task management the deployer does not need.
- Setting `invoker` in code to avoid the call: not possible, blocking functions need a public invoker.

## Consequences

The deployer can change who may invoke a Cloud Run service in its project. That is inherent to deploying functions with a declared
invoker, and the deployer is reachable only from `main` through the GitHub environment gates. Review any new invoker value in the PR
that introduces it.
