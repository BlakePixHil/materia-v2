# ADR-025: Matter template versions live under the template; system templates ship with the code

- **Status:** Accepted
- **Date:** 2026-10-04
- **Ticket:** [CORE-07](https://linear.app/materia-web/issue/MAT-34)

## Context

CORE-07 adds matter templates: stages, the tasks each stage creates and the deadline rules that apply. Orgs clone and edit a template, and every publish must be an immutable version, because a matter keeps the version it was created with (`templateId` + `templateVersion`). The domain model also listed a global `systemTemplates` collection for the default templates, which would need a deploy-time seeding step.

## Decision

We will store an org template as a draft document, `orgs/{orgId}/templates/{id}`, with `version` (the latest published) and `published`, and each publish as an immutable copy, `orgs/{orgId}/templates/{id}/versions/{n}`. Only the `templates-*` callables write either; members read both. A version that drops stages records a `stageMapping` for upgrades.

We will ship the system templates with the code, as `libs/domain/templates/system/{matterType}.json` imported by `libs/domain` (ids `system-{type}`), and validate them in a unit test. We will not seed them into `systemTemplates`.

## Consequences

- A matter's version is always readable by path, and publishing never touches matters or other versions.
- Changing a system template is a code change and a release, reviewed like any other. Bumping its `version` keeps old matters readable only if the old file is kept too. That is a follow-up if system templates ever need a second version.
- The JSON is bundled into the functions and, through `@materia/domain`, into the web chunk that reads stages.

## Alternatives considered

- One document per version (`templates/{id}@{n}`): listing an org's templates would need a filter, and the draft has nowhere obvious to live.
- Seeding `systemTemplates` from a deploy script: it is one more pipeline step and would let Firestore and the code drift apart, with no benefit while only Materia edits system templates.
