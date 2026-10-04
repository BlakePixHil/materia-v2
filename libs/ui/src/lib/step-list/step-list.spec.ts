import { render, screen } from '@testing-library/angular';

import { MtStepList } from './step-list';

describe('MtStepList', () => {
  it('numbers steps, ticks completed ones and marks the current step', async () => {
    await render(MtStepList, {
      inputs: {
        label: 'Set up your firm',
        current: 'import',
        steps: [
          { id: 'firm', title: 'Your firm', description: 'Name, ABN, trust account' },
          { id: 'email', title: 'Email and calendar' },
          { id: 'import', title: 'Bring in your matters' },
          { id: 'team', title: 'Invite your team' },
        ],
      },
    });
    const items = screen.getAllByRole('listitem');
    expect(screen.getByRole('list', { name: 'Set up your firm' })).toBeInTheDocument();
    expect(items.map((i) => i.getAttribute('data-state'))).toEqual(['done', 'done', 'current', null]);
    expect(items[0]).toHaveTextContent(/Your firm\s*, complete/);
    expect(items[2]).toHaveAttribute('aria-current', 'step');
    expect(items[3]).toHaveTextContent('4');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('with interactive, makes completed steps buttons that emit stepSelect', async () => {
    const chosen: string[] = [];
    await render(MtStepList, {
      inputs: {
        interactive: true,
        current: 'details',
        completed: ['type', 'clients'],
        steps: [
          { id: 'type', title: 'Matter type' },
          { id: 'clients', title: 'Clients' },
          { id: 'details', title: 'Details' },
          { id: 'fees', title: 'Fees' },
        ],
      },
      on: { stepSelect: (step: { id: string }) => chosen.push(step.id) },
    });
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveTextContent(/Matter type\s*, complete/);
    buttons[1]?.click();
    expect(chosen).toEqual(['clients']);
  });
});
