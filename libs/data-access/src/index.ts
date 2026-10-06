/*
 * The data layer's core (FND-19): what the app shell needs at start-up. Repositories, query
 * resources and the in-memory test driver are in `@materia/data-access/repository`, so their code
 * loads with the first feature that reads data, not in the initial bundle.
 */
export * from './lib/org-context';
export * from './lib/listener-registry';
export * from './lib/connectivity';
export * from './lib/errors';
export * from './lib/firebase-setup';
export * from './lib/firestore/firestore-client';
export * from './lib/query';
export * from './lib/tokens';
export * from './lib/callable-client';
export * from './lib/optimistic';
export * from './lib/permissions';
export * from './lib/lifecycle';
export * from './lib/jobs';
export * from './lib/timer';
export * from './lib/tenancy';
