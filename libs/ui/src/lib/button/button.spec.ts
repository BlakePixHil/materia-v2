import { Component, signal } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtButton } from './button';
import { MT_KEYBOARD_PLATFORM } from '../kbd/kbd';

describe('MtButton', () => {
  it('maps variant and size to data attributes, with clerk as the design system\'s "ai"', async () => {
    await render(`<button mtButton variant="clerk" size="sm" iconStart="sparkle">Ask Clerk</button>`, {
      imports: [MtButton],
    });
    const button = screen.getByRole('button', { name: 'Ask Clerk' });
    expect(button).toHaveClass('mt-btn');
    expect(button).toHaveAttribute('data-variant', 'ai');
    expect(button).toHaveAttribute('data-size', 'sm');
    expect(button.querySelector('svg.mt-i')).not.toBeNull();
  });

  it('defaults to secondary, md and type="button", so it never submits a form by accident', async () => {
    const submit = vi.fn((event: Event) => event.preventDefault());
    await render(`<form (submit)="submit($event)"><button mtButton>Cancel</button></form>`, {
      imports: [MtButton],
      componentProperties: { submit },
    });
    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(button).toHaveAttribute('data-variant', 'secondary');
    expect(button).not.toHaveAttribute('data-size');
    expect(button).toHaveAttribute('type', 'button');
    await userEvent.click(button);
    expect(submit).not.toHaveBeenCalled();
  });

  it('submits when type="submit" is explicit', async () => {
    const submit = vi.fn((event: Event) => event.preventDefault());
    await render(
      `<form (submit)="submit($event)"><button mtButton type="submit" variant="primary">Save</button></form>`,
      {
        imports: [MtButton],
        componentProperties: { submit },
      },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('activates with Enter and Space from the keyboard', async () => {
    const clicked = vi.fn();
    await render(`<button mtButton (click)="clicked()">Record time</button>`, {
      imports: [MtButton],
      componentProperties: { clicked },
    });
    await userEvent.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(clicked).toHaveBeenCalledTimes(2);
  });

  it('renders data-disabled and the disabled attribute', async () => {
    await render(`<button mtButton disabled>Publish notice</button>`, { imports: [MtButton] });
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('data-disabled');
    expect(button).toBeDisabled();
  });

  it('loading swaps the start icon for a spinner, sets aria-busy and keeps the label', async () => {
    await render(`<button mtButton iconStart="send" loading>Send</button>`, { imports: [MtButton] });
    const button = screen.getByRole('button', { name: 'Send' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('data-loading');
    expect(button.querySelectorAll('svg.mt-i')).toHaveLength(1);
    expect(button.querySelector('span')).not.toHaveClass('mt-sr');
  });

  it('loading without a start icon keeps the width and hides the label visually only', async () => {
    @Component({
      imports: [MtButton],
      template: `<button mtButton [loading]="loading()">Save</button>`,
    })
    class Host {
      readonly loading = signal(false);
    }
    const { fixture } = await render(Host);
    const button = screen.getByRole('button', { name: 'Save' });
    Object.defineProperty(button, 'offsetWidth', { configurable: true, value: 64 });

    fixture.componentInstance.loading.set(true);
    await fixture.whenStable();
    expect(button.style.width).toBe('64px');
    expect(button.querySelector('span')).toHaveClass('mt-sr');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-busy', 'true');

    fixture.componentInstance.loading.set(false);
    await fixture.whenStable();
    expect(button.style.width).toBe('');
  });

  it('measures nothing until it loads, so a long list of buttons forces no layouts (SEC-07)', async () => {
    const measured = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get');
    try {
      await render(
        `@for (n of rows; track n) {
          <button mtButton size="sm" iconStart="check">Mark done</button>
        }`,
        { imports: [MtButton], componentProperties: { rows: Array.from({ length: 20 }, (_, n) => n) } },
      );
      expect(screen.getAllByRole('button', { name: 'Mark done' })).toHaveLength(20);
      expect(measured).not.toHaveBeenCalled();
    } finally {
      measured.mockRestore();
    }
  });

  it('shows a platform-aware shortcut and sets aria-keyshortcuts', async () => {
    await render(`<button mtButton kbd="mod+enter">Save</button>`, {
      imports: [MtButton],
      providers: [{ provide: MT_KEYBOARD_PLATFORM, useValue: 'other' }],
    });
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+Enter');
    expect([...button.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', 'Enter']);
  });

  it('works on links without a type attribute', async () => {
    await render(`<a mtButton href="/matters" variant="ghost">All matters</a>`, { imports: [MtButton] });
    const link = screen.getByRole('link', { name: 'All matters' });
    expect(link).toHaveClass('mt-btn');
    expect(link).not.toHaveAttribute('type');
  });
});
