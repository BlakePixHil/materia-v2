import { render, screen } from '@testing-library/angular';

import { ariaKeyShortcuts, detectKeyboardPlatform, MT_KEYBOARD_PLATFORM, MtKbd, parseShortcut } from './kbd';

describe('MtKbd', () => {
  const caps = () => [...document.querySelectorAll('kbd.mt-kbd')].map((k) => k.textContent);

  it('shows ⌘ on Mac and reads "Command K"', async () => {
    await render(`<mt-kbd keys="mod+k" />`, {
      imports: [MtKbd],
      providers: [{ provide: MT_KEYBOARD_PLATFORM, useValue: 'mac' }],
    });
    expect(caps()).toEqual(['⌘', 'K']);
    expect(screen.getByText('Command K')).toHaveClass('mt-sr');
  });

  it('shows Ctrl on Windows and Linux', async () => {
    await render(`<mt-kbd keys="mod+k" />`, {
      imports: [MtKbd],
      providers: [{ provide: MT_KEYBOARD_PLATFORM, useValue: 'other' }],
    });
    expect(caps()).toEqual(['Ctrl', 'K']);
    expect(screen.getByText('Control K')).toBeInTheDocument();
  });

  it('renders sequences and upper-cases single letters', async () => {
    await render(`<mt-kbd keys="g m" />`, { imports: [MtKbd] });
    expect(caps()).toEqual(['G', 'M']);
    expect(screen.getByText('G, then M')).toBeInTheDocument();
  });

  it('detects the platform from the browser', () => {
    expect(detectKeyboardPlatform({ userAgentData: { platform: 'macOS' } })).toBe('mac');
    expect(detectKeyboardPlatform({ platform: 'iPhone' })).toBe('mac');
    expect(detectKeyboardPlatform({ platform: 'Win32' })).toBe('other');
    expect(detectKeyboardPlatform({ userAgent: 'X11; Linux x86_64' })).toBe('other');
    expect(detectKeyboardPlatform(undefined)).toBe('other');
  });

  it('builds aria-keyshortcuts values and named keys', () => {
    expect(ariaKeyShortcuts('mod+shift+p', 'mac')).toBe('Meta+Shift+P');
    expect(ariaKeyShortcuts('g m', 'other')).toBe('G M');
    expect(parseShortcut('esc', 'mac')[0]?.[0]?.glyph).toBe('Esc');
    expect(parseShortcut('alt+up', 'mac')[0]?.map((k) => k.glyph)).toEqual(['⌥', '↑']);
  });
});
