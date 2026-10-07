import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SwUpdate } from '@angular/service-worker';

import { OfflineCache } from './offline-cache';

/** A window with a service worker container, the page's loaded resources and a recording fetch. */
function fakeView(options: { controller?: object | null; resources?: string[] } = {}) {
  const listeners: (() => void)[] = [];
  const fetched: string[] = [];
  const view = {
    location: { href: 'https://app.materia.example/today', origin: 'https://app.materia.example' },
    navigator: {
      serviceWorker: {
        controller: options.controller ?? null,
        addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
      },
    },
    performance: {
      getEntriesByType: () => (options.resources ?? []).map((name) => ({ name })),
    },
    fetch: vi.fn(async (file: string) => void fetched.push(file)),
  };
  return { view, fetched, takeControl: () => listeners.forEach((listener) => listener()) };
}

function setup(view: object, enabled = true) {
  TestBed.configureTestingModule({
    providers: [
      { provide: SwUpdate, useValue: { isEnabled: enabled } },
      { provide: DOCUMENT, useValue: { defaultView: view } },
    ],
  });
  return TestBed.inject(OfflineCache);
}

describe('OfflineCache', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('fetches the first page’s scripts, styles and fonts again once the worker takes control', async () => {
    const fake = fakeView({
      resources: [
        'https://app.materia.example/main-ABC.js',
        'https://app.materia.example/styles-DEF.css',
        'https://app.materia.example/fonts/geist.woff2',
        'https://app.materia.example/main-ABC.js',
        'https://app.materia.example/assets/icons/icon-192.png',
        'https://firestore.googleapis.com/channel.js',
      ],
    });
    setup(fake.view).start();
    expect(fake.fetched).toEqual([]);
    fake.takeControl();
    await vi.waitFor(() => expect(fake.fetched).toHaveLength(3));
    expect(fake.fetched).toEqual(['/main-ABC.js', '/styles-DEF.css', '/fonts/geist.woff2']);
  });

  it('does nothing when the worker already controls the page, or there is none', () => {
    const controlled = fakeView({ controller: {}, resources: ['https://app.materia.example/main-ABC.js'] });
    setup(controlled.view).start();
    controlled.takeControl();
    expect(controlled.view.fetch).not.toHaveBeenCalled();
    TestBed.resetTestingModule();

    const off = fakeView({ resources: ['https://app.materia.example/main-ABC.js'] });
    setup(off.view, false).start();
    off.takeControl();
    expect(off.view.fetch).not.toHaveBeenCalled();
  });
});
