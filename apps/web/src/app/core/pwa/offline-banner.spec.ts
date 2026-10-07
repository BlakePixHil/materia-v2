import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { Connectivity, FirestoreClient } from '@materia/data-access';
import { ToastService } from '@materia/ui';

import { MtOfflineBanner, MtPageOfflineNote, OFFLINE_COPY } from './offline-banner';
import { MtPendingSync } from './pending-sync';
import { OFFLINE_AFTER_MS, PENDING_AFTER_MS, UNREACHABLE_AFTER_MS } from './sync-status';

/** The shell's offline indicators (MOB-01) with a page that may show its own offline note. */
@Component({
  selector: 'mt-test-shell',
  imports: [MtOfflineBanner, MtPendingSync, MtPageOfflineNote],
  template: `
    <mt-pending-sync />
    <mt-offline-banner />
    @if (pageNote()) {
      <p mtPageOfflineNote>You’re offline. These are the matters as they were when you were last connected.</p>
    }
  `,
})
class TestShell {
  readonly pageNote = signal(false);
}

function setup() {
  const online = signal(true);
  const pendingWrites = signal(0);
  const cacheOnly = signal(false);
  TestBed.configureTestingModule({
    providers: [
      { provide: Connectivity, useValue: { online } },
      { provide: FirestoreClient, useValue: { pendingWrites, cacheOnly } },
    ],
  });
  const show = vi.spyOn(TestBed.inject(ToastService), 'show');
  const fixture = TestBed.createComponent(TestShell);
  const el = fixture.nativeElement as HTMLElement;
  const advance = async (ms: number) => {
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(ms);
    TestBed.tick();
  };
  return { fixture, el, online, pendingWrites, cacheOnly, show, advance };
}

const banner = (el: HTMLElement) => el.querySelector('[data-offline-banner]');
const badge = (el: HTMLElement) => el.querySelector('[data-pending-sync]');

describe('the offline indicators', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('shows the banner after 3 seconds offline, and says “Back online” when it clears', async () => {
    const { el, online, show, advance } = setup();
    await advance(0);
    online.set(false);
    await advance(OFFLINE_AFTER_MS - 100);
    expect(banner(el)).toBeNull();
    await advance(100);
    expect(banner(el)?.getAttribute('role')).toBe('status');
    expect(banner(el)?.textContent).toContain(`${OFFLINE_COPY.lead} ${OFFLINE_COPY.body}`);

    online.set(true);
    await advance(0);
    expect(banner(el)).toBeNull();
    expect(show).toHaveBeenCalledWith({ title: 'Back online', tone: 'success' });
  });

  it('stays away for a blip shorter than 3 seconds', async () => {
    const { el, online, show, advance } = setup();
    online.set(false);
    await advance(1000);
    online.set(true);
    await advance(OFFLINE_AFTER_MS);
    expect(banner(el)).toBeNull();
    expect(show).not.toHaveBeenCalled();
  });

  it('shows when the browser says online but no read reaches the server', async () => {
    const { el, cacheOnly, advance } = setup();
    cacheOnly.set(true);
    await advance(UNREACHABLE_AFTER_MS);
    expect(banner(el)).not.toBeNull();
  });

  it('leaves it to the page when the page shows its own offline note', async () => {
    const { el, fixture, online, advance } = setup();
    fixture.componentInstance.pageNote.set(true);
    online.set(false);
    await advance(OFFLINE_AFTER_MS);
    expect(banner(el)).toBeNull();
    fixture.componentInstance.pageNote.set(false);
    await advance(0);
    expect(banner(el)).not.toBeNull();
  });

  it('counts changes waiting to sync while offline', async () => {
    const { el, online, pendingWrites, advance } = setup();
    online.set(false);
    pendingWrites.set(1);
    await advance(0);
    expect(badge(el)?.textContent).toContain('1 change to sync');
    pendingWrites.set(3);
    await advance(0);
    expect(badge(el)?.textContent).toContain('3 changes to sync');
    expect(badge(el)?.getAttribute('title')).toContain('when you’re back online');
    pendingWrites.set(0);
    await advance(0);
    expect(badge(el)).toBeNull();
  });

  it('online, shows a change only once it takes more than a moment to sync', async () => {
    const { el, pendingWrites, advance } = setup();
    pendingWrites.set(1);
    await advance(PENDING_AFTER_MS - 100);
    expect(badge(el)).toBeNull();
    await advance(100);
    expect(badge(el)?.getAttribute('title')).toContain('Syncing');
  });
});
