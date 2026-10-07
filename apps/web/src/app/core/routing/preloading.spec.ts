import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Route } from '@angular/router';
import { of } from 'rxjs';

import { DelayedPreloading, prefetchPagesDuringGuards, PRELOAD_DELAY_MS, saveData } from './preloading';

@Component({ template: '' })
class Page {}

describe('prefetchPagesDuringGuards', () => {
  it('starts downloading every page of the target while its guards are still waiting', async () => {
    let release!: () => void;
    const guard = new Promise<boolean>((resolve) => (release = () => resolve(true)));
    const shell = vi.fn(async () => Page);
    const today = vi.fn(async () => Page);
    const routes: Route[] = [
      {
        path: '',
        canActivate: [() => guard],
        loadComponent: shell,
        children: [{ path: 'today', loadComponent: today }],
      },
    ];
    TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
    TestBed.runInInjectionContext(prefetchPagesDuringGuards);
    const router = TestBed.inject(Router);

    const navigation = router.navigateByUrl('/today');
    await new Promise((resolve) => setTimeout(resolve));
    expect(shell).toHaveBeenCalled();
    expect(today).toHaveBeenCalled();
    expect(router.url).toBe('/');

    release();
    expect(await navigation).toBe(true);
    expect(router.url).toBe('/today');
  });

  it('leaves a failed download for the router to report', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('offline')));
    TestBed.configureTestingModule({ providers: [provideRouter([{ path: 'x', loadComponent: failing }])] });
    TestBed.runInInjectionContext(prefetchPagesDuringGuards);
    await expect(TestBed.inject(Router).navigateByUrl('/x')).rejects.toThrow('offline');
  });
});

describe('DelayedPreloading', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('downloads the other pages one at a time, once the delay has passed', async () => {
    const strategy = new DelayedPreloading();
    const loads: string[] = [];
    const load = (name: string) => () => {
      loads.push(name);
      return of(null);
    };
    const done = [strategy.preload({ path: 'a' }, load('a')), strategy.preload({ path: 'b' }, load('b'))].map(
      (observable) => new Promise((resolve) => observable.subscribe({ complete: () => resolve(true) })),
    );

    await vi.advanceTimersByTimeAsync(PRELOAD_DELAY_MS - 1);
    expect(loads).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.all(done)).toEqual([true, true]);
    expect(loads).toEqual(['a', 'b']);
  });

  it('skips routes that opt out', async () => {
    const strategy = new DelayedPreloading();
    const load = vi.fn(() => of(null));
    strategy.preload({ path: 'a', data: { preload: false } }, load).subscribe();
    await vi.advanceTimersByTimeAsync(PRELOAD_DELAY_MS);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('saveData', () => {
  it('is on for Save-Data and 2G connections only', () => {
    const nav = (connection?: object) => ({ connection }) as unknown as Navigator;
    expect(saveData(nav())).toBe(false);
    expect(saveData(nav({ effectiveType: '4g' }))).toBe(false);
    expect(saveData(nav({ saveData: true, effectiveType: '4g' }))).toBe(true);
    expect(saveData(nav({ effectiveType: 'slow-2g' }))).toBe(true);
    expect(saveData(nav({ effectiveType: '2g' }))).toBe(true);
  });
});
