// Clerk suggestions (AI-07, ADR-037). Deployed as suggestions-accept, suggestions-acceptMany,
// suggestions-dismiss and the hourly suggestions-expire sweep. Clerk features create suggestions
// server-side with `proposeSuggestions` (./propose); clients only read them.
export { accept, acceptMany } from './accept';
export { dismiss } from './dismiss';
export { expire } from './expire';
