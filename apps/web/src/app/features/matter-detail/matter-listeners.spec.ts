import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';

import { cleanUpOverlays, openMatter } from './testing';

/**
 * Real-time reads on the matter screen (CORE-06): one listener on the matter, plus only the active
 * tab's collections, released when the tab is left. Fictional data only.
 */

afterEach(cleanUpOverlays);

describe('matter screen listeners', () => {
  it('listen to the matter plus the active tab’s collections only', async () => {
    const page = await openMatter('/matters/m-whitfield/notes');
    // A placeholder tab: the matter document (and whatever the shell keeps) only.
    const base = page.firestore.listenerCount;
    expect(base).toBeGreaterThan(0);

    await page.router.navigateByUrl('/matters/m-whitfield/overview');
    await page.stable();
    // Overview: deadlines, tasks and activity.
    expect(page.firestore.listenerCount).toBe(base + 3);

    await page.router.navigateByUrl('/matters/m-whitfield/parties');
    await page.stable();
    // Parties: the parties only; the overview's three are gone.
    expect(page.firestore.listenerCount).toBe(base + 1);

    // Tasks (CORE-08): the matter's tasks only.
    await page.router.navigateByUrl('/matters/m-whitfield/tasks');
    await page.stable();
    expect(page.firestore.listenerCount).toBe(base + 1);

    await page.router.navigateByUrl('/matters/m-whitfield/notes');
    await page.stable();
    expect(page.firestore.listenerCount).toBe(base);
  });

  it('follow the URL back to a tab with the browser’s back button', async () => {
    const page = await openMatter('/matters/m-whitfield/parties');
    const onParties = page.firestore.listenerCount;
    await page.router.navigateByUrl('/matters/m-whitfield/overview');
    await page.stable();
    expect(page.firestore.listenerCount).toBe(onParties + 2);
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
