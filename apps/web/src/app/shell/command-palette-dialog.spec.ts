import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { OrgContext } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { matterSearchTokens } from '@materia/domain';
import { DialogService, MT_KEYBOARD_PLATFORM } from '@materia/ui';

import { CommandPaletteDialog, MIN_SEARCH_LENGTH, PROVIDER_DEBOUNCE_MS } from './command-palette-dialog';
import { CommandRegistry, type CommandResult } from '../core/commands/command-registry';

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** The ⌘K palette (FND-12, CORE-15). Every matter and person here is fictional. */
describe('CommandPaletteDialog', () => {
  afterEach(() => document.querySelectorAll('.mt-overlay').forEach((node) => node.remove()));

  async function open(options: { seed?: (fs: InMemoryFirestore) => void; session?: boolean } = {}) {
    localStorage.removeItem('materia.commands.recent');
    const fs = new InMemoryFirestore();
    options.seed?.(fs);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideInMemoryFirestore(fs),
        { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      ],
    });
    if (options.session) TestBed.inject(OrgContext).setSession({ uid: 'u-jordan', orgId: 'org-a', role: 'lawyer' });
    const registry = TestBed.inject(CommandRegistry);
    const goMatters = vi.fn();
    registry.register({
      id: 'go.matters',
      title: 'Go to Matters',
      group: 'Navigation',
      icon: 'matters',
      shortcut: 'g m',
      href: '/matters',
      run: goMatters,
    });
    registry.register({ id: 'theme', title: 'Toggle theme', group: 'General', run: vi.fn() });
    const addTask = vi.fn();
    const openMatter = vi.fn();
    const matter = (query: string): CommandResult => ({
      id: 'matter:m-142',
      title: `Estate of Example ${query}`,
      meta: 'M-2026-0142',
      mono: true,
      href: '/matters/m-142/overview',
      children: () => [{ id: 'matter.add-task', title: 'Add task', group: 'M-2026-0142', run: addTask }],
      run: openMatter,
    });
    const search = vi.fn(async (query: string) => [matter(query)]);
    registry.registerProvider({ id: 'matters', group: 'Matters', search });
    const handle = TestBed.inject(DialogService).open(CommandPaletteDialog);
    await settle();
    const input = document.querySelector('input[role="combobox"]') as HTMLInputElement;
    const type = async (value: string, wait = PROVIDER_DEBOUNCE_MS + 20) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await settle(wait);
    };
    const key = async (name: string, init: KeyboardEventInit = {}) => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
      await settle();
    };
    const groups = () => [...document.querySelectorAll('.mt-menu-label')].map((g) => g.textContent?.trim());
    const options_ = () =>
      [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.replace(/\s+/g, ' ').trim());
    const status = () => [...document.querySelectorAll('.mt-cmdk-status')].map((s) => s.textContent?.trim());
    return {
      registry,
      handle,
      input,
      type,
      key,
      groups,
      options: options_,
      status,
      goMatters,
      openMatter,
      addTask,
      search,
    };
  }

  it('shows recent commands first, then every command by group, with shortcut hints', async () => {
    const { registry, groups, options, input } = await open();
    expect(groups()).toEqual(['Navigation', 'General']);
    expect(options()[0]).toContain('Go to Matters');
    expect(document.querySelector('[role="option"] .mt-kbd')).not.toBeNull();
    expect(document.activeElement).toBe(input);
    registry.recentIds.set(['theme']);
    await settle();
    expect(groups()).toEqual(['Recent commands', 'Navigation', 'General']);
  });

  it('lists what I opened last when the query is empty', async () => {
    const { groups, options } = await open({
      session: true,
      seed: (fs) => {
        const meta = { createdAt: new Date(), createdBy: 'u-jordan', updatedAt: new Date(), updatedBy: 'u-jordan' };
        fs.set('orgs/org-a/matters/m-1', {
          number: 'M-2026-0101',
          title: 'Estate of Ada Quill',
          type: 'probate',
          status: 'open',
          privileged: false,
          search: matterSearchTokens({ number: 'M-2026-0101', title: 'Estate of Ada Quill' }),
          deletedAt: null,
          schemaVersion: 1,
          ...meta,
        });
        fs.set('users/u-jordan/recent/org-a_m-1', {
          orgId: 'org-a',
          kind: 'matter',
          matterId: 'm-1',
          expireAt: new Date(Date.now() + 86_400_000),
          schemaVersion: 1,
          ...meta,
        });
      },
    });
    await settle(20);
    expect(groups()[0]).toBe('Recent');
    expect(options()[0]).toContain('Estate of Ada Quill');
    expect(options()[0]).toContain('M-2026-0101');
  });

  it('matches commands only for one character, and searches from two after the debounce', async () => {
    const { type, groups, options, search } = await open();
    await type('m');
    expect(search).not.toHaveBeenCalled();
    expect(groups()).toEqual(['Actions']);
    expect(MIN_SEARCH_LENGTH).toBe(2);
    await type('mat');
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toBe('mat');
    expect(groups()).toEqual(['Matters', 'Actions']);
    expect(options()).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Go to Matters'),
        expect.stringContaining('Estate of Example mat'),
      ]),
    );
    await type('');
    expect(groups()).toEqual(['Navigation', 'General']);
  });

  it('says a provider is still searching, and says to type more when it read its limit', async () => {
    const { registry, type, status, groups } = await open();
    let answer: (value: { results: CommandResult[]; more: boolean }) => void = () => undefined;
    registry.registerProvider({
      id: 'slow',
      group: 'Documents',
      search: () => new Promise((resolve) => (answer = resolve)),
    });
    await type('estate');
    expect(groups()).toContain('Documents');
    expect(status()).toContain('Searching documents…');
    answer({ results: [{ id: 'doc:1', title: 'Estate inventory.pdf', run: vi.fn() }], more: true });
    await settle(20);
    expect(status()).not.toContain('Searching documents…');
    expect(status()).toContain('Showing the best matches. Type more to narrow them.');
  });

  it('leaves out a provider that fails or is refused', async () => {
    const { registry, type, groups } = await open();
    registry.registerProvider({
      id: 'refused',
      group: 'Documents',
      search: async () => {
        throw new Error('permission-denied');
      },
    });
    await type('estate');
    expect(groups()).toEqual(['Matters']);
  });

  it('opens a provider result and closes', async () => {
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

  it('opens a result in a new tab with ⌘↵', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const { type, key, openMatter } = await open();
    await type('estate');
    await key('Enter', { metaKey: true });
    expect(opened).toHaveBeenCalledWith('/matters/m-142/overview', '_blank', 'noopener');
    expect(openMatter).not.toHaveBeenCalled();
    opened.mockRestore();
  });

  it('drills into a matter’s actions with Tab, and leaves with Backspace', async () => {
    const { type, key, groups, options, addTask } = await open();
    await type('estate');
    await key('Tab');
    expect(document.querySelector('.mt-cmdk-input .scope')?.textContent?.trim()).toBe('M-2026-0142');
    expect(groups()).toEqual(['M-2026-0142']);
    expect(options()).toEqual([expect.stringContaining('Add task')]);
    await key('Backspace');
    expect(document.querySelector('.mt-cmdk-input .scope')).toBeNull();
    await type('estate');
    await key('Tab');
    await key('Enter');
    expect(addTask).toHaveBeenCalledTimes(1);
  });

  it('drills into a command’s sub-commands with ↵', async () => {
    const { registry, key, type, options } = await open();
    const goContacts = vi.fn();
    registry.register({
      id: 'go.to',
      title: 'Go to…',
      group: 'Aaa',
      children: () => [{ id: 'go.contacts', title: 'Go to Contacts', group: 'Go to', run: goContacts }],
      run: vi.fn(),
    });
    await type('go to…', 0);
    await key('Enter');
    expect(options()).toEqual([expect.stringContaining('Go to Contacts')]);
    await key('Enter');
    expect(goContacts).toHaveBeenCalledTimes(1);
  });

  it('runs a command, records it as recent and closes', async () => {
    const { goMatters, registry, key } = await open();
    await key('Enter');
    expect(goMatters).toHaveBeenCalledTimes(1);
    expect(registry.recentIds()).toEqual(['go.matters']);
  });
});
