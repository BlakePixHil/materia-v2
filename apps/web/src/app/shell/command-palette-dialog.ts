import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { Connectivity } from '@materia/data-access';
import { injectDialogRef } from '@materia/ui';
import {
  MtCommandPalette,
  MtCommandPaletteOverlay,
  type MtCommandGroup,
  type MtCommandItem,
  type MtCommandRun,
} from '@materia/ui/command-palette';

import {
  CommandRegistry,
  resultPage,
  searchCommands,
  type Command,
  type CommandProvider,
  type CommandResult,
} from '../core/commands/command-registry';
import { SearchResults } from '../core/search/search-providers';

/** Debounce for provider searches (CORE-15). */
export const PROVIDER_DEBOUNCE_MS = 120;
/** Providers search from this many characters; shorter queries match commands only. */
export const MIN_SEARCH_LENGTH = 2;

/** A provider's answer while the palette is open. */
interface ProviderGroup {
  id: string;
  group: string;
  busy: boolean;
  results: readonly CommandResult[];
  more: boolean;
}

/** Where the palette has drilled in: a matter's actions, "Go to…", the open matter's stages. */
interface Scope {
  label: string;
  commands: () => readonly Command[];
}

/** One row's source. */
type Entry = { kind: 'command'; command: Command } | { kind: 'result'; result: CommandResult };

/** A group of rows before it's shown. */
interface RowGroup {
  label: string;
  entries: readonly Entry[];
  busy?: boolean;
  more?: boolean;
}

/**
 * The ⌘K palette (FND-12, CORE-15): FND-09's CommandPalette fed by the CommandRegistry and the
 * search providers. Empty query: what I opened last (matters, people, tasks, documents), recent
 * commands, then every command by group. Typing: each provider's results as they arrive (from two
 * characters; one character matches commands only), then the matched commands as "Actions". Tab on
 * a matter, or ↵ on a command with sub-commands, drills in; Backspace in the empty input leaves.
 * ⌘↵ opens a result in a new tab. The shell loads it lazily on the first ⌘K.
 */
@Component({
  selector: 'mt-command-palette-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtCommandPalette, MtCommandPaletteOverlay],
  template: `
    <mt-command-palette-overlay>
      <mt-command-palette
        [groups]="groups()"
        [scope]="scope()?.label ?? null"
        [placeholder]="scope() ? 'Search actions…' : 'Search matters, people and actions…'"
        [(query)]="query"
        (open)="open($event)"
        (drill)="drill($event)"
        (back)="back()"
      />
    </mt-command-palette-overlay>
  `,
})
export class CommandPaletteDialog {
  private readonly registry = inject(CommandRegistry);
  private readonly ref = injectDialogRef();
  private readonly palette = viewChild.required(MtCommandPalette);
  private readonly online = inject(Connectivity).online;
  private readonly search = new SearchResults();

  protected readonly query = signal('');
  private readonly scopes = signal<readonly Scope[]>([]);
  protected readonly scope = computed(() => this.scopes().at(-1) ?? null);
  private readonly providerGroups = signal<readonly ProviderGroup[]>([]);
  private readonly recentResults = signal<readonly CommandResult[]>([]);

  /** The commands shown, by group: drilled in, the empty query (recent, then all) or matched. */
  private readonly commandGroups = computed<RowGroup[]>(() => {
    const query = this.query().trim();
    const scope = this.scope();
    const groups = new Map<string, Entry[]>();
    const add = (group: string, command: Command) =>
      groups.set(group, [...(groups.get(group) ?? []), { kind: 'command', command }]);
    if (scope) {
      const available = scope.commands().filter((command) => !command.when || command.when());
      for (const command of query ? searchCommands(query, available) : available)
        add(query ? 'Actions' : command.group, command);
    } else if (!query) {
      for (const command of this.registry.recent()) add('Recent commands', command);
      for (const command of this.registry.available()) add(command.group, command);
    } else {
      // Matched commands keep their rank order across groups: one "Actions" group, as designed.
      for (const command of this.registry.search(query)) add('Actions', command);
    }
    return [...groups].map(([label, entries]) => ({ label, entries }));
  });

  /** Provider results, one group per label (several providers may answer "Matters"); Recent when empty. */
  private readonly resultGroups = computed<RowGroup[]>(() => {
    if (this.scope()) return [];
    const result = (r: CommandResult): Entry => ({ kind: 'result', result: r });
    if (!this.query().trim()) {
      const recent = this.recentResults();
      return recent.length ? [{ label: 'Recent', entries: recent.map(result) }] : [];
    }
    const groups = new Map<string, RowGroup>();
    for (const provider of this.providerGroups()) {
      const group = groups.get(provider.group) ?? { label: provider.group, entries: [] };
      groups.set(provider.group, {
        label: provider.group,
        entries: [...group.entries, ...provider.results.map(result)],
        busy: !!group.busy || provider.busy,
        more: !!group.more || provider.more,
      });
    }
    return [...groups.values()].filter((group) => group.entries.length || group.busy);
  });

  /** Every row by its palette id, for running what was chosen. */
  private readonly entries = computed(
    () =>
      new Map(
        [...this.resultGroups(), ...this.commandGroups()].flatMap((group) =>
          group.entries.map((entry) => [entryId(entry), entry] as const),
        ),
      ),
  );

  /** Results first (Recent when the query is empty), then commands, as designed. */
  protected readonly groups = computed<MtCommandGroup[]>(() => {
    const offline = !this.online();
    return [...this.resultGroups(), ...this.commandGroups()].map((group) => ({
      label: group.label,
      items: group.entries.map(entryItem),
      ...(group.busy ? { busy: true } : {}),
      ...(group.more
        ? { note: 'Showing the best matches. Type more to narrow them.' }
        : offline && group.entries.some((entry) => entry.kind === 'result')
          ? { note: 'Offline: showing what’s saved on this device.' }
          : {}),
    }));
  });

  constructor() {
    afterNextRender(() => this.palette().focus());

    // The built-in search providers, while the palette is open.
    const releases = this.search.providers.map((provider) => this.registry.registerProvider(provider));
    inject(DestroyRef).onDestroy(() => releases.forEach((release) => release()));

    // What I opened last (read once per opening; from this device's cache when offline).
    this.search
      .recent()
      .then((results) => this.recentResults.set(results))
      .catch(() => undefined);

    // Each provider answers on its own: its group says "Searching…" until it does.
    effect((onCleanup) => {
      const query = this.query().trim();
      const scoped = !!this.scope();
      if (scoped || query.length < MIN_SEARCH_LENGTH) {
        untracked(() => this.providerGroups.set([]));
        return;
      }
      const providers = untracked(() => this.registry.allProviders());
      untracked(() => this.providerGroups.update((groups) => providers.map((p) => searching(p, groups))));
      const controller = new AbortController();
      const timer = setTimeout(() => {
        for (const provider of providers) void this.ask(provider, query, controller.signal);
      }, PROVIDER_DEBOUNCE_MS);
      onCleanup(() => {
        clearTimeout(timer);
        controller.abort();
      });
    });
  }

  private async ask(provider: CommandProvider, query: string, signal: AbortSignal): Promise<void> {
    let page: { results: readonly CommandResult[]; more?: boolean | undefined };
    try {
      page = resultPage(await provider.search(query, signal));
    } catch {
      // Refused (a read the rules keep from this role) or failed: this group has nothing to show.
      page = { results: [] };
    }
    if (signal.aborted) return;
    this.providerGroups.update((groups) =>
      groups.map((group) =>
        group.id === provider.id ? { ...group, busy: false, results: page.results, more: !!page.more } : group,
      ),
    );
  }

  protected open({ item, newTab }: MtCommandRun): void {
    const entry = this.entries().get(item.id);
    if (!entry) return;
    if (entry.kind === 'result') {
      if (newTab && entry.result.href) return this.openInNewTab(entry.result.href);
      this.ref.close();
      void entry.result.run();
      return;
    }
    const { command } = entry;
    if (newTab && command.href) return this.openInNewTab(command.href);
    if (command.children) return this.drill(item);
    this.ref.close();
    this.registry.run(command);
  }

  protected drill(item: MtCommandItem): void {
    const entry = this.entries().get(item.id);
    const children = entry?.kind === 'result' ? entry.result.children : entry?.command.children;
    if (!entry || !children) return;
    const label = entry.kind === 'result' ? entry.result.meta || entry.result.title : entry.command.title;
    this.scopes.update((scopes) => [...scopes, { label: label.replace(/…$/, ''), commands: children }]);
    this.query.set('');
  }

  protected back(): void {
    this.scopes.update((scopes) => scopes.slice(0, -1));
  }

  private openInNewTab(href: string): void {
    this.ref.close();
    globalThis.open?.(href, '_blank', 'noopener');
  }
}

/** A provider's group while it searches: its last results stay until the new ones land. */
function searching(provider: CommandProvider, groups: readonly ProviderGroup[]): ProviderGroup {
  const previous = groups.find((group) => group.id === provider.id);
  return { id: provider.id, group: provider.group, busy: true, results: previous?.results ?? [], more: false };
}

function entryId(entry: Entry): string {
  return entry.kind === 'command' ? `command:${entry.command.id}` : `result:${entry.result.id}`;
}

function entryItem(entry: Entry): MtCommandItem {
  if (entry.kind === 'command') {
    const { command } = entry;
    return {
      id: entryId(entry),
      label: command.title,
      ...(command.icon ? { icon: command.icon } : {}),
      ...(command.shortcut ? { kbd: command.shortcut } : {}),
      ...(command.children ? { drill: true } : {}),
    };
  }
  const { result } = entry;
  return {
    id: entryId(entry),
    label: result.title,
    ...(result.meta ? { meta: result.meta } : {}),
    ...(result.mono ? { mono: true } : {}),
    ...(result.icon ? { icon: result.icon } : {}),
    ...(result.children ? { drill: true } : {}),
  };
}
