import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';

import { cleanUpOverlays, openMatter } from './testing';
import { NOTIFICATIONS_START_DELAY_MS } from '../../core/notifications/notifications-store';

/**
 * Real-time reads on the matter screen (CORE-06): one listener on the matter, plus only the active
 * tab's collections, released when the tab is left. Fictional data only.
 */

afterEach(cleanUpOverlays);

/**
 * The shell's unread-notifications listener starts at once, so it's in the baseline (by default it
 * waits 1.5 s, which a slow run could cross mid-test).
 */
const options = { providers: [{ provide: NOTIFICATIONS_START_DELAY_MS, useValue: 0 }] };

describe('matter screen listeners', () => {
  it('listen to the matter plus the active tab’s collections only', async () => {
    // Litigation is still a placeholder tab (on a contest matter): the matter document (and
    // whatever the shell keeps) only.
    const page = await openMatter('/matters/m-whitfield/litigation', { ...options, matter: { type: 'contest' } });
    const base = page.firestore.listenerCount;
    expect(base).toBeGreaterThan(0);

    await page.router.navigateByUrl('/matters/m-whitfield/overview');
    await page.stable();
    // Overview: pinned notes (CORE-13), deadlines, tasks and activity.
    expect(page.firestore.listenerCount).toBe(base + 4);

    await page.router.navigateByUrl('/matters/m-whitfield/parties');
    await page.stable();
    // Parties: the parties only; the overview's four are gone.
    expect(page.firestore.listenerCount).toBe(base + 1);

    // Tasks (CORE-08): the matter's tasks only.
    await page.router.navigateByUrl('/matters/m-whitfield/tasks');
    await page.stable();
    expect(page.firestore.listenerCount).toBe(base + 1);

    // Notes and Activity (CORE-13): their own collection each.
    await page.router.navigateByUrl('/matters/m-whitfield/notes');
    await page.stable();
    expect(page.firestore.listenerCount).toBe(base + 1);
    await page.router.navigateByUrl('/matters/m-whitfield/activity');
    await page.stable();
    expect(page.firestore.listenerCount).toBe(base + 1);

    // Time (BILL-01): the matter's time entries only (rates and settings are read once).
    await page.router.navigateByUrl('/matters/m-whitfield/time');
    await page.stable();
    expect(page.firestore.listenerCount).toBe(base + 1);

    await page.router.navigateByUrl('/matters/m-whitfield/litigation');
    await page.stable();
    expect(page.firestore.listenerCount).toBe(base);
  });

  it('follow the URL back to a tab with the browser’s back button', async () => {
    const page = await openMatter('/matters/m-whitfield/parties', options);
    const onParties = page.firestore.listenerCount;
    await page.router.navigateByUrl('/matters/m-whitfield/overview');
    await page.stable();
    expect(page.firestore.listenerCount).toBe(onParties + 3);
    // Back (the browser's button, through the router's Location): the tab comes back with its listener.
    // (A bootstrapped app listens for popstate from its initial navigation; a test sets it up here.)
    page.router.initialNavigation();
    await page.stable();
    TestBed.inject(Location).back();
    await page.stable(50);
    await page.stable();
    expect(page.router.url).toBe('/matters/m-whitfield/parties');
    expect(page.body.querySelector('mt-matter-parties')).not.toBeNull();
    expect(page.firestore.listenerCount).toBe(onParties);
  });
});
