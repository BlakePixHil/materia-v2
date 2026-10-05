// The matter activity feed (CORE-13). Deployed as the activity-onAudit trigger, which turns audit
// entries into feed lines through the mapping table in ./mapping. Task lines come from tasks-onWrite.
export { onAudit } from './on-audit';
