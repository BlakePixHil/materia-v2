import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtTooltip } from './tooltip';
import { MT_KEYBOARD_PLATFORM } from '../kbd/kbd';

describe('MtTooltip', () => {
  it('shows after 400ms on keyboard focus, with the shortcut, and links aria-describedby', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await render(`<button type="button" mtTooltip="Record time" mtTooltipKbd="t">Record</button>`, {
      imports: [MtTooltip],
      providers: [{ provide: MT_KEYBOARD_PLATFORM, useValue: 'mac' }],
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.tab();
    expect(screen.queryByRole('tooltip')).toBeNull();
    await vi.advanceTimersByTimeAsync(450);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveClass('mt-tooltip');
    expect(tip).toHaveTextContent('Record time');
    expect(tip.querySelector('kbd')).toHaveTextContent('T');
    expect(screen.getByRole('button').getAttribute('aria-describedby')).toContain(tip.id);
    vi.useRealTimers();
  });

  it('stays hidden when disabled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await render(`<button type="button" mtTooltip="Record time" mtTooltipDisabled>Record</button>`, {
      imports: [MtTooltip],
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.tab();
    await vi.advanceTimersByTimeAsync(600);
    expect(screen.queryByRole('tooltip')).toBeNull();
    vi.useRealTimers();
  });
});
