// Tasks (CORE-08). Deployed as tasks-bulkUpdate and the tasks-onWrite (matter tasks) and
// tasks-onPersonalWrite (personal tasks) triggers. Clients create and edit tasks directly.
export { bulkUpdate } from './bulk-update';
export { onPersonalWrite, onWrite } from './on-write';
