// Document templates and docx merge (INT-06, ADR-047). Deployed as docs-generate (a template merged
// with a matter's data, saved to its documents), and for Settings → Document templates
// docs-saveTemplate, docs-publishTemplate, docs-unpublishTemplate, docs-deleteTemplate,
// docs-previewTemplate (a test merge against a matter), docs-downloadTemplate and docs-saveLetterhead.
// `generateDocument` is the engine other features call with their own data (BILL-06, AI-10).
export { generate } from './generate';
export {
  deleteTemplate,
  downloadTemplate,
  previewTemplate,
  publishTemplate,
  saveLetterhead,
  saveTemplate,
  unpublishTemplate,
} from './templates';
