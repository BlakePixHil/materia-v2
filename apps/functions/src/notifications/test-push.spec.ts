import { DomainError } from '@materia/domain';

import { TEST_PUSH, testPushDefinition } from './test-push';
import { createLog } from '../core/log';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, FakePush, fakePorts } from '../ports/fakes';

/** `notifications-testPush` (MOB-04): a test to one of the caller's own devices. All fictional. */

const NOW = new Date('2026-10-07T00:00:00.000Z');
const device = (token: string) => ({ token, platform: 'web', label: 'Chrome on macOS', lastSeenAt: NOW });

function world() {
  const store = memoryFirestore({
    'users/user-ada/devices/d-mine': device('fake-fcm-token-mine'),
    'users/user-ada/devices/d-gone': device('invalid-fcm-token'),
    'users/user-ada/devices/d-flaky': device('flaky-fcm-token'),
    'users/user-ben/devices/d-theirs': device('fake-fcm-token-theirs'),
  });
  const push = new FakePush();
  const run = (deviceId: string, uid = 'user-ada') =>
    testPushDefinition.handler({
      input: { deviceId },
      uid,
      orgId: 'org-1',
      role: 'lawyer',
      token: {},
      requestId: 'r-1',
      log: createLog({ fn: 'test' }, () => undefined),
      clock: new FakeClock(NOW),
      db: store.db,
      ports: { ...fakePorts(), push },
      auth: () => {
        throw new Error('unused');
      },
    });
  return { ...store, push, run };
}

const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof DomainError ? [error.code, error.details?.['reason'] ?? null] : error),
  );

describe('notifications-testPush', () => {
  it('sends the fixed test to the caller’s device, with the org and a per-device tag', async () => {
    const w = world();
    expect(await w.run('d-mine')).toEqual({ sent: true });
    expect(w.push.sent).toEqual([
      { token: 'fake-fcm-token-mine', message: { ...TEST_PUSH, orgId: 'org-1', tag: 'test-d-mine' } },
    ]);
  });

  it('refuses someone else’s device and a missing one as NOT_FOUND', async () => {
    const w = world();
    expect(await codeOf(w.run('d-theirs'))).toEqual(['NOT_FOUND', 'no_device']);
    expect(await codeOf(w.run('d-nope'))).toEqual(['NOT_FOUND', 'no_device']);
    expect(w.push.sent).toEqual([]);
  });

  it('deletes a device FCM reports gone, and reports a transient failure as UNAVAILABLE', async () => {
    const w = world();
    expect(await codeOf(w.run('d-gone'))).toEqual(['FAILED_PRECONDITION', 'invalid_token']);
    expect(w.docs.has('users/user-ada/devices/d-gone')).toBe(false);
    expect(await codeOf(w.run('d-flaky'))).toEqual(['UNAVAILABLE', null]);
    expect(w.docs.has('users/user-ada/devices/d-flaky')).toBe(true);
  });
});
