import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { type MtCommandGroup, MtCommandPalette } from './command-palette';

const GROUPS: MtCommandGroup[] = [
  {
    label: 'Matters',
    items: [
      { id: 'm1', label: 'Estate of Margaret Whitfield', meta: 'WE-142', icon: 'matters' },
      { id: 'p1', label: 'Catherine Whitfield', meta: '· Executor', icon: 'user' },
    ],
  },
  {
    label: 'Actions',
    items: [
      { id: 'a1', label: 'Record time on WE-142', icon: 'timer', kbd: 't' },
      { id: 'c1', label: 'Ask Clerk about “whitf”', icon: 'sparkle', tone: 'ai', kbd: 'mod+j' },
    ],
  },
];

describe('MtCommandPalette', () => {
  it('renders a combobox over grouped options with the first row active', async () => {
    await render(`<mt-command-palette [groups]="groups" />`, {
      imports: [MtCommandPalette],
      componentProperties: { groups: GROUPS },
    });
    const input = screen.getByRole('combobox', { name: 'Command palette' });
    const listbox = screen.getByRole('listbox');
    expect(input).toHaveAttribute('aria-controls', listbox.id);
    expect(screen.getByRole('group', { name: 'Matters' })).toBeInTheDocument();
    const first = screen.getByRole('option', { name: /Estate of Margaret Whitfield/ });
    expect(input).toHaveAttribute('aria-activedescendant', first.id);
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /Ask Clerk/ })).toHaveAttribute('data-tone', 'ai');
  });

  it('moves with arrows (wrapping) and Home/End, keeps focus in the input, and runs with Enter', async () => {
    const run = vi.fn();
    await render(`<mt-command-palette [groups]="groups" (run)="run($event)" />`, {
      imports: [MtCommandPalette],
      componentProperties: { groups: GROUPS, run },
    });
    const input = screen.getByRole('combobox');
    input.focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(input).toHaveFocus();
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /Record time/ }).id);
    await userEvent.keyboard('{End}');
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /Ask Clerk/ }).id);
    await userEvent.keyboard('{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /Margaret/ }).id);
    await userEvent.keyboard('{ArrowUp}{Home}{ArrowDown}{Enter}');
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  it('two-way binds the query and shows the empty state', async () => {
    const { rerender } = await render(`<mt-command-palette [groups]="groups" [(query)]="query" />`, {
      imports: [MtCommandPalette],
      componentProperties: { groups: GROUPS, query: '' },
    });
    await userEvent.type(screen.getByRole('combobox'), 'zz');
    await rerender({ componentProperties: { groups: [], query: 'zz' } });
    expect(screen.getByText(/No matches/)).toHaveClass('mt-cmdk-empty');
    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-activedescendant');
  });
});
