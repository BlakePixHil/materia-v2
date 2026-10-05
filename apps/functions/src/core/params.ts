import { defineString } from 'firebase-functions/params';

/**
 * Non-secret deploy-time configuration (firebase-functions params). Set per project in
 * `.env.<projectId>` next to the functions bundle, or leave the default.
 */

/**
 * The ClamAV scan service's base URL (CORE-12, ADR-028). Empty until the scanner service is
 * deployed: uploads then stay quarantined ("Scanning delayed") rather than skip the scan.
 */
export const CLAMAV_SCAN_URL = defineString('CLAMAV_SCAN_URL', {
  default: '',
  description: 'Base URL of the ClamAV scan service on Cloud Run (POST /scan). Empty: uploads stay quarantined.',
});
