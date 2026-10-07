import { TestBed } from '@angular/core/testing';

import { OrgContext } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';

import { PUSH_REFRESH_MS, PushDevices } from './push-devices';
import { PUSH_PLATFORM } from './push-platform';
import { fakePushPlatform, type FakePushPlatform } from './testing';

/** This browser as a push device (MOB-04), against the in-memory Firestore. Fictional data only. */

const UID = 'user-jordan';
const DEVICE = `users/${UID}/devices/device-this-1`;
const NOW = Date.parse('2026-10-07T09:00:00Z');
const meta = { createdAt: new Date(NOW), createdBy: UID, updatedAt: new Date(NOW), updatedBy: UID, schemaVersion: 1 };
const device = (token = 'fake-fcm-token-1') => ({
  token,
  platform: 'web',
  label: 'Chrome on macOS',
  lastSeenAt: new Date(NOW - 3 * PUSH_REFRESH_MS),
  ...meta,
});

function setUp(platform: FakePushPlatform = fakePushPlatform(), seed?: (fs: InMemoryFirestore) => void) {
  const firestore = new InMemoryFirestore();
  seed?.(firestore);
  TestBed.configureTestingModule({
    providers: [...provideInMemoryFirestore(firestore), { provide: PUSH_PLATFORM, useValue: platform }],
  });
  TestBed.inject(OrgContext).setSession({ uid: UID, orgId: 'org-harbour-vine', role: 'lawyer' });
  return { firestore, platform, push: TestBed.inject(PushDevices) };
}

describe('PushDevices', () => {
  it('asks only when turned on, then registers this browser and remembers it', async () => {
    const { firestore, platform, push } = setUp();
    await push.load();
    expect(push.status()).toBe('off');
    expect(platform.prompts).toBe(0);

    expect(await push.enable()).toBe('on');
    expect(platform.prompts).toBe(1);
    expect(firestore.get(DEVICE)).toMatchObject({
      token: 'fake-fcm-token-1',
      platform: 'web',
      label: 'Chrome on macOS',
    });
    expect(platform.store.record).toMatchObject({ uid: UID, token: 'fake-fcm-token-1' });
    expect(push.status()).toBe('on');
    expect(push.deviceId()).toBe('device-this-1');

    // Turning it on again updates the same device rather than adding another.
    platform.nextToken = 'fake-fcm-token-2';
    await push.enable();
    expect(firestore.get(DEVICE)).toMatchObject({ token: 'fake-fcm-token-2' });
  });

  it('registers nothing when the browser says no, or the prompt is dismissed', async () => {
    const denied = setUp(fakePushPlatform({ answer: 'denied' }));
    expect(await denied.push.enable()).toBe('denied');
    expect(denied.push.status()).toBe('denied');
    expect(denied.firestore.get(DEVICE)).toBeUndefined();
    TestBed.resetTestingModule();

    const dismissed = setUp(fakePushPlatform({ answer: 'default' }));
    expect(await dismissed.push.enable()).toBe('dismissed');
    expect(dismissed.push.status()).toBe('off');
    expect(dismissed.platform.store.record).toBeNull();
  });

  it('reports install (Safari on an iPhone) and unsupported browsers without asking', async () => {
    const iphone = setUp(fakePushPlatform({ supportIs: 'install' }));
    await iphone.push.load();
    expect(iphone.push.status()).toBe('install');
    TestBed.resetTestingModule();
    const old = setUp(fakePushPlatform({ supportIs: 'unsupported' }));
    expect(old.push.status()).toBe('unsupported');
  });

  it('turns off: deletes the device, unsubscribes and forgets it', async () => {
    const { firestore, platform, push } = setUp();
    await push.enable();
    await push.disable();
    expect(firestore.get(DEVICE)).toBeUndefined();
    expect(platform.unsubscribed).toBe(1);
    expect(platform.store.record).toBeNull();
    expect(push.status()).toBe('off');
  });

  describe('refresh on start', () => {
    const registered = (extra: Partial<FakePushPlatform> = {}) =>
      setUp(fakePushPlatform({ permissionIs: 'granted', ...extra }), (fs) => fs.set(DEVICE, device()));

    it('does nothing within a day of the last refresh', async () => {
      const { firestore, platform, push } = registered();
      platform.store.record = { uid: UID, token: 'fake-fcm-token-1', refreshedAt: NOW - 1000 };
      platform.nextToken = 'fake-fcm-token-new';
      await push.refresh(NOW);
      expect(firestore.get(DEVICE)).toMatchObject({ token: 'fake-fcm-token-1' });
      expect(push.status()).toBe('on');
    });

    it('after a day, writes a new token and last-seen date', async () => {
      const { firestore, platform, push } = registered();
      platform.store.record = { uid: UID, token: 'fake-fcm-token-1', refreshedAt: NOW - PUSH_REFRESH_MS - 1 };
      platform.nextToken = 'fake-fcm-token-rotated';
      await push.refresh(NOW);
      const stored = firestore.get(DEVICE) as { token: string; lastSeenAt: Date };
      expect(stored.token).toBe('fake-fcm-token-rotated');
      expect(stored.lastSeenAt.getTime()).toBeGreaterThan(NOW - 3 * PUSH_REFRESH_MS);
      expect(platform.store.record).toMatchObject({ token: 'fake-fcm-token-rotated', refreshedAt: NOW });
    });

    it('forgets the registration when another device removed this one', async () => {
      const { firestore, platform, push } = registered();
      firestore.delete(DEVICE);
      platform.store.record = { uid: UID, token: 'fake-fcm-token-1', refreshedAt: NOW - PUSH_REFRESH_MS - 1 };
      await push.refresh(NOW);
      expect(firestore.get(DEVICE)).toBeUndefined();
      expect(platform.store.record).toBeNull();
      expect(platform.unsubscribed).toBe(1);
      expect(push.status()).toBe('off');
    });

    it('deletes the device when the browser no longer allows notifications', async () => {
      const { firestore, platform, push } = registered({ permissionIs: 'default' });
      platform.store.record = { uid: UID, token: 'fake-fcm-token-1', refreshedAt: NOW - 1000 };
      await push.refresh(NOW);
      expect(firestore.get(DEVICE)).toBeUndefined();
      expect(platform.store.record).toBeNull();
    });

    it('leaves another person’s registration alone', async () => {
      const { firestore, platform, push } = registered();
      platform.store.record = { uid: 'user-someone-else', token: 'fake-fcm-token-1', refreshedAt: 0 };
      await push.refresh(NOW);
      expect(firestore.get(DEVICE)).toBeDefined();
      expect(platform.store.record).toMatchObject({ uid: 'user-someone-else' });
    });
  });

  it('on sign-out, deletes this device and forgets it, and never throws', async () => {
    const { firestore, platform, push } = setUp();
    await push.enable();
    await push.signOut();
    expect(firestore.get(DEVICE)).toBeUndefined();
    expect(platform.store.record).toBeNull();
    expect(platform.unsubscribed).toBe(1);

    platform.store.read = async () => {
      throw new Error('IndexedDB unavailable');
    };
    await expect(push.signOut()).resolves.toBeUndefined();
  });
});
