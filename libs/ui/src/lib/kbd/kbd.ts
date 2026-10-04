import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  InjectionToken,
  input,
  ViewEncapsulation,
} from '@angular/core';

export type MtKeyboardPlatform = 'mac' | 'other';

/** Whether to show Mac (⌘) or Windows and Linux (Ctrl) shortcuts. Detected from the browser. */
export const MT_KEYBOARD_PLATFORM = new InjectionToken<MtKeyboardPlatform>('MT_KEYBOARD_PLATFORM', {
  factory: () => detectKeyboardPlatform(typeof navigator === 'undefined' ? undefined : navigator),
});

interface NavigatorLike {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

export function detectKeyboardPlatform(nav: NavigatorLike | undefined): MtKeyboardPlatform {
  const platform = nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'mac' : 'other';
}

interface KeyLabel {
  /** What the key cap shows. */
  glyph: string;
  /** What a screen reader says. */
  spoken: string;
  /** The `aria-keyshortcuts` key name. */
  aria: string;
}

const MODIFIERS: Record<string, { mac: KeyLabel; other: KeyLabel }> = {
  mod: {
    mac: { glyph: '⌘', spoken: 'Command', aria: 'Meta' },
    other: { glyph: 'Ctrl', spoken: 'Control', aria: 'Control' },
  },
  ctrl: {
    mac: { glyph: '⌃', spoken: 'Control', aria: 'Control' },
    other: { glyph: 'Ctrl', spoken: 'Control', aria: 'Control' },
  },
  alt: { mac: { glyph: '⌥', spoken: 'Option', aria: 'Alt' }, other: { glyph: 'Alt', spoken: 'Alt', aria: 'Alt' } },
  shift: {
    mac: { glyph: '⇧', spoken: 'Shift', aria: 'Shift' },
    other: { glyph: 'Shift', spoken: 'Shift', aria: 'Shift' },
  },
};

const NAMED_KEYS: Record<string, KeyLabel> = {
  esc: { glyph: 'Esc', spoken: 'Escape', aria: 'Escape' },
  escape: { glyph: 'Esc', spoken: 'Escape', aria: 'Escape' },
  enter: { glyph: 'Enter', spoken: 'Enter', aria: 'Enter' },
  tab: { glyph: 'Tab', spoken: 'Tab', aria: 'Tab' },
  space: { glyph: 'Space', spoken: 'Space', aria: 'Space' },
  up: { glyph: '↑', spoken: 'Up arrow', aria: 'ArrowUp' },
  down: { glyph: '↓', spoken: 'Down arrow', aria: 'ArrowDown' },
  left: { glyph: '←', spoken: 'Left arrow', aria: 'ArrowLeft' },
  right: { glyph: '→', spoken: 'Right arrow', aria: 'ArrowRight' },
  '/': { glyph: '/', spoken: 'Slash', aria: '/' },
};

/**
 * Parses a shortcut: `+` joins keys pressed together (`mod+k`), a space separates keys pressed in
 * sequence (`g m`). `mod` is ⌘ on Mac and Ctrl elsewhere. Returns one label array per step.
 */
export function parseShortcut(keys: string, platform: MtKeyboardPlatform): KeyLabel[][] {
  return keys
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((step) =>
      step.split('+').map((raw) => {
        const key = raw.toLowerCase();
        const modifier = MODIFIERS[key];
        if (modifier) return modifier[platform];
        const named = NAMED_KEYS[key];
        if (named) return named;
        const glyph = raw.length === 1 ? raw.toUpperCase() : raw;
        return { glyph, spoken: glyph, aria: glyph };
      }),
    );
}

/** The `aria-keyshortcuts` value for a shortcut (`Meta+K`, or `G M` for a sequence). */
export function ariaKeyShortcuts(keys: string, platform: MtKeyboardPlatform): string {
  return parseShortcut(keys, platform)
    .map((step) => step.map((k) => k.aria).join('+'))
    .join(' ');
}

/**
 * Keyboard hint (`mt-kbd`): renders one key cap per key, platform-aware (⌘K on Mac, Ctrl K on
 * Windows and Linux). Screen readers hear the spoken form ("Command K") instead of the glyphs.
 */
@Component({
  selector: 'mt-kbd',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: '../../generated/components/kbd.css',
  host: { style: 'display: contents' },
  template: `
    @for (key of caps(); track $index) {
      <kbd class="mt-kbd" aria-hidden="true">{{ key }}</kbd>
    }
    <span class="mt-sr">{{ spoken() }}</span>
  `,
})
export class MtKbd {
  /** The shortcut, for example `mod+k`, `c` or `g m`. */
  readonly keys = input.required<string>();

  private readonly platform = inject(MT_KEYBOARD_PLATFORM);
  private readonly parsed = computed(() => parseShortcut(this.keys(), this.platform));
  protected readonly caps = computed(() => this.parsed().flatMap((step) => step.map((k) => k.glyph)));
  protected readonly spoken = computed(() =>
    this.parsed()
      .map((step) => step.map((k) => k.spoken).join(' '))
      .join(', then '),
  );
}
