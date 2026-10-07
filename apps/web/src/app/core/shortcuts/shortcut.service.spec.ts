import { TestBed } from '@angular/core/testing';

import { MT_KEYBOARD_PLATFORM, type MtKeyboardPlatform } from '@materia/ui';

import { eventChord, isEditable, normaliseCombo, SEQUENCE_TIMEOUT_MS, ShortcutService } from './shortcut.service';

function setup(platform: MtKeyboardPlatform = 'other') {
  TestBed.configureTestingModule({ providers: [{ provide: MT_KEYBOARD_PLATFORM, useValue: platform }] });
  const service = TestBed.inject(ShortcutService);
  let now = 1_000;
  service.now = () => now;
  return { service, advance: (ms: number) => (now += ms) };
}

function key(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('normaliseCombo', () => {
  it('lower-cases and orders modifiers', () => {
    expect(normaliseCombo('Shift+Mod+K')).toBe('mod+shift+k');
    expect(normaliseCombo(' G  M ')).toBe('g m');
    expect(normaliseCombo('alt+ctrl+mod+shift+x')).toBe('mod+ctrl+alt+shift+x');
  });
});

describe('eventChord', () => {
  it('maps ⌘ to mod on a Mac and Ctrl to mod elsewhere', () => {
    expect(eventChord(new KeyboardEvent('keydown', { key: 'k', metaKey: true }), 'mac')).toBe('mod+k');
    expect(eventChord(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }), 'mac')).toBe('ctrl+k');
    expect(eventChord(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }), 'other')).toBe('mod+k');
    expect(eventChord(new KeyboardEvent('keydown', { key: 'k', metaKey: true }), 'other')).toBe('k');
  });

  it('keeps shifted punctuation as its character and records shift on letters and named keys', () => {
    expect(eventChord(new KeyboardEvent('keydown', { key: '?', shiftKey: true }), 'other')).toBe('?');
    expect(eventChord(new KeyboardEvent('keydown', { key: 'K', shiftKey: true }), 'other')).toBe('shift+k');
    expect(eventChord(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, altKey: true }), 'other')).toBe(
      'alt+shift+up',
    );
    expect(eventChord(new KeyboardEvent('keydown', { key: 'Escape' }), 'other')).toBe('esc');
    expect(eventChord(new KeyboardEvent('keydown', { key: ' ' }), 'other')).toBe('space');
  });
});

describe('isEditable', () => {
  it('is true for text inputs, textareas, selects and contenteditable', () => {
    const text = document.createElement('input');
    const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox' });
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isEditable(text)).toBe(true);
    expect(isEditable(document.createElement('textarea'))).toBe(true);
    expect(isEditable(document.createElement('select'))).toBe(true);
    expect(isEditable(editable)).toBe(true);
    expect(isEditable(checkbox)).toBe(false);
    expect(isEditable(document.createElement('button'))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

describe('ShortcutService', () => {
  it('leaves an Escape that closes a dialog or menu to it, so the page doesn’t act on it too (SEC-06)', () => {
    const { service } = setup();
    const handler = vi.fn();
    service.register({ combo: 'esc', description: 'Close the new matter', handler });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    // The dialog closes on the document's capture phase, before the page's listeners run.
    const close = () => dialog.remove();
    document.addEventListener('keydown', close, { capture: true, once: true });
    key('Escape');
    expect(handler).not.toHaveBeenCalled();
    // With nothing open, Escape is the page's.
    key('Escape');
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('runs a registered combo from a document keydown and prevents the default', () => {
    const { service } = setup();
    const handler = vi.fn();
    service.register({ combo: 'mod+k', description: 'Open', handler });
    const event = key('k', { ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('is platform-aware: ⌘K on a Mac, not Ctrl+K', () => {
    const { service } = setup('mac');
    const handler = vi.fn();
    service.register({ combo: 'mod+k', description: 'Open', handler });
    key('k', { ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
    key('k', { metaKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('unregisters', () => {
    const { service } = setup();
    const handler = vi.fn();
    const off = service.register({ combo: '[', description: 'Toggle', handler });
    off();
    key('[');
    expect(handler).not.toHaveBeenCalled();
    expect(service.list()).toEqual([]);
  });

  it('supports sequences within the timeout', () => {
    const { service, advance } = setup();
    const handler = vi.fn();
    service.register({ combo: 'g m', description: 'Go to Matters', handler });
    key('g');
    advance(SEQUENCE_TIMEOUT_MS - 1);
    key('m');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('drops a sequence after the timeout', () => {
    const { service, advance } = setup();
    const handler = vi.fn();
    service.register({ combo: 'g m', description: 'Go to Matters', handler });
    key('g');
    advance(SEQUENCE_TIMEOUT_MS + 1);
    key('m');
    expect(handler).not.toHaveBeenCalled();
  });

  it('prefers a sequence over a single key that completes it', () => {
    const { service } = setup();
    const single = vi.fn();
    const sequence = vi.fn();
    service.register({ combo: 'm', description: 'Single', handler: single });
    service.register({ combo: 'g m', description: 'Sequence', handler: sequence });
    key('g');
    key('m');
    expect(sequence).toHaveBeenCalledTimes(1);
    expect(single).not.toHaveBeenCalled();
    key('m');
    expect(single).toHaveBeenCalledTimes(1);
  });

  it('ignores plain keys from editable fields but allows combos with a modifier', () => {
    const { service } = setup();
    const plain = vi.fn();
    const modified = vi.fn();
    service.register({ combo: '[', description: 'Toggle', handler: plain });
    service.register({ combo: 'mod+k', description: 'Open', handler: modified });
    const input = document.createElement('input');
    document.body.append(input);
    key('[', {}, input);
    key('k', { ctrlKey: true }, input);
    input.remove();
    expect(plain).not.toHaveBeenCalled();
    expect(modified).toHaveBeenCalledTimes(1);
  });

  it('typing in a field cancels a pending sequence', () => {
    const { service } = setup();
    const handler = vi.fn();
    service.register({ combo: 'g m', description: 'Go', handler });
    const input = document.createElement('input');
    document.body.append(input);
    key('g');
    key('x', {}, input);
    key('m');
    input.remove();
    expect(handler).not.toHaveBeenCalled();
  });

  it('never fires during IME composition', () => {
    const { service } = setup();
    const handler = vi.fn();
    service.register({ combo: 'g', description: 'G', handler });
    key('g', { isComposing: true });
    key('Process');
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores lone modifier presses and events another handler already took', () => {
    const { service } = setup();
    const handler = vi.fn();
    service.register({ combo: 'g m', description: 'G', handler });
    key('g');
    key('Shift', { shiftKey: true });
    const taken = new KeyboardEvent('keydown', { key: 'm', cancelable: true });
    taken.preventDefault();
    expect(service.handle(taken)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses browser-reserved combos', () => {
    const { service } = setup();
    expect(() => service.register({ combo: 'Mod+W', description: 'Close', handler: () => undefined })).toThrow(
      /reserved/,
    );
    expect(() => service.register({ combo: 'mod+t', description: 'Tab', handler: () => undefined })).toThrow(
      /reserved/,
    );
  });

  it('respects when() and lets the newest registration win', () => {
    const { service } = setup();
    const older = vi.fn();
    const newer = vi.fn();
    let enabled = false;
    service.register({ combo: 'c', description: 'Older', handler: older });
    service.register({ combo: 'c', description: 'Newer', handler: newer, when: () => enabled });
    key('c');
    expect(older).toHaveBeenCalledTimes(1);
    enabled = true;
    key('c');
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).toHaveBeenCalledTimes(1);
  });

  it('lists visible shortcuts for the cheat sheet, deduplicated by combo', () => {
    const { service } = setup();
    service.register({ combo: 'mod+k', description: 'Open', group: 'General', handler: () => undefined });
    service.register({
      combo: 'g m',
      description: 'Go to Matters',
      group: 'Navigation',
      scope: 'route',
      handler: () => undefined,
    });
    service.register({
      combo: 'g m',
      description: 'Go to Matters (route)',
      group: 'Navigation',
      handler: () => undefined,
    });
    service.register({ combo: 'x', description: 'Secret', hidden: true, handler: () => undefined });
    expect(service.list()).toEqual([
      { combo: 'mod+k', description: 'Open', scope: 'global', group: 'General', hidden: false },
      { combo: 'g m', description: 'Go to Matters (route)', scope: 'global', group: 'Navigation', hidden: false },
    ]);
    expect(service.comboFor('Open')).toBe('mod+k');
    expect(service.comboFor('Nothing')).toBeUndefined();
  });
});
