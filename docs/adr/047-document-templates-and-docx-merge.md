# ADR-047: Document templates are .docx files merged on the server from a field catalogue

- **Status:** Accepted
- **Date:** 2026-10-06
- **Ticket:** [INT-06](https://linear.app/materia-web/issue/MAT-102)
- **Builds on:** [ADR-028: Document upload pipeline](028-document-upload-pipeline.md), [ADR-032: Document services on Cloud Run](032-document-services-on-cloud-run.md)

## Context

Firms write letters, file notes and costs disclosures in Word, on their own letterhead. They want them filled from the matter (client, deceased, executors, fee terms) and filed on the matter. The costs disclosure (BILL-06) and Clerk drafting (AI-10) need the same engine with their own data. Templates are written by firm staff, not developers, so a mistake in a tag has to come back as a message that names the tag. The server has to stay safe however odd the uploaded .docx is.

## Decision

- **Tags are catalogue paths, not expressions.** docxtemplater fills the .docx in Functions with our own parser. A tag is a path with optional formatters: `{matter.number}`, `{deceased.dateOfDeath|date}`, `{fee.amount|money}`, `{client.fullName|upper}`. Loops and conditions are docxtemplater's: `{#beneficiaries}{name}{/beneficiaries}`, `{^client.email}…{/client.email}`. `{@body}` takes Markdown. Nothing in a template is evaluated as code.
- **The catalogue lives in `libs/domain`** (`doc-templates.ts`). It lists every field with its label, type and an example, the list fields with their item fields, and the formatters `date`, `money` and `upper`. `checkMergeTags` checks a template's tags against it, and the merge data is built from it (`buildMergeData`). The Settings page's "Template fields" panel reads the same catalogue, so the help shows exactly what the engine accepts.
- **Templates are checked when they are uploaded.** `docs-saveTemplate` takes the file as base64 through the callable (up to 5 MB, a .docx only). It checks the tags, scans the file for malware (`MalwareScanPort`) and stores it at `orgs/{orgId}/docTemplates/{id}/v{n}.docx`. A syntax error or an unknown field refuses the upload (`template_invalid`), with each problem naming its tag ("{client.fullname} isn’t a field. Did you mean {client.fullName}?"). Every upload is a new version (at most 50). Documents are generated only from the published version, so a new upload changes nothing until an owner or admin publishes it.
- **The built-in templates are virtual.** The letterhead, letter, file note and costs disclosure placeholder are built in code (`system-*`, `system-templates.ts`) and never stored in Firestore. An org template that `replaces` one hides it from "New from template" while it is published. The costs disclosure is marked as an illustrative placeholder until a practitioner reviews the firm's own.
- **The letterhead details are one settings document.** `orgs/{orgId}/settings/letterhead` holds the address, phone, email, website and footer line. The built-in templates' header and footer use them, as `{firm.*}` fields. Every member reads it; `docs-saveLetterhead` writes it.
- **A missing value is printed, not refused.** A field with no value prints `[[missing: client.address]]`, and the result lists the missing fields, so a person can see and fix the gap in Word. An empty field inside a condition only drops the condition.
- **Generated documents are matter documents.** `docs-generate({templateId, matterId, data?, name?, privileged?})` (`document.upload`, idempotent) merges the template with the matter's data and files the result on the matter's documents:
  - It is saved as version 1, `source: 'generated'`, with `generatedFrom {templateId, version}`. The category comes from the template's kind (letters are correspondence), and the kind's tags (`file-note`, `costs-disclosure`) are added.
  - It is filed `scan.status: 'clean'` without a second scan, because the template was scanned at upload and the merge only adds text.
  - The document id comes from the request id, so a retry never adds a second document.
  - The PDF preview is queued through the preview service (CORE-12a).
  - It follows the CORE-19 contract: `writableMatter` refuses archived and removed matters.
  - `generateDocument(deps, request)` is the engine other features call. BILL-06 and AI-10 pass their own data, category, tags and `source: 'clerk_draft'`.
- **Markdown becomes Word paragraphs.** It covers headings, bold, italics, bullet and numbered lists, quotes and line breaks. Lists are drawn with their own bullet or number and a hanging indent rather than Word numbering, so they look the same in any template without adding a numbering part. `[[TO CONFIRM: …]]` placeholders are highlighted. Headings use the template's Heading styles when it defines them, else bold text.
- **Fonts the server lacks are a warning, not an error.** At upload the template's fonts are checked against those the preview service has. A font it would substitute adds a warning ("The PDF preview uses a similar font in place of Aptos"). The .docx itself keeps the original.
- **Test merge never saves anything.** `docs-previewTemplate` merges any version against a chosen matter. It returns the missing fields, the warnings, the body as HTML (mammoth) and the merged .docx to download.
- **No flag.** Generating needs a published template, or uses a built-in one, and adds an ordinary document a person can remove. Nothing reaches a client without a person sending it.

## Consequences

- BILL-06 (costs disclosure), AI-10 (Clerk drafting), LIT-06 and LIT-10 call `generateDocument` instead of building documents themselves.
- A new field means a catalogue entry and its value in `buildMergeData`. A template using a field the catalogue doesn't have is refused at upload, so typos never reach a client.
- Templates can't compute anything (no sums or comparisons in tags). A computed value becomes a catalogue field.
- Images and fonts in a template carry through to the .docx. The PDF preview may substitute fonts, as the warning says.
- The test merge preview shows the body only. The header, footer and letterhead show in the downloaded .docx.

## Alternatives considered

- **docxtemplater's expression parser (angular-expressions).** It allows arbitrary expressions in a template, which can't be checked against a catalogue and run on the server. We lost little by not having them.
- **Seeding system templates into Firestore.** Every org would need a copy, and an improvement would never reach them. Virtual templates with `replaces` give a firm its own version without that.
- **Uploading templates through Storage, like documents.** It would need new Storage rules and a trigger, and an upload with a bad tag would only fail later. A callable checks the tags and answers at once, and 5 MB is plenty for a letterhead.
- **Scanning every generated document.** The merge only adds text to a template that was scanned at upload, so a second scan would only add delay.
- **Refusing to generate with missing fields.** People often generate a letter before every detail is known. A visible marker and a list does more good than a refusal.
