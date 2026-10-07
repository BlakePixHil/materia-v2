import { Component, signal } from '@angular/core';
import { render } from '@testing-library/angular';

import { MtPullToRefresh } from './pull-refresh';

@Component({
  imports: [MtPullToRefresh],
  template: `<mt-pull-refresh [refreshing]="refreshing()" (refresh)="refreshes = refreshes + 1" />`,
})
class Host {
  readonly refreshing = signal(false);
  refreshes = 0;
}

/** A touch event on the document; jsdom has no `Touch`, so the touches are plain points. */
function touch(type: 'touchstart' | 'touchmove' | 'touchend', ...points: number[]) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'touches', { value: points.map((clientY) => ({ clientY })) });
  document.dispatchEvent(event);
}

/** Pulls down from the top of the page by `dy` px of finger travel, then lets go. */
function pull(dy: number, release = true) {
  touch('touchstart', 100);
  touch('touchmove', 100 + dy / 2);
  touch('touchmove', 100 + dy);
  if (release) touch('touchend');
}

describe('MtPullToRefresh', () => {
  it('refreshes when pulled far enough from the top of the page, with a finger', async () => {
    const { fixture, container } = await render(Host);
    const indicator = container.querySelector('mt-pull-refresh') as HTMLElement;
    pull(80);
    expect(fixture.componentInstance.refreshes).toBe(0);
    pull(200);
    expect(fixture.componentInstance.refreshes).toBe(1);
    fixture.detectChanges();
    expect(indicator).not.toHaveAttribute('data-pulling');
  });

  it('says what letting go will do while pulling, and “Refreshing…” after', async () => {
    const { fixture, container } = await render(Host);
    const indicator = container.querySelector('mt-pull-refresh') as HTMLElement;
    pull(60, false);
    fixture.detectChanges();
    expect(indicator).toHaveAttribute('data-pulling');
    expect(indicator).not.toHaveAttribute('data-ready');
    expect(indicator.textContent).toContain('Pull to refresh');
    expect(indicator.style.getPropertyValue('--mt-pull')).toBe('30px');
    touch('touchmove', 300);
    fixture.detectChanges();
    expect(indicator).toHaveAttribute('data-ready');
    expect(indicator.textContent).toContain('Release to refresh');
    expect(indicator.style.getPropertyValue('--mt-pull')).toBe('96px');
    touch('touchend');

    fixture.componentInstance.refreshing.set(true);
    fixture.detectChanges();
    expect(indicator).toHaveAttribute('data-refreshing');
    expect(indicator.querySelector('[role="status"]')?.textContent).toBe('Refreshing…');
    // A pull while refreshing does nothing.
    pull(200);
    expect(fixture.componentInstance.refreshes).toBe(1);
  });

  it('ignores a pull once the page has scrolled, or with two fingers', async () => {
    const { fixture } = await render(Host);
    const scrollY = vi.spyOn(window, 'scrollY', 'get').mockReturnValue(120);
    try {
      pull(200);
    } finally {
      scrollY.mockRestore();
    }
    touch('touchstart', 100, 300);
    touch('touchmove', 400, 600);
    touch('touchend');
    expect(fixture.componentInstance.refreshes).toBe(0);
  });

  it('turns off the browser’s own pull-to-reload while on the page, and restores it', async () => {
    const root = document.documentElement;
    root.style.overscrollBehaviorY = 'auto';
    const { fixture } = await render(Host);
    expect(root.style.overscrollBehaviorY).toBe('contain');
    fixture.destroy();
    expect(root.style.overscrollBehaviorY).toBe('auto');
    root.style.overscrollBehaviorY = '';
  });
});
