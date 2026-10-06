// Time entries (BILL-01). Deployed as time-setStatus and the time-onWrite trigger. Clients create
// and edit drafts directly; the trigger recomputes their values and keeps the matter's WIP.
export { onWrite } from './on-write';
export { setStatus } from './set-status';
