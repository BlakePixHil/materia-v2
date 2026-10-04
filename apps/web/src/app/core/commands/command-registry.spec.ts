import { TestBed } from '@angular/core/testing';

import { type Command, commandScore, CommandRegistry, fuzzyScore } from './command-registry';

const command = (id: string, title: string, extra: Partial<Command> = {}): Command => ({
  id,
  title,
  group: 'General',
  run: vi.fn(),
  ...extra,
});

function setup(): CommandRegistry {
  localStorage.removeItem('materia.commands.recent');
  return TestBed.inject(CommandRegistry);
}

describe('fuzzyScore', () => {
  it('matches subsequences case-insensitively and rejects non-matches', () => {
    expect(fuzzyScore('gtm', 'Go to Matters')).not.toBeNull();
    expect(fuzzyScore('GTM', 'go to matters')).not.toBeNull();
    expect(fuzzyScore('xyz', 'Go to Matters')).toBeNull();
    expect(fuzzyScore('  ', 'Anything')).toBe(0);
  });

  it('ranks a prefix above word starts above scattered letters', () => {
    const prefix = fuzzyScore('mat', 'Matters') ?? 0;
    const wordStart = fuzzyScore('mat', 'Go to Matters') ?? 0;
    const scattered = fuzzyScore('mat', 'Time and billing tasks') ?? 0;
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(scattered);
  });

  it('prefers contiguous runs and shorter texts', () => {
    expect(fuzzyScore('dead', 'Deadlines') ?? 0).toBeGreaterThan(
      fuzzyScore('dead', 'Draft estate administration document') ?? 0,
    );
    expect(fuzzyScore('in', 'Inbox') ?? 0).toBeGreaterThan(fuzzyScore('in', 'Inbox and notifications archive') ?? 0);
  });
});

describe('commandScore', () => {
  it('takes the best of the title and keywords', () => {
    expect(commandScore('dark', { title: 'Toggle theme', keywords: ['dark', 'light'] })).toBe(
      fuzzyScore('dark', 'dark'),
    );
    expect(commandScore('zzz', { title: 'Toggle theme' })).toBeNull();
  });
});

describe('CommandRegistry', () => {
  it('searches by fuzzy rank, keeping registration order on ties', () => {
    const registry = setup();
    registry.register(command('go.billing', 'Go to Time & billing'));
    registry.register(command('go.matters', 'Go to Matters'));
    registry.register(command('matters.new', 'New matter'));
    registry.register(command('theme', 'Toggle theme', { keywords: ['dark'] }));
    expect(registry.search('matter').map((c) => c.id)).toEqual(['matters.new', 'go.matters']);
    expect(registry.search('dark').map((c) => c.id)).toEqual(['theme']);
    expect(registry.search('').map((c) => c.id)).toEqual(['go.billing', 'go.matters', 'matters.new', 'theme']);
  });

  it('hides commands whose when() is false', () => {
    const registry = setup();
    let allowed = false;
    registry.register(command('a', 'Archive matter', { when: () => allowed }));
    expect(registry.available()).toEqual([]);
    allowed = true;
    expect(registry.available().map((c) => c.id)).toEqual(['a']);
  });

  it('replaces a command registered again under the same id, and unregisters', () => {
    const registry = setup();
    registry.register(command('a', 'First'));
    const off = registry.register(command('a', 'Second'));
    expect(registry.available().map((c) => c.title)).toEqual(['Second']);
    expect(registry.get('a')?.title).toBe('Second');
    off();
    expect(registry.get('a')).toBeUndefined();
  });

  it('runs commands and remembers the last five as recent, most recent first, in local storage', () => {
    const registry = setup();
    const commands = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => command(id, id.toUpperCase()));
    commands.forEach((c) => registry.register(c));
    for (const c of commands) registry.run(c);
    registry.run(commands[2] as Command);
    expect(commands[0]?.run).toHaveBeenCalledTimes(1);
    expect(registry.recent().map((c) => c.id)).toEqual(['c', 'f', 'e', 'd', 'b']);
    expect(JSON.parse(localStorage.getItem('materia.commands.recent') ?? '[]')).toEqual(['c', 'f', 'e', 'd', 'b']);
  });

  it('reads recents back from storage, skipping commands no longer available', () => {
    localStorage.setItem('materia.commands.recent', JSON.stringify(['gone', 'b', 7]));
    TestBed.resetTestingModule();
    const registry = TestBed.inject(CommandRegistry);
    registry.register(command('b', 'B'));
    expect(registry.recent().map((c) => c.id)).toEqual(['b']);
  });

  it('survives corrupt storage', () => {
    localStorage.setItem('materia.commands.recent', '{not json');
    TestBed.resetTestingModule();
    expect(TestBed.inject(CommandRegistry).recentIds()).toEqual([]);
  });

  it('collects provider results, skipping providers that fail', async () => {
    const registry = setup();
    const off = registry.registerProvider({
      id: 'matters',
      group: 'Matters',
      search: async (query) => [{ id: 'm1', title: `Matter ${query}`, run: vi.fn() }],
    });
    registry.registerProvider({ id: 'broken', group: 'Broken', search: () => Promise.reject(new Error('offline')) });
    const results = await registry.searchProviders('42', new AbortController().signal);
    expect(results.map((r) => [r.provider.id, r.results.map((x) => x.title)])).toEqual([['matters', ['Matter 42']]]);
    off();
    expect(await registry.searchProviders('42', new AbortController().signal)).toEqual([]);
  });
});
