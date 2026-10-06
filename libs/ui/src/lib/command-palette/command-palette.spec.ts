import { render, screen, within } from '@testing-library/angular';
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

  it('opens in a new tab with mod+Enter, drills in with Tab and leaves the scope with Backspace (CORE-15)', async () => {
    const open = vi.fn();
    const drill = vi.fn();
    const back = vi.fn();
    const groups: MtCommandGroup[] = [
      {
        label: 'Matters',
        items: [{ id: 'm1', label: 'Estate of Margaret Whitfield', meta: 'M-2026-0142', mono: true, drill: true }],
      },
    ];
    await render(
      `<mt-command-palette [groups]="groups" [scope]="scope" (open)="open($event)" (drill)="drill($event)" (back)="back()" />`,
      { imports: [MtCommandPalette], componentProperties: { groups, open, drill, back, scope: 'M-2026-0142' } },
    );
    const input = screen.getByRole('combobox');
    input.focus();
    expect(screen.getByText('M-2026-0142', { selector: '.mono-s' })).toBeInTheDocument();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(open).toHaveBeenLastCalledWith({ item: expect.objectContaining({ id: 'm1' }), newTab: true });
    await userEvent.keyboard('{Enter}');
    expect(open).toHaveBeenLastCalledWith({ item: expect.objectContaining({ id: 'm1' }), newTab: false });
    await userEvent.keyboard('{Tab}');
    expect(drill).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
    expect(input).toHaveFocus();
    await userEvent.keyboard('{Backspace}');
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('shows a searching line per busy group and its note, and waits for them before "No matches"', async () => {
    const { rerender } = await render(`<mt-command-palette [groups]="groups" />`, {
      imports: [MtCommandPalette],
      componentProperties: { groups: [{ label: 'Matters', items: [], busy: true }] as MtCommandGroup[] },
    });
    expect(screen.getByRole('status')).toHaveTextContent('Searching matters…');
    expect(screen.queryByText(/No matches/)).toBeNull();
    await rerender({
      componentProperties: {
        groups: [
          { label: 'Matters', items: [{ id: 'm1', label: 'Estate of Example' }], note: 'Type more to narrow these.' },
        ],
      },
    });
    expect(screen.getByText('Type more to narrow these.')).toBeInTheDocument();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('keeps only options and groups of options in the listbox while groups search (axe: aria-required-children)', async () => {
    const { rerender } = await render(`<mt-command-palette [groups]="groups" />`, {
      imports: [MtCommandPalette],
      componentProperties: {
        groups: [
          { label: 'Matters', items: [{ id: 'm1', label: 'Estate of Margaret Wren' }] },
          { label: 'Documents', items: [], busy: true },
        ] as MtCommandGroup[],
      },
    });
    const list = screen.getByRole('listbox');
    expect(list).toHaveAttribute('aria-busy', 'true');
    expect(
      within(list)
        .getAllByRole('group')
        .map((g) => g.textContent),
    ).toEqual([expect.stringContaining('Estate of Margaret Wren')]);
    expect(within(list).getByText('Searching documents…')).toBeInTheDocument();
    expect(within(list).queryByRole('status')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Searching documents…');

    await rerender({ componentProperties: { groups: [] } });
    expect(list).not.toHaveAttribute('aria-busy');
    expect(list).toBeEmptyDOMElement();
    expect(list).not.toContainElement(screen.getByText(/No matches/));
  });
});
