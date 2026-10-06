import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { Connectivity, OrgContext } from '@materia/data-access';
import { InMemoryTimerPort, provideInMemoryFirestore } from '@materia/data-access/repository';

import { TimerStore } from './timer-store';
import { MtTimerWidget } from './timer-widget';

/** The shell's timer widget (BILL-02). */

const UID = 'user-jordan';
const NOW = Date.parse('2026-10-06T00:00:00.000Z');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function render(seed: boolean) {
  const port = new InMemoryTimerPort(() => new Date(NOW));
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideInMemoryFirestore(undefined, port),
      { provide: Connectivity, useValue: { online: signal(true) } },
    ],
  });
  TestBed.inject(OrgContext).setSession({ uid: UID, orgId: 'org-harbour-vine', role: 'lawyer' });
  TestBed.inject(TimerStore).now = () => NOW;
  if (seed)
    port.seed(UID, {
      orgId: 'org-harbour-vine',
      matterId: 'm-1',
      matterNumber: 'M-2026-0001',
      startedAt: new Date(NOW - 65 * 60_000),
      accumulatedMs: 0,
      running: true,
      narrativeDraft: '',
      lastHeartbeatAt: new Date(NOW),
      clientStarted: false,
    });
  const fixture = TestBed.createComponent(MtTimerWidget);
  for (let i = 0; i < 3; i++) {
    await settle();
    await fixture.whenStable();
  }
  return { fixture, el: fixture.nativeElement as HTMLElement, port };
}

describe('MtTimerWidget', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows the elapsed time (not live), the matter and the controls', async () => {
    const { el } = await render(true);
    const elapsed = el.querySelector('[data-testid="timer-elapsed"]');
    expect(elapsed?.textContent).toBe('1:05');
    expect(elapsed?.getAttribute('aria-live')).toBe('off');
    expect(el.querySelector('[data-testid="timer-matter"]')?.textContent?.trim()).toBe('M-2026-0001');
    const labels = [...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Pause timer', 'Stop timer', 'Switch matter', 'Announce the time']);
  });

  it('announces the time only when asked', async () => {
    const { el, fixture } = await render(true);
    const announcement = () => el.querySelector('[data-testid="timer-announcement"]')?.textContent?.trim();
    expect(announcement()).toBe('');
    (el.querySelector('button[aria-label="Announce the time"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(announcement()).toBe('Timer on M-2026-0001: 1 hour 5 minutes.');
  });

  it('is a start button with no timer', async () => {
    const { el } = await render(false);
    expect([...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Start timer']);
  });
});
