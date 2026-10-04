// Contacts (CORE-01). Deployed as contacts-create, contacts-findDuplicates, contacts-merge,
// contacts-delete, contacts-onWrite and the contacts-continueMerge queue.
export { create } from './create';
export { deleteContact as delete } from './delete';
export { findDuplicates } from './find-duplicates';
export { continueMergeQueue as continueMerge, merge } from './merge';
export { onWrite } from './on-write';
