/*
 * `@materia/data-access/repository` (FND-19): typed repositories, query resources and the members
 * example, the contacts repositories (CORE-01), the matters and saved-view repositories (CORE-03), the conflict check's matter reads and callables (CORE-02), the matter screen's reads and callables (CORE-06), plus the in-memory driver for feature tests. Imported by lazily loaded features only.
 */
export * from './lib/firestore/firestore-driver';
export * from './lib/resources';
export * from './lib/repository';
export * from './lib/members';
export * from './lib/contacts';
export * from './lib/matters';
export * from './lib/conflicts';
export * from './lib/matter-detail';
export * from './lib/testing/in-memory-firestore';
