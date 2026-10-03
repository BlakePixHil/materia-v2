import { logger } from 'firebase-functions';
import { onCall } from 'firebase-functions/v2/https';

import { DEFAULT_ORG_TIMEZONE } from '@materia/domain';

import { REGION } from '../config';

export interface PingResult {
  ok: true;
  region: typeof REGION;
  timezone: string;
  at: string;
}

/** Pure handler, so it can be unit-tested without the Functions runtime. */
export function handlePing(now: Date = new Date()): PingResult {
  return { ok: true, region: REGION, timezone: DEFAULT_ORG_TIMEZONE, at: now.toISOString() };
}

/** Placeholder callable (`platform-ping`). FND-15 replaces it with the callable wrapper. */
export const ping = onCall({ region: REGION }, (request) => {
  // Log ids only, never names or emails (ADR-018).
  logger.info('ping', { uid: request.auth?.uid ?? null, feature: 'platform' });
  return handlePing();
});
