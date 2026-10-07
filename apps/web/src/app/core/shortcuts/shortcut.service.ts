import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, Injectable, signal } from '@angular/core';

import { MT_KEYBOARD_PLATFORM, type MtKeyboardPlatform } from '@materia/ui';

export type ShortcutScope = 'global' | 'route' | 'component';

/** A keyboard shortcut. `combo` uses the Kbd syntax: `mod+k`, `shift+/`, `[`, or a sequence `g m`. */
export interface ShortcutDefinition {
  combo: string;
  description: string;
  handler: (event: KeyboardEvent) => void;
  scope?: ShortcutScope;
  /** Cheat-sheet group ("Navigation", "General"). */
  group?: string;
  /** Only active while this returns true. */
  when?: () => boolean;
  /** Hidden from the `?` cheat sheet. */
  hidden?: boolean;
}

export interface RegisteredShortcut extends Required<
  Pick<ShortcutDefinition, 'combo' | 'description' | 'scope' | 'group'>
> {
  hidden: boolean;
}

/** How long the second key of a sequence (`g` then `m`) may take. */
export const SEQUENCE_TIMEOUT_MS = 1200;

/** Combos the browser keeps for itself; registering one throws. */
export const RESERVED_COMBOS = [
  'mod+w',
  'mod+t',
  'mod+n',
  'mod+q',
  'mod+shift+t',
  'mod+shift+w',
  'mod+shift+n',
  'mod+l',
  'mod+r',
];

const MODIFIER_ORDER = ['mod', 'ctrl', 'alt', 'shift'] as const;

/** Lower-cases a combo and orders its modifiers: `Shift+Mod+K` → `mod+shift+k`. */
export function normaliseCombo(combo: string): string {
  return combo
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((chord) => {
      const parts = chord.split('+').filter(Boolean);
      const key = parts.filter((p) => !(MODIFIER_ORDER as readonly string[]).includes(p)).join('+');
      const mods = MODIFIER_ORDER.filter((m) => parts.includes(m));
      return [...mods, key].join('+');
    })
    .join(' ');
}

const KEY_ALIASES: Record<string, string> = {
  ' ': 'space',
  escape: 'esc',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
};

/**
 * The chord for a key event on this platform: `mod` is ⌘ on a Mac and Ctrl elsewhere. Shifted
 * punctuation keeps its character (`?`), so `?` and `shift+/` both work.
 */
export function eventChord(event: KeyboardEvent, platform: MtKeyboardPlatform): string {
  const raw = event.key.toLowerCase();
  const key = KEY_ALIASES[raw] ?? raw;
  const mod = platform === 'mac' ? event.metaKey : event.ctrlKey;
  const mods: string[] = [];
  if (mod) mods.push('mod');
  if (platform === 'mac' && event.ctrlKey) mods.push('ctrl');
  if (event.altKey) mods.push('alt');
  // Shift is part of a printable character (`?`, `{`); only letters and named keys record it.
  if (event.shiftKey && (key.length > 1 || /[a-z0-9]/.test(key))) mods.push('shift');
  return [...mods, key].join('+');
}

/** True for inputs, textareas, selects and contenteditable elements. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
}

interface Entry extends ShortcutDefinition {
  key: string;
  id: number;
}

/**
 * Global keyboard shortcuts (FND-12). Features register combos with a description and a handler;
 * `list()` feeds the `?` cheat sheet. Rules (Design system & UI conventions, keyboard):
 *
 * - Events from editable fields are ignored, except combos with a modifier (`mod+k` still works).
 * - IME composition never triggers a shortcut (`event.isComposing`).
 * - `mod` is ⌘ on a Mac and Ctrl elsewhere. Browser-reserved combos (⌘W, ⌘T…) can't be registered.
 * - Sequences: `g m` means `g` then `m` within 1.2 seconds.
 * - The most recently registered matching shortcut wins (a component overrides a global one).
 */
@Injectable({ providedIn: 'root' })
export class ShortcutService {
  private readonly platform = inject(MT_KEYBOARD_PLATFORM);
  private readonly document = inject(DOCUMENT);
  private readonly entries = signal<readonly Entry[]>([]);
  private pending: { chord: string; at: number } | null = null;
  private nextId = 0;
  /** Injected clock, for tests. */
  now: () => number = () => Date.now();

  /** Escape presses that began while a dialog or menu was open: they close that layer and nothing else. */
  private readonly overlayEscapes = new WeakSet<Event>();

  constructor() {
    const listener = (event: Event) => this.handle(event as KeyboardEvent);
    // Before anything else sees the key (overlays close on the document's capture phase, at once
    // under reduced motion), note whether this Escape is for an open dialog or menu. Without it, the
    // Escape that closed a dialog also reached the page and, on New matter, asked to close the
    // whole intake (SEC-06).
    const mark = (event: Event) => {
      if ((event as KeyboardEvent).key === 'Escape' && this.overlayOpen()) this.overlayEscapes.add(event);
    };
    const view = this.document.defaultView;
    view?.addEventListener('keydown', mark, true);
    this.document.addEventListener('keydown', listener);
    inject(DestroyRef).onDestroy(() => {
      view?.removeEventListener('keydown', mark, true);
      this.document.removeEventListener('keydown', listener);
    });
  }

  /** Whether this Escape began while a dialog or menu was open, so it was that layer's to handle. */
  closedOverlay(event: Event): boolean {
    return this.overlayEscapes.has(event);
  }

  private overlayOpen(): boolean {
    return !!this.document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"], [role="menu"]');
  }

  /** Registers a shortcut; returns a function that unregisters it. */
  register(definition: ShortcutDefinition): () => void {
    const key = normaliseCombo(definition.combo);
    if (RESERVED_COMBOS.includes(key)) throw new Error(`"${definition.combo}" is reserved by the browser`);
    const entry: Entry = { ...definition, key, id: this.nextId++ };
    this.entries.update((list) => [...list, entry]);
    return () => this.entries.update((list) => list.filter((e) => e.id !== entry.id));
  }

  /** Every visible registered shortcut, for the cheat sheet (deduplicated by combo, latest wins). */
  list(): RegisteredShortcut[] {
    const seen = new Map<string, RegisteredShortcut>();
    for (const e of this.entries()) {
      if (e.hidden) continue;
      seen.set(e.key, {
        combo: e.key,
        description: e.description,
        scope: e.scope ?? 'global',
        group: e.group ?? 'General',
        hidden: false,
      });
    }
    return [...seen.values()];
  }

  /** The combo registered for a description's command, for showing hints (`kbd`). */
  comboFor(description: string): string | undefined {
    return [...this.entries()].reverse().find((e) => e.description === description)?.key;
  }

  /** Handles a keydown (exposed for tests and for components that stop propagation). */
  handle(event: KeyboardEvent): boolean {
    if (event.isComposing || event.key === 'Process' || event.defaultPrevented) return false;
    if (this.overlayEscapes.has(event)) return false;
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return false;
    const chord = eventChord(event, this.platform);
    const hasModifier = /(^|\+)(mod|ctrl|alt)\+/.test(chord);
    if (isEditable(event.target) && !hasModifier) {
      this.pending = null;
      return false;
    }
    const now = this.now();
    const sequence =
      this.pending && now - this.pending.at <= SEQUENCE_TIMEOUT_MS ? `${this.pending.chord} ${chord}` : null;
    const active = this.entries().filter((e) => !e.when || e.when());
    const newestFirst = [...active].reverse();
    const match =
      (sequence ? newestFirst.find((e) => e.key === sequence) : undefined) ?? newestFirst.find((e) => e.key === chord);
    if (match) {
      this.pending = null;
      event.preventDefault();
      match.handler(event);
      return true;
    }
    // Remember the first key of a possible sequence.
    this.pending = active.some((e) => e.key.startsWith(`${chord} `)) ? { chord, at: now } : null;
    return false;
  }
}
