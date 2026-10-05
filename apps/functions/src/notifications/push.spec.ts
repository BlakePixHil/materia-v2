import { classifyPushError, emulatorPush, fcmMessage, fcmPush } from './push';
import { memoryFirestore } from '../orgs/testing';

/** The FCM push adapter over a fake Messaging, and the emulator's outbox (FND-20). */

const message = {
  title: 'A critical deadline is due tomorrow',
  body: 'Open the matter.',
  link: '/matters/m1/deadlines',
};

describe('push adapters', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('builds a message that opens the app link on tap', () => {
    process.env['MATERIA_APP_URL'] = 'https://materia.example/';
    expect(fcmMessage('fake-token', message)).toEqual({
      token: 'fake-token',
      notification: { title: message.title, body: message.body },
      data: { link: '/matters/m1/deadlines' },
      webpush: { fcmOptions: { link: 'https://materia.example/matters/m1/deadlines' } },
    });
  });

  it('classifies FCM errors: gone tokens, transient failures, the rest', () => {
    expect(classifyPushError({ code: 'messaging/registration-token-not-registered' })).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
    expect(classifyPushError({ code: 'messaging/invalid-registration-token' })).toMatchObject({
      reason: 'invalid_token',
    });
    expect(classifyPushError({ code: 'messaging/server-unavailable' })).toMatchObject({ reason: 'transient' });
    expect(classifyPushError({ code: 'messaging/invalid-argument' })).toMatchObject({ reason: 'rejected' });
    expect(classifyPushError(null)).toMatchObject({ reason: 'rejected' });
  });

  it('sends through Messaging and reports failures without throwing', async () => {
    const sent: unknown[] = [];
    const ok = fcmPush(async () => ({
      send: async (payload: unknown) => {
        sent.push(payload);
        return 'projects/demo/messages/1';
      },
    }));
    expect(await ok.send('fake-token', message)).toEqual({ ok: true, id: 'projects/demo/messages/1' });
    expect(sent).toHaveLength(1);

    const gone = fcmPush(async () => ({
      send: async () => {
        throw Object.assign(new Error('gone'), { code: 'messaging/registration-token-not-registered' });
      },
    }));
    expect(await gone.send('fake-token', message)).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('writes to the emulator outbox, and reports invalid- tokens gone', async () => {
    const store = memoryFirestore();
    const push = emulatorPush(() => store.db);
    const result = await push.send('fake-token', message);
    expect(result).toMatchObject({ ok: true });
    const [[path, data]] = [...store.docs.entries()] as [[string, Record<string, unknown>]];
    expect(path.startsWith('emulatorPushOutbox/')).toBe(true);
    expect(data).toMatchObject({ token: 'fake-token', title: message.title, link: message.link });
    expect(await push.send('invalid-token', message)).toEqual({ ok: false, reason: 'invalid_token' });
    expect(store.docs.size).toBe(1);
  });
});
