import type { Firestore } from 'firebase-admin/firestore';

import { clerkAcknowledged, DomainError, orgClerkFeatureOn } from '@materia/domain';

import { isEnabled } from '../core/flags';
import type { Clock } from '../ports';
import { meteringPeriod } from './features';
import { firestoreClerkStore } from './firestore-store';
import { assertWithinBudget, BYOK_MISSING_SWITCH } from './gateway';
import { anthropicKeyPath } from './keyring';
import type { OrgClerkSettings } from './store';

/**
 * Says at once why Clerk can't run a feature a person asked for, so the page can show it and
 * offer the manual path (AI-06, AI-10): the kill switches, the org's own settings (its switch for
 * the feature and the data-use disclosure, AI-13), no usable key, or the month's token budget or
 * spend limit used. The gateway checks all of these again when the call runs (and the per-user
 * window then).
 */
export async function checkClerkAvailable(
  db: Firestore,
  orgId: string,
  clock: Clock,
  feature: 'chat' | 'drafting',
): Promise<void> {
  const flags = { orgId, db, clock };
  for (const flag of ['clerk.enabled', `clerk.features.${feature}`] as const)
    if (!(await isEnabled(flags, flag)))
      throw new DomainError('CLERK_DISABLED', 'Clerk is switched off', { switch: flag });
  const [org, key] = await Promise.all([db.doc(`orgs/${orgId}`).get(), db.doc(anthropicKeyPath(orgId)).get()]);
  const settings = (org.get('settings.clerk') as OrgClerkSettings | undefined) ?? {};
  if (settings.enabled === false)
    throw new DomainError('CLERK_DISABLED', 'Clerk is switched off', { switch: 'org.settings.clerk.enabled' });
  if (!orgClerkFeatureOn(settings, feature))
    throw new DomainError('CLERK_DISABLED', 'Clerk is switched off', {
      switch: `org.settings.clerk.features.${feature}`,
    });
  if (!clerkAcknowledged(settings))
    throw new DomainError('CLERK_DISABLED', 'Clerk is switched off', { switch: 'org.settings.clerk.acknowledgement' });
  if (!key.exists || !key.get('encryptedApiKey'))
    throw new DomainError('CLERK_DISABLED', 'Clerk is switched off', { switch: BYOK_MISSING_SWITCH });
  if (key.get('status') === 'invalid')
    throw new DomainError('CLERK_KEY_INVALID', 'Anthropic rejected the org’s API key; an admin must replace it');
  // The month's token budget and spend limit, read and checked as the gateway does.
  const period = meteringPeriod(clock.now());
  assertWithinBudget(settings, await firestoreClerkStore(db).periodUsage(orgId, period), period);
}
