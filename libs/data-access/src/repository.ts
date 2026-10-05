/*
 * `@materia/data-access/repository` (FND-19): typed repositories, query resources and the members
 * example, the contacts repositories (CORE-01), the matters and saved-view repositories (CORE-03), the conflict check's matter reads and callables (CORE-02), the matter screen's reads and callables (CORE-06), matter templates and their callables (CORE-07), intake drafts and the intake create (CORE-05), tasks and tasks-bulkUpdate (CORE-08), checklist templates (CORE-08d), deadlines, events, proposals and the deadlines callables (CORE-10), the org's numbering settings (CORE-21a), matter documents, the upload contract and the documents callables (CORE-12), plus the in-memory driver for feature tests. Imported by lazily loaded features only.
 */
export * from './lib/firestore/firestore-driver';
export * from './lib/resources';
export * from './lib/repository';
export * from './lib/members';
export * from './lib/contacts';
export * from './lib/matters';
export * from './lib/conflicts';
export * from './lib/matter-detail';
export * from './lib/templates';
export * from './lib/intake';
export * from './lib/tasks';
export * from './lib/deadlines';
export * from './lib/checklist-templates';
export * from './lib/org-settings';
export * from './lib/documents';
export * from './lib/testing/in-memory-firestore';
