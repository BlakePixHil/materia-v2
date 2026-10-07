import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

// MOB-04: the app's service worker (apps/web/public/sw.js) shows push notifications itself and
// routes taps. It runs here in a sandbox with a fake `self`, without Angular's worker.
const root = path.resolve(import.meta.dirname, '../../..');
const source = readFileSync(path.join(root, 'apps/web/public/sw.js'), 'utf8');

type Listener = (event: Record<string, unknown>) => void;
interface FakeClient {
  url: string;
  focused: boolean;
  visibilityState: 'visible' | 'hidden';
  focus: () => Promise<void>;
  postMessage: (message: unknown) => void;
}

function worker(windows: Partial<FakeClient>[] = []) {
  const listeners = new Map<string, Listener[]>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const clients: (FakeClient & { messages: unknown[]; focusCount: number })[] = windows.map((each) => {
    const client = {
      url: 'https://materia.example/today',
      focused: false,
      visibilityState: 'hidden' as const,
      messages: [] as unknown[],
      focusCount: 0,
      ...each,
      focus: async () => {
        client.focusCount += 1;
      },
      postMessage: (message: unknown) => client.messages.push(message),
    };
    return client;
  });
  const self = {
    location: new URL('https://materia.example/sw.js'),
    fetch: async () => new Response(''),
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }),
    },
    clients: {
      matchAll: async () => clients,
      openWindow: async (url: string) => void opened.push(url),
    },
  };
  runInNewContext(source, {
    self,
    importScripts: () => undefined,
    URL,
    URLSearchParams,
    Request,
    setTimeout,
    clearTimeout,
  });

  /** Dispatches like a browser: listeners in order, until one stops propagation. */
  async function dispatch(type: string, fields: Record<string, unknown>) {
    let stopped = false;
    const waits: Promise<unknown>[] = [];
    const event = {
      ...fields,
      stopImmediatePropagation: () => (stopped = true),
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    };
    for (const listener of listeners.get(type) ?? []) {
      listener(event);
      if (stopped) break;
    }
    await Promise.all(waits);
    return { stopped };
  }
  const push = (payload: unknown) =>
    dispatch('push', { data: { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload) } });
  const tap = (data: unknown) => {
    const notification = { data, closed: false, close: () => (notification.closed = true) };
    return dispatch('notificationclick', { notification }).then((result) => ({ ...result, notification }));
  };
  return { shown, opened, clients, push, tap };
}

describe('service worker push (MOB-04)', () => {
  it('shows an FCM push with its title, body, icon and tag, and keeps it from Angular’s worker', async () => {
    const sw = worker();
    const result = await sw.push({
      notification: { title: 'Deadline in 3 days: M-2026-0142', body: 'Open Materia to see it.' },
      data: { link: '/matters/m-1/deadlines', orgId: 'org-1', tag: 'n-1' },
      from: '000000000000',
    });
    expect(result.stopped).toBe(true);
    expect(sw.shown).toEqual([
      {
        title: 'Deadline in 3 days: M-2026-0142',
        options: {
          body: 'Open Materia to see it.',
          icon: '/assets/icons/icon-192.png',
          tag: 'n-1',
          data: { url: '/open?to=%2Fmatters%2Fm-1%2Fdeadlines&org=org-1' },
        },
      },
    ]);
  });

  it('still shows something for a push it can’t read (Safari requires one per push)', async () => {
    const sw = worker();
    await sw.push('not json {');
    expect(sw.shown).toEqual([
      {
        title: 'Materia',
        options: { body: '', icon: '/assets/icons/icon-192.png', data: { url: '/open?to=%2Ftoday' } },
      },
    ]);
  });

  it('sends a link that isn’t an app path to Today', async () => {
    const sw = worker();
    for (const link of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'matters/m-1']) {
      await sw.push({ notification: { title: 'Hi' }, data: { link } });
    }
    expect(sw.shown.map((each) => (each.options['data'] as { url: string }).url)).toEqual(
      Array(4).fill('/open?to=%2Ftoday'),
    );
  });

  it('a tap opens a new window when Materia isn’t open', async () => {
    const sw = worker();
    const { stopped, notification } = await sw.tap({ url: '/open?to=%2Fmatters%2Fm-1&org=org-1' });
    expect(stopped).toBe(true);
    expect(notification.closed).toBe(true);
    expect(sw.opened).toEqual(['/open?to=%2Fmatters%2Fm-1&org=org-1']);
  });

  it('a tap focuses the focused (or a visible) Materia window and asks it to open the link', async () => {
    const sw = worker([
      { url: 'https://other.example/' },
      { url: 'https://materia.example/matters', visibilityState: 'visible' },
      { url: 'https://materia.example/today', focused: true },
    ]);
    await sw.tap({ url: '/open?to=%2Fmatters%2Fm-1' });
    expect(sw.opened).toEqual([]);
    const [, visible, focused] = sw.clients;
    expect(focused?.focusCount).toBe(1);
    expect(focused?.messages).toEqual([{ type: 'materia:push-open', url: '/open?to=%2Fmatters%2Fm-1' }]);
    expect(visible?.messages).toEqual([]);

    const background = worker([{ url: 'https://materia.example/today' }]);
    await background.tap({});
    expect(background.clients[0]?.messages).toEqual([{ type: 'materia:push-open', url: '/today' }]);
  });
});
