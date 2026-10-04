import { onCall } from 'firebase-functions/v2/https';

import { DEFAULT_ORG_TIMEZONE } from '@materia/domain';

import { REGION } from '../config';
import { releaseInfo } from '../core/env';

export interface PingResult {
  ok: true;
  region: typeof REGION;
  timezone: string;
  version: string;
  sha: string;
  at: string;
}

/** Pure handler, so it can be unit-tested without the Functions runtime. */
export function handlePing(now: Date = new Date()): PingResult {
  return { ok: true, region: REGION, timezone: DEFAULT_ORG_TIMEZONE, ...releaseInfo(), at: now.toISOString() };
}

/** `system-ping`: health check with the release version and SHA. Public: uptime checks call it (FND-21). */
export const ping = onCall({ region: REGION, invoker: 'public' }, () => handlePing());
