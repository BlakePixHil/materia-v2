import { DestroyRef, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ListenerRegistry } from './listener-registry';

describe('ListenerRegistry', () => {
  it('tracks listeners, releases one at a time, and stops the rest at once', () => {
    const registry = TestBed.inject(ListenerRegistry);
    const stopped: string[] = [];
    const releaseA = registry.add(() => stopped.push('a'), { label: 'orgs/o/members' });
    registry.add(() => stopped.push('b'));
    expect(registry.active()).toBe(2);
    expect(registry.labels()).toEqual(['orgs/o/members', 'listener']);

    releaseA();
    releaseA();
    expect(stopped).toEqual(['a']);
    expect(registry.active()).toBe(1);

    registry.stopAll();
    expect(stopped).toEqual(['a', 'b']);
    expect(registry.active()).toBe(0);
  });

  it('runs store resets on stopAll, and survives a failing stop or reset', () => {
    const registry = TestBed.inject(ListenerRegistry);
    const reset = vi.fn();
    const unregister = registry.onReset(reset);
    registry.onReset(() => {
      throw new Error('broken store');
    });
    registry.add(() => {
      throw new Error('already torn down');
    });
    registry.stopAll();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(registry.active()).toBe(0);
    unregister();
    registry.stopAll();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('stops a listener with its DestroyRef, and at once when that is already destroyed', () => {
    const registry = TestBed.inject(ListenerRegistry);
    const injector = Injector.create({ providers: [], parent: TestBed.inject(Injector) }) as Injector & {
      destroy(): void;
    };
    const destroyRef = injector.get(DestroyRef);
    const stop = vi.fn();
    const release = registry.add(stop, { destroyRef });
    injector.destroy();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(registry.active()).toBe(0);
    release();
    expect(stop).toHaveBeenCalledTimes(1);

    const late = vi.fn();
    registry.add(late, { destroyRef });
    expect(late).toHaveBeenCalledTimes(1);
    expect(registry.active()).toBe(0);
  });
});
