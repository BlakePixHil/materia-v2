import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtSearchField } from './search-field';
import { MT_KEYBOARD_PLATFORM } from '../kbd/kbd';

describe('MtSearchField', () => {
  it('is a named searchbox with the shortcut hint and aria-keyshortcuts', async () => {
    await render(`<mt-search-field label="Search or jump to" variant="global" shortcut="mod+k" />`, {
      imports: [MtSearchField],
      providers: [{ provide: MT_KEYBOARD_PLATFORM, useValue: 'mac' }],
    });
    const box = screen.getByRole('searchbox', { name: 'Search or jump to' });
    expect(box).toHaveAttribute('aria-keyshortcuts', 'Meta+K');
    expect(box.closest('.mt-input')).toHaveClass('mt-search');
    expect([...document.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['⌘', 'K']);
  });

  it('emits the query after the debounce, and clears with the button or Escape', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const queryChange = vi.fn();
    await render(`<mt-search-field label="Filter matters" [debounce]="200" (queryChange)="queryChange($event)" />`, {
      imports: [MtSearchField],
      componentProperties: { queryChange },
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const box = screen.getByRole('searchbox');
    await user.type(box, 'whit');
    expect(queryChange).not.toHaveBeenCalledWith('whit');
    vi.advanceTimersByTime(200);
    expect(queryChange).toHaveBeenLastCalledWith('whit');
    expect(queryChange).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(box).toHaveValue('');
    expect(queryChange).toHaveBeenLastCalledWith('');
    expect(box).toHaveFocus();

    await user.type(box, 'hale');
    await user.keyboard('{Escape}');
    expect(box).toHaveValue('');
    vi.useRealTimers();
  });
});
