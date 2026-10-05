// Documents (CORE-12, ADR-028). Deployed as documents-onUpload (Storage trigger on the files
// bucket's pending/ uploads), documents-rescan (Cloud Tasks retries of delayed scans),
// documents-sweepPending (hourly expiry of quarantined uploads) and the callables
// documents-getDownloadUrl, documents-restoreVersion, documents-resolveDuplicate and
// documents-bulkUpdate. Clients edit document metadata directly (the rules check it).
export { bulkUpdate, getDownloadUrl, resolveDuplicate, restoreVersion } from './callables';
export { onUpload, rescan, sweepPending } from './on-upload';
