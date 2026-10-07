import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { Connectivity } from '@materia/data-access';
import { MtButton, ToastService } from '@materia/ui';

import { MtNeedsConnection } from './needs-connection';
import { NEEDS_CONNECTION_COPY } from '../error-copy';

@Component({
  imports: [MtButton, MtNeedsConnection],
  template: `
    <button mtButton variant="primary" mtNeedsConnection [disabled]="locked()" (click)="approved = approved + 1">
      Approve invoice
    </button>
  `,
})
class Host {
  readonly locked = signal(false);
  approved = 0;
}

function setup() {
  const online = signal(true);
  TestBed.configureTestingModule({ providers: [{ provide: Connectivity, useValue: { online } }] });
  const show = vi.spyOn(TestBed.inject(ToastService), 'show');
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const button = (fixture.nativeElement as HTMLElement).querySelector('button') as HTMLButtonElement;
  return { fixture, button, online, show, host: fixture.componentInstance };
}

describe('mtNeedsConnection', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('runs the action online', async () => {
    const { fixture, button, host, show } = setup();
    await fixture.whenStable();
    button.click();
    expect(host.approved).toBe(1);
    expect(button.getAttribute('title')).toBeNull();
    expect(show).not.toHaveBeenCalled();
  });

  it('offline, says it needs a connection instead of running, and stays focusable', async () => {
    const { fixture, button, host, online, show } = setup();
    online.set(false);
    await fixture.whenStable();
    expect(button.getAttribute('title')).toBe(NEEDS_CONNECTION_COPY.short);
    expect(button.hasAttribute('data-needs-connection')).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);

    button.click();
    expect(host.approved).toBe(0);
    expect(show).toHaveBeenCalledWith({ title: NEEDS_CONNECTION_COPY.long });

    online.set(true);
    await fixture.whenStable();
    expect(button.getAttribute('aria-disabled')).toBeNull();
    button.click();
    expect(host.approved).toBe(1);
  });

  it('keeps a button its page disabled disabled', async () => {
    const { fixture, button, host, online } = setup();
    host.locked.set(true);
    online.set(false);
    await fixture.whenStable();
    expect(button.disabled).toBe(true);
    online.set(true);
    await fixture.whenStable();
    expect(button.disabled).toBe(true);
  });
});
