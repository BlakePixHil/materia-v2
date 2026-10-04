import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  afterNextRender,
} from '@angular/core';

import {
  injectDialogRef,
  MtCommandPalette,
  MtCommandPaletteOverlay,
  type MtCommandGroup,
  type MtCommandItem,
} from '@materia/ui';

import { type Command, CommandRegistry, type CommandResult } from '../core/commands/command-registry';

/** Debounce for provider searches. */
export const PROVIDER_DEBOUNCE_MS = 150;

/**
 * The ⌘K palette (FND-12): FND-09's CommandPalette fed by the CommandRegistry. Empty query: recent
 * commands, then everything by group. Typing: fuzzy-matched commands, then provider results.
 */
@Component({
  selector: 'mt-command-palette-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtCommandPalette, MtCommandPaletteOverlay],
  template: `
    <mt-command-palette-overlay>
      <mt-command-palette [groups]="groups()" [(query)]="query" (run)="run($event)" />
    </mt-command-palette-overlay>
  `,
})
export class CommandPaletteDialog {
  private readonly registry = inject(CommandRegistry);
  private readonly ref = injectDialogRef();
  private readonly palette = viewChild.required(MtCommandPalette);

  protected readonly query = signal('');
  private readonly providerResults = signal<{ group: string; results: readonly CommandResult[] }[]>([]);

  private readonly commandGroups = computed<MtCommandGroup[]>(() => {
    const query = this.query().trim();
    const groups = new Map<string, MtCommandItem[]>();
    const add = (group: string, command: Command) => {
      const items = groups.get(group) ?? [];
      items.push(toItem(command));
      groups.set(group, items);
    };
    if (!query) {
      for (const command of this.registry.recent()) add('Recent', command);
      for (const command of this.registry.available()) add(command.group, command);
    } else {
      // Matched commands keep their rank order across groups: one "Commands" group.
      for (const command of this.registry.search(query)) add('Commands', command);
    }
    return [...groups].map(([label, items]) => ({ label, items }));
  });

  protected readonly groups = computed<MtCommandGroup[]>(() => [
    ...this.commandGroups(),
    ...this.providerResults()
      .filter((p) => p.results.length)
      .map((p) => ({
        label: p.group,
        items: p.results.map((r) => ({
          id: `result:${r.id}`,
          label: r.title,
          ...(r.meta ? { meta: r.meta } : {}),
          ...(r.icon ? { icon: r.icon } : {}),
        })),
      })),
  ]);

  constructor() {
    afterNextRender(() => this.palette().focus());
    effect((onCleanup) => {
      const query = this.query().trim();
      if (!query) {
        this.providerResults.set([]);
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(async () => {
        const results = await this.registry.searchProviders(query, controller.signal);
        if (!controller.signal.aborted)
          this.providerResults.set(results.map((r) => ({ group: r.provider.group, results: r.results })));
      }, PROVIDER_DEBOUNCE_MS);
      onCleanup(() => {
        clearTimeout(timer);
        controller.abort();
      });
    });
  }

  protected run(item: MtCommandItem): void {
    this.ref.close();
    if (item.id.startsWith('result:')) {
      const id = item.id.slice('result:'.length);
      this.providerResults()
        .flatMap((p) => p.results)
        .find((r) => r.id === id)
        ?.run();
      return;
    }
    const command = this.registry.get(item.id);
    if (command) this.registry.run(command);
  }
}

function toItem(command: Command): MtCommandItem {
  return {
    id: command.id,
    label: command.title,
    ...(command.icon ? { icon: command.icon } : {}),
    ...(command.shortcut ? { kbd: command.shortcut } : {}),
  };
}
