import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type UrlTree } from '@angular/router';

import {
  FeatureFlagService,
  FLAG_SOURCE,
  lazyFirebaseFlagSource,
  LOCAL_FLAGS_KEY,
  type FlagValueSource,
} from './feature-flags';
import { flagGuard, MtFlag } from './flag';
import { fakeFlagSource } from './testing';
import { FlagsDevPage } from '../../dev/flags-page';
import { AUTH_PORT } from '../auth/auth-port';
import { FakeAuthPort, testSession } from '../auth/testing';

const settle = () => new Promise((resolve) => setTimeout(resolve));

function setup(source: FlagValueSource, port = new FakeAuthPort()) {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: AUTH_PORT, useValue: port }, { provide: FLAG_SOURCE, useValue: source }],
  });
  return { flags: TestBed.inject(FeatureFlagService), port };
}

// Local dev overrides live in localStorage: start every test without any.
beforeEach(() => localStorage.removeItem(LOCAL_FLAGS_KEY));

describe('FeatureFlagService', () => {
  it('merges org override > Remote Config > default for the active org', async () => {
    const { flags } = setup(
      fakeFlagSource(
        { 'litigation.enabled': true, 'billing.invoicing': true },
        { 'org-harbour-vine': { 'billing.invoicing': false } },
      ),
    );
    await flags.ready();
    expect(flags.isOn('litigation.enabled')).toBe(true);
    expect(flags.isOn('billing.invoicing')).toBe(false);
    expect(flags.isOn('mobile.voice')).toBe(false);
    expect(flags.flag('system.echo')()).toBe(true);
    expect(flags.all().find((f) => f.key === 'billing.invoicing')).toEqual({
      key: 'billing.invoicing',
      value: false,
      source: 'org',
    });
  });

  it('follows org switches and sign-out', async () => {
    const { flags, port } = setup(
      fakeFlagSource(
        {},
        { 'org-harbour-vine': { 'litigation.enabled': true }, 'org-other': { 'litigation.enabled': false } },
      ),
    );
    await flags.ready();
    expect(flags.isOn('litigation.enabled')).toBe(true);
    port.emit(testSession({ claims: { orgId: 'org-other', role: 'owner' } }));
    await flags.ready();
    await settle();
    expect(flags.isOn('litigation.enabled')).toBe(false);
    port.emit(null);
    await flags.ready();
    expect(flags.all().every((f) => f.source === 'default')).toBe(true);
  });

  it('applies the cached Remote Config values at once, then a newer fetch when it lands', async () => {
    let fetched!: (values: Record<string, boolean>) => void;
    const { flags } = setup({
      remote: async (updated) => {
        fetched = (values) => updated?.(values);
        return { 'litigation.enabled': true };
      },
      org: async () => ({}),
    });
    await flags.ready();
    expect(flags.isOn('litigation.enabled')).toBe(true);
    fetched({ 'litigation.enabled': false, 'billing.invoicing': true });
    expect(flags.isOn('litigation.enabled')).toBe(false);
    expect(flags.isOn('billing.invoicing')).toBe(true);
  });

  it('falls back to defaults when Remote Config and the org document fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { flags } = setup({
      remote: () => Promise.reject(new Error('offline')),
      org: () => Promise.reject(new Error('offline')),
    });
    await flags.ready();
    expect(flags.isOn('system.echo')).toBe(true);
    expect(flags.isOn('litigation.enabled')).toBe(false);
    expect(warn).toHaveBeenCalledWith('Remote Config unavailable; using flag defaults');
    warn.mockRestore();
  });

  it('keeps local overrides in dev builds', async () => {
    localStorage.setItem(LOCAL_FLAGS_KEY, JSON.stringify({ 'mobile.voice': true, 'not.a.flag': true }));
    const { flags } = setup(fakeFlagSource());
    await flags.ready();
    expect(flags.all().find((f) => f.key === 'mobile.voice')?.source).toBe('local');
    flags.setLocal('litigation.enabled', true);
    expect(flags.isOn('litigation.enabled')).toBe(true);
    expect(JSON.parse(localStorage.getItem(LOCAL_FLAGS_KEY) ?? '{}')).toEqual({
      'mobile.voice': true,
      'litigation.enabled': true,
    });
    flags.setLocal('litigation.enabled', undefined);
    expect(flags.isOn('litigation.enabled')).toBe(false);
  });
});

describe('flagGuard', () => {
  it('lets the route through while the flag is on, otherwise sends to Today', async () => {
    const { flags } = setup(fakeFlagSource({ 'litigation.enabled': true }));
    const allowed = await TestBed.runInInjectionContext(() =>
      flagGuard('litigation.enabled')({} as never, [] as never),
    );
    expect(allowed).toBe(true);
    const denied = (await TestBed.runInInjectionContext(() =>
      flagGuard('mobile.voice')({} as never, [] as never),
    )) as UrlTree;
    expect(TestBed.inject(Router).serializeUrl(denied)).toBe('/today');
    expect(flags).toBeDefined();
  });
});

@Component({
  imports: [MtFlag],
  template: `<span id="on" *mtFlag="key()">shown</span>`,
})
class FlagHost {
  readonly key = signal<'litigation.enabled' | 'mobile.voice'>('litigation.enabled');
}

describe('MtFlag', () => {
  it('renders while the flag is on and follows changes', async () => {
    const { flags } = setup(fakeFlagSource({ 'litigation.enabled': true }));
    await flags.ready();
    const fixture = TestBed.createComponent(FlagHost);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#on')?.textContent).toBe('shown');
    fixture.componentInstance.key.set('mobile.voice');
    await fixture.whenStable();
    expect(el.querySelector('#on')).toBeNull();
    flags.setLocal('mobile.voice', true);
    await fixture.whenStable();
    expect(el.querySelector('#on')).not.toBeNull();
  });
});

describe('lazyFirebaseFlagSource', () => {
  it('loads the implementation once, on first use', async () => {
    const real = fakeFlagSource({ 'litigation.enabled': true }, { 'org-a': { x: 1 } });
    const load = vi.fn(async () => real);
    const source = lazyFirebaseFlagSource(load);
    expect(load).not.toHaveBeenCalled();
    expect(await source.remote()).toEqual({ 'litigation.enabled': true });
    expect(await source.org('org-a')).toEqual({ x: 1 });
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('FlagsDevPage', () => {
  it('lists every flag with its source and toggles local overrides', async () => {
    const { flags } = setup(fakeFlagSource());
    await flags.ready();
    const fixture = TestBed.createComponent(FlagsDevPage);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const row = [...el.querySelectorAll('tbody tr')].find((r) =>
      r.textContent?.includes('litigation.enabled'),
    ) as HTMLElement;
    expect(row.textContent).toContain('LIT-01');
    expect(row.textContent).toContain('default');
    row.querySelector('button')?.click();
    await fixture.whenStable();
    expect(flags.isOn('litigation.enabled')).toBe(true);
    expect(row.textContent).toContain('local');
    const reset = [...row.querySelectorAll('button')].find((b) => b.textContent?.includes('Reset'));
    reset?.click();
    await fixture.whenStable();
    expect(flags.isOn('litigation.enabled')).toBe(false);
  });
});
