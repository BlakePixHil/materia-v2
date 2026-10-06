# Clerk letter types (AI-10)

Each `.json` file here is one kind of letter Clerk drafts (ADR-050). `pnpm materia-scripts clerk-prompts`
validates them and compiles them into `CLERK_DRAFT_TYPES` (`libs/domain/src/lib/clerk-draft-types.generated.ts`);
CI fails if the generated file is out of date.

| Field               | Meaning                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | The type's id (also the file name)                                                                                                                               |
| `title`             | What the start page and the saved document call it                                                                                                               |
| `description`       | One line under the title on the start page                                                                                                                       |
| `matterTypes`       | The matter types it fits; empty for every type                                                                                                                   |
| `promptId`          | The prompt that drafts it (`drafting@1.0.0`)                                                                                                                     |
| `template`          | The template its body is merged into when saved (`system-letterhead`, ADR-047)                                                                                   |
| `audience`          | `client` or `third_party`: a third-party letter leaves privileged material out unless allowed                                                                    |
| `recipientRoles`    | The party roles it writes to, offered first                                                                                                                      |
| `requiredFacts`     | Matter facts it needs (`matter.estate.grantDate`, `fee.arrangement`, `party:executor`) and their labels; a missing one becomes a `[[TO CONFIRM: …]]` placeholder |
| `guidance`          | What the letter says, for the prompt                                                                                                                             |
| `needsInstructions` | The person must say what the letter is about                                                                                                                     |

The guidance is a starting point until a practitioner reviews the wording (AI-10a). A new type also
needs an eval case in `libs/clerk/evals/drafting/`.
