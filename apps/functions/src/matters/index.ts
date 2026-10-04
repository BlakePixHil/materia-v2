// Matters (CORE-03). Deployed as matters-createMatter, matters-changeStatus, matters-restore and
// the matters-denormalise trigger.
export { changeStatus } from './change-status';
export { createMatter } from './create';
export { denormaliseTrigger as denormalise } from './denormalise';
export { restore } from './restore';
