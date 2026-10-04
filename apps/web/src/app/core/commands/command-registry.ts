import { Injectable, signal } from '@angular/core';

import type { MtIconName } from '@materia/ui';

/** A command features register ("Go to Matters", "Toggle theme", "New matter"). */
export interface Command {
  id: string;
  title: string;
  /** Palette group ("Navigation", "General"). */
  group: string;
  icon?: MtIconName | undefined;
  keywords?: readonly string[] | undefined;
  /** Shown as the hint; register the same combo with ShortcutService to make it work. */
  shortcut?: string | undefined;
  /** Only offered while this returns true. */
  when?: (() => boolean) | undefined;
  run: () => unknown;
}

/** A search result from a provider (matters, contacts, tasks; CORE-15). */
export interface CommandResult {
  id: string;
  title: string;
  meta?: string | undefined;
  icon?: MtIconName | undefined;
  run: () => unknown;
}

/** Async search results for the palette, such as matters by number or title (CORE-15). */
export interface CommandProvider {
  id: string;
  group: string;
  /** Called as the query changes (debounced); abort when `signal` aborts. */
  search: (query: string, signal: AbortSignal) => Promise<readonly CommandResult[]>;
}

/**
 * Scores how well `query` matches `text` as a subsequence (case-insensitive), or null if it doesn't.
 * Higher is better: matches at the start, at word starts and in runs score more; spread-out matches
 * and longer texts score less.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let previous = -2;
  for (const char of q) {
    const index = t.indexOf(char, ti);
    if (index === -1) return null;
    const wordStart = index === 0 || /[\s\-·/(]/.test(t[index - 1] ?? '');
    score += 1;
    if (index === 0) score += 6;
    else if (wordStart) score += 4;
    if (index === previous + 1) score += 3;
    else score -= Math.min(3, (index - previous - 1) * 0.1);
    previous = index;
    ti = index + 1;
  }
  return score - t.length * 0.01;
}

/** The best score across a command's title and keywords. */
export function commandScore(query: string, command: Pick<Command, 'title' | 'keywords'>): number | null {
  const scores = [command.title, ...(command.keywords ?? [])]
    .map((text) => fuzzyScore(query, text))
    .filter((s): s is number => s !== null);
  return scores.length ? Math.max(...scores) : null;
}

const RECENT_KEY = 'materia.commands.recent';
const RECENT_MAX = 5;

/**
 * The command registry (FND-12). Features register commands and async search providers; the ⌘K
 * palette shows recent commands, fuzzy-matched commands and provider results.
 */
@Injectable({ providedIn: 'root' })
export class CommandRegistry {
  private readonly commands = signal<readonly Command[]>([]);
  private readonly providers = signal<readonly CommandProvider[]>([]);
  readonly recentIds = signal<readonly string[]>(readRecent());

  register(command: Command): () => void {
    this.commands.update((list) => [...list.filter((c) => c.id !== command.id), command]);
    return () => this.commands.update((list) => list.filter((c) => c !== command));
  }

  registerProvider(provider: CommandProvider): () => void {
    this.providers.update((list) => [...list.filter((p) => p.id !== provider.id), provider]);
    return () => this.providers.update((list) => list.filter((p) => p !== provider));
  }

  /** Commands available now. */
  available(): Command[] {
    return this.commands().filter((c) => !c.when || c.when());
  }

  /** Commands matching the query, best first (ties keep registration order). */
  search(query: string): Command[] {
    return this.available()
      .map((command, index) => ({ command, index, score: commandScore(query, command) }))
      .filter((r): r is { command: Command; index: number; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((r) => r.command);
  }

  /** Recently run commands that are still available, most recent first. */
  recent(): Command[] {
    const available = new Map(this.available().map((c) => [c.id, c]));
    return this.recentIds()
      .map((id) => available.get(id))
      .filter((c): c is Command => c !== undefined);
  }

  /** Every provider's results for a query (a failing provider contributes nothing). */
  async searchProviders(
    query: string,
    signal: AbortSignal,
  ): Promise<{ provider: CommandProvider; results: readonly CommandResult[] }[]> {
    const settled = await Promise.allSettled(
      this.providers().map(async (provider) => ({ provider, results: await provider.search(query, signal) })),
    );
    return settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  }

  /** Runs a command and remembers it as recent. */
  run(command: Command): void {
    this.recentIds.update((ids) => [command.id, ...ids.filter((id) => id !== command.id)].slice(0, RECENT_MAX));
    writeRecent(this.recentIds());
    command.run();
  }

  /** Finds a registered command by id. */
  get(id: string): Command | undefined {
    return this.commands().find((c) => c.id === id);
  }
}

function readRecent(): string[] {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(ids: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(ids));
  } catch {
    // Storage can be unavailable (private windows); recents just aren't kept.
  }
}
