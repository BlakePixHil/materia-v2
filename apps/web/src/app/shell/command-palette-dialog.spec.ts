import { TestBed } from '@angular/core/testing';

import { DialogService, MT_KEYBOARD_PLATFORM } from '@materia/ui';

import { CommandPaletteDialog, PROVIDER_DEBOUNCE_MS } from './command-palette-dialog';
import { CommandRegistry } from '../core/commands/command-registry';

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('CommandPaletteDialog', () => {
  afterEach(() => document.querySelectorAll('.mt-overlay').forEach((node) => node.remove()));

  async function open() {
    localStorage.removeItem('materia.commands.recent');
    TestBed.configureTestingModule({ providers: [{ provide: MT_KEYBOARD_PLATFORM, useValue: 'other' }] });
    const registry = TestBed.inject(CommandRegistry);
    const goMatters = vi.fn();
    registry.register({
      id: 'go.matters',
      title: 'Go to Matters',
      group: 'Navigation',
      icon: 'matters',
      shortcut: 'g m',
      run: goMatters,
    });
    registry.register({ id: 'theme', title: 'Toggle theme', group: 'General', run: vi.fn() });
    const openMatter = vi.fn();
    const search = vi.fn(async (query: string) => [
      { id: 'M-2026-0142', title: `Estate of Example ${query}`, meta: 'M-2026-0142', run: openMatter },
    ]);
    registry.registerProvider({ id: 'matters', group: 'Matters', search });
    const handle = TestBed.inject(DialogService).open(CommandPaletteDialog);
    await settle();
    const input = document.querySelector('input[role="combobox"]') as HTMLInputElement;
    const type = async (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await settle(PROVIDER_DEBOUNCE_MS + 20);
    };
    const groups = () => [...document.querySelectorAll('.mt-menu-label')].map((g) => g.textContent?.trim());
    const options = () =>
      [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.replace(/\s+/g, ' ').trim());
    return { registry, handle, input, type, groups, options, goMatters, openMatter, search };
  }

  it('shows recent commands first, then every command by group, with shortcut hints', async () => {
    const { registry, groups, options, input } = await open();
    expect(groups()).toEqual(['Navigation', 'General']);
    expect(options()[0]).toContain('Go to Matters');
    expect(document.querySelector('[role="option"] .mt-kbd')).not.toBeNull();
    expect(document.activeElement).toBe(input);
    registry.recentIds.set(['theme']);
    await settle();
    expect(groups()).toEqual(['Recent', 'Navigation', 'General']);
  });

  it('fuzzy-matches commands and shows provider results after the debounce', async () => {
    const { type, groups, options, search } = await open();
    await type('mat');
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toBe('mat');
    expect(groups()).toEqual(['Commands', 'Matters']);
    expect(options()).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Go to Matters'),
        expect.stringContaining('Estate of Example mat'),
      ]),
    );
    await type('');
    expect(groups()).toEqual(['Navigation', 'General']);
  });

  it('runs a provider result and closes', async () => {
    const { type, openMatter, input, handle } = await open();
    await type('estate');
    const result = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
      o.textContent?.includes('Estate of Example'),
    );
    result?.click();
    await settle();
    expect(openMatter).toHaveBeenCalledTimes(1);
    expect(await handle.result).toBeUndefined();
    expect(input.isConnected).toBe(false);
  });

  it('runs a command, records it as recent and closes', async () => {
    const { goMatters, registry, input } = await open();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    expect(goMatters).toHaveBeenCalledTimes(1);
    expect(registry.recentIds()).toEqual(['go.matters']);
  });
});
