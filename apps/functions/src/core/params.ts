/**
 * Non-secret runtime configuration, read from the functions' environment variables (set in the
 * deployed `.env`, or on the Cloud Run service). Not firebase-functions params: a deploy without an
 * interactive terminal refuses any param missing from `.env`, even one with a default.
 */

/**
 * The ClamAV scan service's base URL (CORE-12, ADR-028). Unset until the scanner service is
 * deployed (MAT-137): uploads then stay quarantined ("Scanning delayed") rather than skip the scan.
 */
export function clamavScanUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env['CLAMAV_SCAN_URL']?.trim() ?? '';
}

/**
 * The preview service's base URL (CORE-12a, ADR-028): Office → PDF and HEIC → JPEG. Unset until
 * the service is deployed: those files then have no preview ("download instead").
 */
export function previewServiceUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env['PREVIEW_SERVICE_URL']?.trim() ?? '';
}
