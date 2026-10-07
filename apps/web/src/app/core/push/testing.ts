import type { PushPlatform, PushSupport } from './push-platform';
import type { PushRegistrationRecord, PushStore } from './push-store';

/** The browser's push for unit tests (MOB-04): permission, tokens and the device store in memory. */
export interface FakePushPlatform extends PushPlatform {
  supportIs: PushSupport;
  permissionIs: NotificationPermission;
  /** What the browser's prompt answers. */
  answer: NotificationPermission;
  /** The next token handed out. */
  nextToken: string;
  prompts: number;
  unsubscribed: number;
  readonly store: PushStore & { record: PushRegistrationRecord | null };
}

export function fakePushPlatform(overrides: Partial<FakePushPlatform> = {}): FakePushPlatform {
  const store = {
    record: null as PushRegistrationRecord | null,
    deviceId: async () => 'device-this-1',
    read: async () => store.record,
    save: async (record: PushRegistrationRecord) => {
      store.record = record;
    },
    clear: async () => {
      store.record = null;
    },
  };
  const platform: FakePushPlatform = {
    supportIs: 'ok',
    permissionIs: 'default',
    answer: 'granted',
    nextToken: 'fake-fcm-token-1',
    prompts: 0,
    unsubscribed: 0,
    support: () => platform.supportIs,
    permission: () => platform.permissionIs,
    requestPermission: async () => {
      platform.prompts += 1;
      platform.permissionIs = platform.answer;
      return platform.answer;
    },
    token: async () => platform.nextToken,
    unsubscribe: async () => {
      platform.unsubscribed += 1;
    },
    describe: () => ({ platform: 'web', label: 'Chrome on macOS' }),
    store,
    ...overrides,
  };
  return platform;
}
