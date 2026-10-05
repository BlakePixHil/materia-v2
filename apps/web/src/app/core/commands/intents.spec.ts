import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { intentUrl, onIntent } from './intents';
import { matterCommands } from './matter-commands';

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const ran = vi.fn();
const ready = signal(true);

@Component({ selector: 'mt-intent-host', changeDetection: ChangeDetectionStrategy.OnPush, template: '' })
class IntentHost {
  constructor() {
    onIntent('add-task', () => ran(), ready);
  }
}

describe('onIntent (CORE-15)', () => {
  beforeEach(() => {
    ran.mockReset();
    ready.set(true);
    TestBed.configureTestingModule({ providers: [provideRouter([{ path: 'tasks', component: IntentHost }])] });
  });

  it('runs once for its intent, after removing it from the address', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(intentUrl('/tasks', 'add-task'));
    await settle();
    expect(ran).toHaveBeenCalledTimes(1);
    expect(TestBed.inject(Router).url).toBe('/tasks');
  });

  it('waits until the page is ready, and ignores other intents', async () => {
    ready.set(false);
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(intentUrl('/tasks', 'upload'));
    await harness.navigateByUrl(intentUrl('/tasks', 'add-task'));
    await settle();
    expect(ran).not.toHaveBeenCalled();
    ready.set(true);
    harness.detectChanges();
    await settle();
    expect(ran).toHaveBeenCalledTimes(1);
  });
});

describe('matterCommands (CORE-15)', () => {
  const target = { id: 'm-142', number: 'M-2026-0142' };

  it('goes to the tab that hosts each action, with its intent', () => {
    const go = vi.fn();
    const commands = matterCommands(target, 'lawyer', go);
    const byTitle = (title: string) => commands.find((command) => command.title === title);
    expect(byTitle('Add task')?.href).toBe('/matters/m-142/tasks?do=add-task');
    expect(byTitle('Upload document')?.href).toBe('/matters/m-142/documents?do=upload');
    expect(byTitle('Close matter…')?.href).toBe('/matters/m-142/overview?do=close');
    expect(byTitle('Log time')?.href).toBe('/matters/m-142/time?do=log-time');
    byTitle('Add deadline')?.run();
    expect(go).toHaveBeenCalledWith('/matters/m-142/deadlines?do=add-deadline');
    expect(commands.every((command) => command.group === 'M-2026-0142')).toBe(true);
  });

  it('offers a read-only role only what it can do', () => {
    const offered = matterCommands(target, 'readonly', vi.fn())
      .filter((command) => !command.when || command.when())
      .map((command) => command.title);
    expect(offered).not.toContain('Add task');
    expect(offered).not.toContain('Upload document');
    expect(offered).not.toContain('Close matter…');
    expect(offered).not.toContain('Log time');
    expect(offered).toContain('Open documents');
  });
});
