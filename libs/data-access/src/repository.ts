/*
 * `@materia/data-access/repository` (FND-19): typed repositories, query resources and the members
 * example, the contacts repositories (CORE-01), plus the in-memory driver for feature tests. Imported by lazily loaded features only.
 */
export * from './lib/firestore/firestore-driver';
export * from './lib/resources';
export * from './lib/repository';
export * from './lib/members';
export * from './lib/contacts';
export * from './lib/testing/in-memory-firestore';
