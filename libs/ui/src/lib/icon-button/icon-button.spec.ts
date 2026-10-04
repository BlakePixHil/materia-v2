import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtIconButton } from './icon-button';

describe('MtIconButton', () => {
  it('is named by its label, which is also the tooltip by default', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await render(`<button mtIconButton icon="more" label="More actions"></button>`, { imports: [MtIconButton] });
    const button = screen.getByRole('button', { name: 'More actions' });
    expect(button).toHaveClass('mt-ibtn');
    expect(button).toHaveAttribute('data-variant', 'ghost');
    button.focus();
    await vi.advanceTimersByTimeAsync(450);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('More actions');
    vi.useRealTimers();
    expect(button).toHaveAttribute('type', 'button');
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('maps variant and size, can drop the tooltip, and activates from the keyboard', async () => {
    const clicked = vi.fn();
    await render(
      `<button mtIconButton icon="sparkle" label="Ask Clerk" variant="clerk" size="sm" [tooltip]="false" (click)="clicked()"></button>`,
      { imports: [MtIconButton], componentProperties: { clicked } },
    );
    const button = screen.getByRole('button', { name: 'Ask Clerk' });
    expect(button).toHaveAttribute('data-variant', 'ai');
    expect(button).toHaveAttribute('data-size', 'sm');
    button.focus();
    await new Promise((r) => setTimeout(r, 450));
    expect(screen.queryByRole('tooltip')).toBeNull();
    button.blur();
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('renders data-disabled', async () => {
    await render(`<button mtIconButton icon="trash" label="Delete note" disabled></button>`, {
      imports: [MtIconButton],
    });
    expect(screen.getByRole('button', { name: 'Delete note' })).toHaveAttribute('data-disabled');
  });
});
