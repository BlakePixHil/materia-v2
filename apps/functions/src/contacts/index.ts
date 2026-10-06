// Contacts (CORE-01). Deployed as contacts-create, contacts-findDuplicates, contacts-merge,
// contacts-delete, contacts-onWrite and the contacts-continueMerge queue; contacts-onPartyWrite
// (roles in matters) and contacts-activity (the contact's history) are CORE-01a.
export { activity } from './activity';
export { create } from './create';
export { deleteContact as delete } from './delete';
export { findDuplicates } from './find-duplicates';
export { continueMergeQueue as continueMerge, merge } from './merge';
export { onPartyWrite } from './matter-roles';
export { onWrite } from './on-write';
