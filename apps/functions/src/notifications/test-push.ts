import { DomainError, ROLES, TestPushInput } from '@materia/domain';

import { defineCallable, type CallableDefinition } from '../core/callable';

/** What the test says on the device: nothing about anyone's work. */
export const TEST_PUSH = {
  title: 'Test from Materia',
  body: 'Push notifications work on this device.',
  link: '/settings/preferences',
} as const;

/**
 * `notifications-testPush` (MOB-04; anyone): sends a test push to one of the caller's own devices
 * (`users/{uid}/devices/{deviceId}`), so Settings can show push working end to end. A device that
 * isn't theirs, or no longer exists, is NOT_FOUND; a token FCM reports gone deletes the device and
 * is FAILED_PRECONDITION `invalid_token`; a transient failure is UNAVAILABLE.
 */
export const testPushDefinition = {
  name: 'notifications-testPush',
  input: TestPushInput,
  roles: ROLES,
  handler: async ({ input, uid, orgId, db, ports, log }): Promise<{ sent: true }> => {
    const device = await db.doc(`users/${uid}/devices/${input.deviceId}`).get();
    const token = device.get('token');
    if (!device.exists || typeof token !== 'string' || !token) {
      throw new DomainError('NOT_FOUND', 'That device no longer gets push notifications', { reason: 'no_device' });
    }
    const result = await ports.push.send(token, { ...TEST_PUSH, orgId, tag: `test-${input.deviceId}` });
    log.info('test push', { deviceId: input.deviceId, ok: result.ok, reason: result.ok ? null : result.reason });
    if (result.ok) return { sent: true };
    if (result.reason === 'invalid_token') {
      await device.ref.delete();
      throw new DomainError('FAILED_PRECONDITION', 'This device stopped accepting push notifications', {
        reason: 'invalid_token',
      });
    }
    if (result.reason === 'transient') throw new DomainError('UNAVAILABLE', 'The push service didn’t answer');
    throw new DomainError('FAILED_PRECONDITION', 'The push service refused the test', { reason: result.reason });
  },
} satisfies CallableDefinition<typeof TestPushInput, { sent: true }>;

export const testPush = defineCallable(testPushDefinition);
