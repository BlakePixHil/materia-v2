// Matters (CORE-03, CORE-06, CORE-07). Deployed as matters-createMatter, matters-changeStatus,
// matters-changeStage, matters-upsertParty, matters-removeParty, matters-restore,
// matters-upgradeTemplate, matters-renumber (CORE-21a), matters-rebalanceBoard (CORE-04) and the
// matters-denormalise trigger (which also fills pending template due dates from key facts, CORE-07b).
export { changeStage } from './change-stage';
export { changeStatus } from './change-status';
export { createMatter } from './create';
export { denormaliseTrigger as denormalise } from './denormalise';
export { removeParty, upsertParty } from './parties';
export { rebalanceBoard } from './rebalance-board';
export { renumber } from './renumber';
export { restore } from './restore';
export { upgradeTemplate } from './upgrade-template';
