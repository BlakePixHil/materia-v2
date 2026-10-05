// Notes (CORE-13). Deployed as notes-create and notes-update: a note's text changes only through
// them (mentions, revisions, mention notifications); clients pin, delete and restore directly.
export { create } from './create';
export { update } from './update';
