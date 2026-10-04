import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { dateOnly } from '@materia/domain';

import { type MatterCardVm, MtMatterCard } from './matter-card';
import { MT_TODAY } from '../pipes/format';

// Fictional sample data, as in the design system.
const MATTER: MatterCardVm = {
  id: 'm1',
  ref: 'WE-142',
  title: 'Estate of Margaret Whitfield',
  client: 'Catherine Whitfield',
  type: 'probate',
  status: 'active',
  stage: 'Notice period',
  priority: 'urgent',
  nextDeadline: { due: dateOnly('2026-10-02') },
  people: [{ id: 'u1', name: 'Jordan Price' }],
  clerkHint: 'Notice can be published today',
};

describe('MtMatterCard', () => {
  const providers = [{ provide: MT_TODAY, useValue: () => dateOnly('2026-10-03') }];

  it('shows the number, title, client, tag, deadline, people and Clerk hint', async () => {
    const { container } = await render(MtMatterCard, { inputs: { matter: MATTER }, providers });
    expect(screen.getByRole('img', { name: 'Notice period' })).toBeInTheDocument();
    expect(container).toHaveTextContent('WE-142');
    expect(screen.getByRole('button', { name: MATTER.title })).toBeInTheDocument();
    expect(screen.getByText('Catherine Whitfield')).toHaveClass('client');
    expect(screen.getByText('Probate')).toBeInTheDocument();
    expect(container.querySelector('mt-deadline-chip')).toHaveAttribute('data-urgency', 'overdue');
    expect(screen.getByRole('img', { name: 'Urgent priority' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Jordan Price' })).toBeInTheDocument();
    expect(container).toHaveTextContent('Clerk: Notice can be published today');
  });

  it('opens from the title or a click on the card, but not from its other controls', async () => {
    const open = vi.fn();
    const { container } = await render(MtMatterCard, {
      inputs: {
        matter: {
          ...MATTER,
          priority: 'none',
          client: undefined,
          nextDeadline: null,
          people: [],
          clerkHint: undefined,
        },
      },
      providers,
      on: { open },
    });
    await userEvent.click(screen.getByRole('button', { name: MATTER.title }));
    expect(open).toHaveBeenCalledTimes(1);
    await userEvent.click(container.querySelector('.meta') as HTMLElement);
    expect(open).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('img', { name: /priority/ })).toBeNull();
  });
});
