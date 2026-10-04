// Matters (CORE-03, CORE-06, CORE-07). Deployed as matters-createMatter, matters-changeStatus,
// matters-changeStage, matters-upsertParty, matters-removeParty, matters-restore,
// matters-upgradeTemplate and the matters-denormalise trigger.
export { changeStage } from './change-stage';
export { changeStatus } from './change-status';
export { createMatter } from './create';
export { denormaliseTrigger as denormalise } from './denormalise';
export { removeParty, upsertParty } from './parties';
export { restore } from './restore';
export { upgradeTemplate } from './upgrade-template';
